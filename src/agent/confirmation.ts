/**
 * The confirmation gate (T065).
 *
 * `confirmed` is the strongest thing this system says, and it is the one state
 * a model must not be able to reach by sounding certain. The schema already
 * makes a confirmed finding without evidence unrepresentable; this module adds
 * the part a schema cannot express, which is what that evidence has to show.
 *
 * The rule, from FR-021 and the spec's edge cases:
 *
 *   A conclusion may be confirmed only if a generated test that supports it
 *   compiled, ran, and produced the outcome it declared it would produce
 *   before it ran.
 *
 * Each clause is doing work. A test that never compiled establishes nothing
 * about the target, only about itself — the spec is explicit that conclusions
 * whose tests never compile within the revision budget stay unconfirmed.
 * Compiling is also not enough on its own: it proves the Script is well-typed,
 * which is a statement about the Script. And a test whose result contradicted
 * its own prediction has demonstrated that the reasoning behind it was wrong
 * about the target, so it is the last thing that should promote a conclusion
 * drawn from that reasoning.
 *
 * Findings that do not clear the gate are not discarded. They are downgraded to
 * `unconfirmed`, keeping their evidence, because "we looked and could not
 * establish this" is a real result and deleting it would make the report less
 * honest, not more.
 */
import type { Finding } from '../schemas/findings.js';
import type { ExecuteArtifact, TestOutcome } from '../schemas/phases.js';

/** Outcomes that can support a confirmed conclusion. Exactly one qualifies. */
const CONFIRMING_OUTCOMES: ReadonlySet<TestOutcome> = new Set<TestOutcome>(['executed_expected']);

export interface SupportedFinding {
  readonly finding: Finding;
  /** Generated tests offered as support, by test id. */
  readonly supportingTestIds: readonly string[];
}

export interface ConfirmationDecision {
  readonly finding: Finding;
  /** True when the finding was downgraded from confirmed. */
  readonly downgraded: boolean;
  /** Why, when downgraded. Suitable for the report. */
  readonly reason?: string;
}

/**
 * True when at least one supporting test compiled, ran, and matched its
 * pre-declared expectation.
 */
export function hasConfirmingExecution(
  execution: ExecuteArtifact,
  supportingTestIds: readonly string[],
): boolean {
  if (supportingTestIds.length === 0) return false;

  const supported = new Set(supportingTestIds);
  return execution.results.some(
    (result) =>
      supported.has(result.testId) &&
      result.compiled &&
      CONFIRMING_OUTCOMES.has(result.outcome) &&
      result.passed !== undefined,
  );
}

/**
 * Apply the gate to one finding.
 *
 * Only `confirmed` is gated. An unconfirmed or refuted finding is already
 * making a weaker claim, and nothing here strengthens a claim.
 */
export function applyConfirmationGate(
  execution: ExecuteArtifact,
  candidate: SupportedFinding,
): ConfirmationDecision {
  const { finding, supportingTestIds } = candidate;

  if (finding.state !== 'confirmed') return { finding, downgraded: false };
  if (hasConfirmingExecution(execution, supportingTestIds)) {
    return { finding, downgraded: false };
  }

  const supported = new Set(supportingTestIds);
  const relevant = execution.results.filter((result) => supported.has(result.testId));

  const reason =
    relevant.length === 0
      ? 'No generated test was executed in support of this finding.'
      : relevant.every((result) => !result.compiled)
        ? 'The supporting generated test never compiled, so it established nothing about the target.'
        : relevant.some((result) => result.outcome === 'executed_contradiction')
          ? 'The supporting test ran but contradicted the expectation it declared beforehand.'
          : 'No supporting test both ran and matched its pre-declared expectation.';

  return {
    // Downgraded rather than dropped: the evidence is still worth reporting,
    // it just does not support the stronger claim.
    finding: { ...finding, state: 'unconfirmed' },
    downgraded: true,
    reason,
  };
}

/** Apply the gate across a report's findings. */
export function gateFindings(
  execution: ExecuteArtifact,
  candidates: readonly SupportedFinding[],
): readonly ConfirmationDecision[] {
  return candidates.map((candidate) => applyConfirmationGate(execution, candidate));
}
