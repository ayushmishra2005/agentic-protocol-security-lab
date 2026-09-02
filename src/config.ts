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
export type ReadableEnvName = 'DPM_BIN' | 'GIT_BIN' | 'SECURITY_LAB_MODEL' | 'ANTHROPIC_API_KEY';
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

/**
 * The provider API credential, wrapped so it is not an ordinary string.
 *
 * Article V requires that credentials never reach prompts, artifacts, or logs.
 * A bare `string` makes that a discipline problem: it can be interpolated into
 * a template, spread into an evidence record, or printed by an error handler
 * that meant well. This class removes those accidents by construction.
 *
 * The key is a `#private` field, so it is unreachable from outside the class
 * even with a cast. `toString`, `toJSON` and Node's inspect hook all render
 * `[REDACTED]`, so string interpolation, `JSON.stringify` and `console.log`
 * cannot leak it. The only way out is `asApiKeySetter`, whose shape matches the
 * SDK's own `ApiKeySetter` and which is passed directly to the client
 * constructor and nowhere else.
 */
export class ProviderCredential {
  readonly #key: string;

  constructor(key: string) {
    if (key.trim().length === 0) {
      throw new ConfigError('Provider credential must not be empty.');
    }
    this.#key = key.trim();
  }

  /** Lazy accessor in the exact shape the SDK client accepts. */
  asApiKeySetter(): () => Promise<string> {
    const key = this.#key;
    return () => Promise.resolve(key);
  }

  toString(): string {
    return '[REDACTED]';
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'ProviderCredential([REDACTED])';
  }
}

/** True when a provider credential is configured. Never reveals its value. */
export function hasProviderCredential(source?: EnvSource): boolean {
  return readEnv('ANTHROPIC_API_KEY', source) !== undefined;
}

/**
 * Read the provider credential.
 *
 * This is the only function in the codebase that reads `ANTHROPIC_API_KEY`, and
 * it returns a wrapper rather than the value, so no caller can obtain a bare
 * credential string.
 */
export function resolveProviderCredential(source?: EnvSource): ProviderCredential {
  const raw = readEnv('ANTHROPIC_API_KEY', source);
  if (raw === undefined) {
    throw new ConfigError(
      'ANTHROPIC_API_KEY is not set. The host reads it only to construct the model client.',
    );
  }
  return new ProviderCredential(raw);
}

/**
 * Host-owned per-run budgets for the model loop.
 *
 * These are constants rather than parameters the model can influence. A caller
 * may lower them; nothing reachable from a model response can raise them.
 */
export const MODEL_LOOP_DEFAULTS = {
  /** Maximum provider responses per phase. */
  maxTurns: 12,
  /** Maximum tool invocations per phase. */
  maxToolCalls: 24,
  /** Maximum tool invocations honoured within a single assistant turn. */
  maxToolCallsPerTurn: 8,
  /** Provider transport retries, excluding the initial attempt. */
  maxProviderRetries: 3,
  /** Artifact validation attempts before a phase is marked degraded. */
  maxValidationAttempts: 3,
  /**
   * Maximum host-initiated revisions of a generated test per run. Small on
   * purpose: a test that is still wrong after two corrections is evidence about
   * the analysis, and spending more turns on it buys noise.
   */
  maxRevisions: 2,
  /** Per-request cap handed to the provider. */
  maxOutputTokens: 8_192,
  /** Provider request timeout. */
  requestTimeoutMs: 120_000,
} as const;

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
