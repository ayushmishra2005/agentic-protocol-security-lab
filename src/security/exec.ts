/**
 * The single sanctioned process boundary (Constitution Article II).
 *
 * Every spawn goes through this module. It never uses a shell, never accepts a
 * command string, and never accepts an executable name that must be looked up
 * on PATH. Callers supply a pre-registered command definition plus a
 * host-constructed argv; any flag outside the definition's allowlist is
 * rejected before the process is created, never sanitised and passed through.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { EXEC_DEFAULTS } from '../config.js';
import { redact } from './redact.js';

export class ExecSecurityError extends Error {
  override readonly name = 'ExecSecurityError';
}

export interface CommandDefinition {
  /** Stable identifier used in evidence records. */
  readonly id: string;
  /** Canonical absolute path to the executable. */
  readonly executable: string;
  /** Exact flag tokens this command may use, e.g. `--json`. */
  readonly allowedFlags: ReadonlySet<string>;
}

export interface ExecRequest {
  readonly definition: CommandDefinition;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ExecResult {
  readonly commandId: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/**
 * Environment variable names forwarded to child processes.
 *
 * Everything else is dropped. Credentials are never on this list, so a child
 * process cannot inherit them and cannot echo them back into captured output.
 */
const FORWARDED_ENV_NAMES = ['HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'JAVA_HOME'] as const;

/** Fixed PATH for children. The executable's own directory is prepended. */
const BASE_PATH_ENTRIES = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const;

function buildChildEnv(executable: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of FORWARDED_ENV_NAMES) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length > 0) {
      env[name] = value;
    }
  }
  env['PATH'] = [path.dirname(executable), ...BASE_PATH_ENTRIES].join(path.delimiter);
  return env;
}

/** Extract the flag name from a token, handling `--flag=value`. */
function flagNameOf(token: string): string {
  const equals = token.indexOf('=');
  return equals === -1 ? token : token.slice(0, equals);
}

function assertValidArgv(definition: CommandDefinition, argv: readonly string[]): void {
  for (const token of argv) {
    if (typeof token !== 'string') {
      throw new ExecSecurityError(`Non-string argv token for ${definition.id}.`);
    }
    if (token.includes('\0')) {
      throw new ExecSecurityError(`argv token contains a NUL byte for ${definition.id}.`);
    }
    if (!token.startsWith('-')) continue;

    const name = flagNameOf(token);
    if (!definition.allowedFlags.has(name)) {
      throw new ExecSecurityError(
        `Flag ${name} is not allowlisted for ${definition.id}. Rejected before execution.`,
      );
    }
  }
}

function assertValidCwd(cwd: string): void {
  if (!path.isAbsolute(cwd)) {
    throw new ExecSecurityError(`Working directory must be absolute, received ${cwd}.`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new ExecSecurityError(`Working directory does not exist: ${cwd}`);
  }
  if (!stat.isDirectory()) {
    throw new ExecSecurityError(`Working directory is not a directory: ${cwd}`);
  }
}

function assertValidExecutable(definition: CommandDefinition): void {
  if (!path.isAbsolute(definition.executable)) {
    throw new ExecSecurityError(
      `Executable for ${definition.id} must be an absolute path. PATH lookup is not permitted.`,
    );
  }
  if (!fs.existsSync(definition.executable)) {
    throw new ExecSecurityError(`Executable for ${definition.id} does not exist.`);
  }
}

/** Bounded, redacting collector for a child stream. */
class BoundedCapture {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private truncatedFlag = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.size >= this.limit) {
      this.truncatedFlag = true;
      return;
    }
    const remaining = this.limit - this.size;
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size = this.limit;
      this.truncatedFlag = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  get truncated(): boolean {
    return this.truncatedFlag;
  }

  /** Redaction happens here, so no unredacted text ever leaves this module. */
  text(): string {
    return redact(Buffer.concat(this.chunks).toString('utf8'));
  }
}

/**
 * Run an allowlisted command.
 *
 * Rejects before spawn on: relative or missing executable, non-allowlisted
 * flag, NUL bytes, or an invalid working directory.
 */
export async function execute(request: ExecRequest): Promise<ExecResult> {
  const { definition, argv, cwd } = request;
  const timeoutMs = request.timeoutMs ?? EXEC_DEFAULTS.timeoutMs;
  const maxOutputBytes = request.maxOutputBytes ?? EXEC_DEFAULTS.maxOutputBytes;

  assertValidExecutable(definition);
  assertValidArgv(definition, argv);
  assertValidCwd(cwd);

  const startedAt = Date.now();

  return await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(definition.executable, [...argv], {
      cwd,
      env: buildChildEnv(definition.executable),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdout = new BoundedCapture(maxOutputBytes);
    const stderr = new BoundedCapture(maxOutputBytes);
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ExecSecurityError(`Failed to start ${definition.id}: ${error.message}`));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        commandId: definition.id,
        executable: definition.executable,
        argv: [...argv],
        cwd,
        exitCode: code,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
