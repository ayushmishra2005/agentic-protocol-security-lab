/**
 * The append-only evidence store (Constitution Articles I, IV and V).
 *
 * Article I says a conclusion must trace back to an executed tool. This module
 * is what such a reference resolves to. Each record carries the argv, working
 * directory, exit code and output digests Article IV requires, so a reader with
 * the repository and the pinned toolchain can re-derive the result rather than
 * take the report's word for it.
 *
 * Three properties are enforced structurally rather than by convention:
 *
 *   - Append-only. There is no update, overwrite, delete or truncate method on
 *     the public surface. An identifier, once written, keeps resolving to the
 *     bytes that were written under it.
 *   - Redacted before persistence. Redaction runs on the way in, not on the way
 *     out, so a credential is never written to disk and then cleaned up later.
 *   - Host-owned. Identifiers come from the allocator, never from a caller, so
 *     no model-supplied value can select the record a write lands on.
 *
 * Storage is newline-delimited JSON under the run directory. That is the
 * simplest representation that is append-only at the filesystem level and still
 * greppable during review; the plan calls for no database.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ExecResult } from '../security/exec.js';
import { isSecretKeyName, redact, REDACTED } from '../security/redact.js';
import { assertValidRunId, EvidenceIdAllocator } from './ids.js';

export class EvidenceError extends Error {
  // Widened to `string` so subclasses can narrow it to their own literal.
  override readonly name: string = 'EvidenceError';
}

/** Thrown when an identifier does not resolve. Never returns undefined instead. */
export class UnknownEvidenceError extends EvidenceError {
  override readonly name = 'UnknownEvidenceError';
  constructor(evidenceId: string) {
    super(`No evidence record for ${evidenceId}.`);
  }
}

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Outcome of the attempt, not of the analysis. */
export type EvidenceOutcome = 'ok' | 'error';

/** Process detail, present only when a process was actually spawned. */
export interface EvidenceProcess {
  readonly commandId: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  /**
   * Digests cover the redacted text as persisted, which is what a reader can
   * actually check. Digesting the pre-redaction text would also hand anyone
   * holding the report an offline oracle for the secret it removed.
   */
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
}

export interface EvidenceRecord {
  readonly evidenceId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly toolName: string;
  readonly outcome: EvidenceOutcome;
  /** Caller-supplied parameters, redacted. Never the argv the host built from them. */
  readonly parameters: JsonValue;
  readonly process?: EvidenceProcess;
  /** Structured result for tools that read the filesystem without spawning. */
  readonly result?: JsonValue;
  readonly resultSha256?: string;
  /** Present when the attempt was refused or failed. */
  readonly error?: { readonly name: string; readonly message: string };
}

export interface AppendEvidenceInput {
  readonly toolName: string;
  readonly outcome: EvidenceOutcome;
  readonly parameters: JsonValue;
  readonly exec?: ExecResult;
  readonly result?: JsonValue;
  readonly error?: { readonly name: string; readonly message: string };
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Redact every string reachable in a JSON value.
 *
 * Two passes are needed. Credential-shaped strings are caught by their own
 * shape, and values sitting under a credential-shaped field name are caught by
 * the name: in structured data `{"password": "hunter2"}` has nothing
 * credential-shaped in it, because the name and the value are separate strings.
 * `forced` carries the second case down through nested containers, so a secret
 * cannot be hidden one level below a suspicious key.
 *
 * Rebuilding the structure also detaches it from the caller's object, so a
 * caller that keeps mutating what it passed in cannot alter what was recorded.
 */
function redactJson(value: JsonValue, forced = false): JsonValue {
  if (typeof value === 'string') return forced ? REDACTED : redact(value);
  // `Array.isArray` widens a readonly array to `any[]`, so the element type is
  // restated here rather than inferred.
  if (Array.isArray(value)) {
    return (value as readonly JsonValue[]).map((entry) => redactJson(entry, forced));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, JsonValue>)) {
      // The key is redacted too: a key that is itself credential material, such
      // as an API key used as a field name, would otherwise persist.
      out[redact(key)] = redactJson(entry, forced || isSecretKeyName(key));
    }
    return out;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

function toEvidenceProcess(exec: ExecResult): EvidenceProcess {
  // `execute` already redacts on capture; redacting again is idempotent and
  // keeps this module correct on its own terms rather than on a caller's.
  const stdout = redact(exec.stdout);
  const stderr = redact(exec.stderr);
  return {
    commandId: exec.commandId,
    executable: exec.executable,
    argv: [...exec.argv],
    cwd: exec.cwd,
    exitCode: exec.exitCode,
    signal: exec.signal,
    timedOut: exec.timedOut,
    durationMs: exec.durationMs,
    stdout,
    stderr,
    stdoutTruncated: exec.stdoutTruncated,
    stderrTruncated: exec.stderrTruncated,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
  };
}

export interface EvidenceStoreOptions {
  readonly runId: string;
  /** Directory holding per-run output. Created if absent. */
  readonly runsRoot: string;
  /** Injectable clock, so tests do not depend on wall time. */
  readonly now?: () => Date;
}

/**
 * One store per run.
 *
 * The in-memory index and the file are written together in `append`, so a
 * resolvable identifier always corresponds to a persisted line.
 */
export class EvidenceStore {
  readonly runId: string;
  readonly filePath: string;

