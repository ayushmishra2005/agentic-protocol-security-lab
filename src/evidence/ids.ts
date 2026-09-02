/**
 * Evidence identifier allocation (Constitution Article I).
 *
 * Identifiers are allocated by the host and only by the host. Nothing in this
 * module accepts a caller-proposed identifier, so a model cannot name the
 * record its own invocation will be written to, and cannot aim a write at a
 * record that already exists.
 *
 * An identifier is a function of the run and a monotonic sequence number, so
 * the same run replayed in the same order allocates the same identifiers. That
 * makes a recorded run diffable against a re-run, which a random identifier
 * would not be.
 */
import { createHash } from 'node:crypto';

import { EvidenceIdSchema } from '../schemas/findings.js';

export class EvidenceIdError extends Error {
  override readonly name = 'EvidenceIdError';
}

/**
 * Run identifiers become a path segment under `runs/`, so the character set is
 * restricted here rather than at the filesystem boundary. `.` and `..` are
 * excluded by requiring at least one alphanumeric character.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertValidRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new EvidenceIdError(
      `Invalid run id: ${JSON.stringify(runId)}. Expected 1-64 characters of [A-Za-z0-9._-] starting with an alphanumeric.`,
    );
  }
}

/** Upper bound on invocations per run. Exhausting it is a bug, not a budget. */
export const MAX_EVIDENCE_PER_RUN = 100_000;

/**
 * Derive the identifier for a given position in a run.
 *
 * The hash-derived format keeps evidence identifiers independent of the
 * presentation of the internal sequence counter, so the counter can change
 * without changing the identifier format the schemas accept.
 *
 * Evidence identifiers are identifiers, not secrets and not authorization
 * tokens. Anyone holding the run id and this function can derive every
 * identifier in the run, and that is fine: correctness here rests on
 * host-controlled allocation and unique resolution, never on unpredictability.
 * Nothing downstream may treat possession of an identifier as permission.
 */
export function evidenceIdFor(runId: string, sequence: number): string {
  assertValidRunId(runId);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new EvidenceIdError(`Evidence sequence must be a non-negative integer, got ${sequence}.`);
  }

  const digest = createHash('sha256')
    .update(`${runId}\u0000${String(sequence)}`)
    .digest('hex');
  const id = `ev_${digest.slice(0, 16)}`;

  // The schema is the contract the report and finding schemas validate against.
  // Deriving an identifier that fails it would be a silent divergence.
  return EvidenceIdSchema.parse(id);
}

/**
 * Sequential allocator for one run.
 *
 * Deliberately has no method to set, reset, or rewind the counter: an allocator
 * that could be rewound would hand out an identifier that already names a
 * persisted record.
 */
export class EvidenceIdAllocator {
  readonly runId: string;
  #next = 0;

  constructor(runId: string) {
    assertValidRunId(runId);
    this.runId = runId;
  }

  /** Number of identifiers allocated so far. */
  get allocatedCount(): number {
    return this.#next;
  }

  next(): string {
    if (this.#next >= MAX_EVIDENCE_PER_RUN) {
      throw new EvidenceIdError(
        `Run ${this.runId} exhausted its evidence identifier budget of ${String(MAX_EVIDENCE_PER_RUN)}.`,
      );
    }
    const id = evidenceIdFor(this.runId, this.#next);
    this.#next += 1;
    return id;
  }
}
