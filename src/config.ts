/**
 * Host configuration. This is the only sanctioned reader of `process.env`.
 *
 * Two rules hold everywhere below:
 *   - Executables are resolved from an explicit absolute path, never from PATH.
 *   - Only a fixed set of variable names is readable, and the environment is
 *     never returned wholesale to any caller.
 */
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Daml toolchain pinned by specs/001-security-agent-loop/plan.md. */
export const REQUIRED_DAML_SDK_VERSION = '3.5.5';
export const REQUIRED_DPM_CLI_VERSION = '1.0.21';

/**
 * Pinned model identifier. Not contacted anywhere in this phase; no model
 * client exists yet. The exact dated identifier MUST be confirmed against the
 * installed SDK before the first request is ever made.
 */
export const DEFAULT_MODEL_ID = 'claude-sonnet-4-5';

const DEFAULT_DPM_BIN = path.join(homedir(), '.dpm', 'bin', 'dpm');
const DEFAULT_GIT_BIN = '/usr/bin/git';

/** The only environment variable names this process will ever read. */
export type ReadableEnvName = 'DPM_BIN' | 'GIT_BIN' | 'SECURITY_LAB_MODEL';
export type EnvSource = Partial<Record<ReadableEnvName, string | undefined>>;

function readEnv(name: ReadableEnvName, source?: EnvSource): string | undefined {
  const raw = source ? source[name] : process.env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve an executable to a canonical absolute path.
 *
 * Rejects relative paths outright: a relative executable would be resolved
 * against the current working directory, which is exactly the ambient-lookup
 * behaviour Article II forbids.
 */
export function resolveExecutable(candidate: string, label: string): string {
  if (!path.isAbsolute(candidate)) {
    throw new ConfigError(
      `${label} must be an absolute path, received a relative path. PATH lookup is not permitted.`,
    );
  }

  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new ConfigError(`${label} was not found at ${candidate}.`);
  }

  const stat = fs.statSync(real);
  if (!stat.isFile()) {
    throw new ConfigError(`${label} at ${real} is not a regular file.`);
  }

  try {
    fs.accessSync(real, fs.constants.X_OK);
  } catch {
    throw new ConfigError(`${label} at ${real} is not executable.`);
  }

  return real;
}

/** Absolute path to the pinned `dpm` executable. `DPM_BIN` overrides the default. */
export function resolveDpmExecutable(source?: EnvSource): string {
  return resolveExecutable(
    readEnv('DPM_BIN', source) ?? DEFAULT_DPM_BIN,
    'dpm executable (DPM_BIN)',
  );
}

/** Absolute path to the `git` executable. `GIT_BIN` overrides the default. */
export function resolveGitExecutable(source?: EnvSource): string {
  return resolveExecutable(
    readEnv('GIT_BIN', source) ?? DEFAULT_GIT_BIN,
    'git executable (GIT_BIN)',
  );
}

/** Pinned model identifier, overridable by `SECURITY_LAB_MODEL`. */
export function resolveModelId(source?: EnvSource): string {
  return readEnv('SECURITY_LAB_MODEL', source) ?? DEFAULT_MODEL_ID;
}

/** Default execution budgets applied to every spawned process. */
export const EXEC_DEFAULTS = {
  timeoutMs: 120_000,
  maxOutputBytes: 4 * 1024 * 1024,
} as const;

/** Default bounds applied to model-facing repository reads. */
export const REPO_READ_DEFAULTS = {
  maxFileBytes: 256 * 1024,
  maxEntries: 2_000,
  maxSearchMatches: 200,
} as const;