  readonly #allocator: EvidenceIdAllocator;
  readonly #index = new Map<string, EvidenceRecord>();
  readonly #now: () => Date;

  constructor(options: EvidenceStoreOptions) {
    assertValidRunId(options.runId);
    if (!path.isAbsolute(options.runsRoot)) {
      throw new EvidenceError(`runsRoot must be an absolute path, received ${options.runsRoot}.`);
    }

    this.runId = options.runId;
    this.#allocator = new EvidenceIdAllocator(options.runId);
    this.#now = options.now ?? (() => new Date());

    const runDir = path.join(options.runsRoot, options.runId);
    fs.mkdirSync(runDir, { recursive: true });
    this.filePath = path.join(runDir, 'evidence.jsonl');
  }

  /** Number of records appended by this store instance. */
  get count(): number {
    return this.#index.size;
  }

  /** Identifiers in allocation order. */
  ids(): readonly string[] {
    return [...this.#index.keys()];
  }

  /**
   * Append one record and return it.
   *
   * This is the only writer. It allocates its own identifier, redacts before
   * writing, and refuses to reuse an identifier that is already present.
   */
  append(input: AppendEvidenceInput): EvidenceRecord {
    if (input.outcome === 'error' && input.error === undefined) {
      throw new EvidenceError(
        `Evidence for ${input.toolName} is marked as an error but carries no error detail.`,
      );
    }
    if (input.outcome === 'ok' && input.error !== undefined) {
      throw new EvidenceError(
        `Evidence for ${input.toolName} is marked as ok but carries error detail.`,
      );
    }

    const sequence = this.#allocator.allocatedCount;
    const evidenceId = this.#allocator.next();
    if (this.#index.has(evidenceId)) {
      // Unreachable while the allocator is monotonic. Kept because the cost of
      // being wrong here is an overwritten record.
      throw new EvidenceError(`Refusing to reuse evidence id ${evidenceId}.`);
    }

    const record: EvidenceRecord = {
      evidenceId,
      runId: this.runId,
      sequence,
      recordedAt: this.#now().toISOString(),
      toolName: input.toolName,
      outcome: input.outcome,
      parameters: redactJson(input.parameters),
      ...(input.exec === undefined ? {} : { process: toEvidenceProcess(input.exec) }),
      ...(input.result === undefined
        ? {}
        : (() => {
            const result = redactJson(input.result);
            return { result, resultSha256: sha256(JSON.stringify(result)) };
          })()),
      ...(input.error === undefined
        ? {}
        : {
            error: { name: redact(input.error.name), message: redact(input.error.message) },
          }),
    };

    deepFreeze(record);

    // Written before the index is updated: an identifier that resolves in
    // memory is therefore never one that failed to reach disk.
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    this.#index.set(evidenceId, record);

    return record;
  }

  /** True when the identifier resolves. */
  has(evidenceId: string): boolean {
    return this.#index.has(evidenceId);
  }

  /**
   * Resolve an identifier, or throw.
   *
   * Deliberately not `undefined`-returning: an unresolvable reference in a
   * report is a correctness failure and must not be silently skippable.
   */
  get(evidenceId: string): EvidenceRecord {
    const record = this.#index.get(evidenceId);
    if (record === undefined) throw new UnknownEvidenceError(evidenceId);
    return record;
  }

  /** Records in allocation order. */
  all(): readonly EvidenceRecord[] {
    return [...this.#index.values()];
  }
}

/** Read back a persisted evidence file. Host-side review and tests only. */
export function readEvidenceFile(filePath: string): readonly EvidenceRecord[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EvidenceRecord);
}
