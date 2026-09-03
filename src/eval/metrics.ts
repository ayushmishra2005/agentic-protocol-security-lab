/**
 * Per-fixture metrics (Constitution Article IV).
 *
 * Every function here is a pure comparison between a host-owned `expected.json`
 * and a host-assembled `report.json`. Matching is mechanical — class and
 * identifier equality — because the alternative, scoring by similarity or by
 * asking a model whether an answer is close enough, would make the benchmark
 * grade itself with the same faculty it is trying to measure.
 *
 * Identifiers cut both ways. A finding's own `id` is model-chosen and cannot be
 * matched against the benchmark's, since the model never sees the expectation;
 * what is matched is the vulnerability class plus, where the expectation demands
 * it, the Daml template and choice named. That is the part the model could only
 * get right by actually reading the source.
 */
import type { Expected, ExpectedFinding } from '../schemas/expected.js';
import type { Finding, Invariant } from '../schemas/findings.js';
import type { GeneratedTestResult, Report } from '../schemas/report.js';

export interface FixtureMetrics {
  /** A finding of the expected class citing whatever the expectation requires. */
  readonly expectedFindingDetected: boolean;
  /**
   * That same finding earned `confirmed` from the host's confirmation gate.
   * Detection without confirmation is a real, weaker result and is reported as
   * such rather than rounded up.
   */
  readonly expectedFindingConfirmed: boolean;
  readonly expectedInvariantGenerated: boolean;
  readonly testGenerated: boolean;
  readonly testCompiled: boolean;
  /** A generated test ran and produced the outcome it declared beforehand. */
  readonly expectedBehaviorExposed: boolean;
  /** Findings citing no evidence at all. */
  readonly unsupportedClaims: number;
  /** Findings of a class neither expected nor explicitly allowed. */
  readonly falsePositives: number;
  /** Evidence cited by the matched finding, deduplicated and ordered. */
  readonly findingEvidenceIds: readonly string[];
  /** Evidence from generated tests that compiled and ran. */
  readonly executionEvidenceIds: readonly string[];
}

/** Does one finding satisfy one expectation? */
function matches(finding: Finding, expectation: ExpectedFinding): boolean {
  if (finding.class !== expectation.class) return false;
  if (
    expectation.mustCiteTemplate !== undefined &&
    finding.template !== expectation.mustCiteTemplate
  ) {
    return false;
  }
  if (expectation.mustCiteChoice !== undefined && finding.choice !== expectation.mustCiteChoice) {
    return false;
  }
  return true;
}

/**
 * Findings satisfying any expectation, in report order.
 *
 * A fixture may list several expectations; a report satisfying one of them has
 * detected something the benchmark asked for.
 */
function matchedFindings(expected: Expected, report: Report): readonly Finding[] {
  return report.findings.filter((finding) =>
    expected.expectedFindings.some((expectation) => matches(finding, expectation)),
  );
}

/**
 * Invariants are matched on class alone.
 *
 * The benchmark's invariant identifiers are host-owned and never shown to the
 * model, so requiring identifier equality would ask the model to guess a private
 * string. Class equality is what can be judged mechanically without leaking the
 * answer, and the invariant's own statement is left to human review.
 */
function invariantMatches(invariant: Invariant, expected: Expected): boolean {
  return expected.expectedInvariants.some((expectation) => expectation.class === invariant.class);
}

function isAcceptableClass(finding: Finding, expected: Expected): boolean {
  return (
    expected.expectedFindings.some((expectation) => expectation.class === finding.class) ||
    expected.allowedExtraClasses.includes(finding.class)
  );
}

/** Tests that compiled, ran, and matched their pre-declared outcome. */
function exposingTests(report: Report): readonly GeneratedTestResult[] {
  return report.generatedTests.filter((test) => test.outcome === 'executed_expected');
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

export function computeMetrics(expected: Expected, report: Report): FixtureMetrics {
  const matched = matchedFindings(expected, report);
  const confirmed = matched.filter((finding) => finding.state === 'confirmed');

  const compiledTests = report.generatedTests.filter((test) => test.compiled);
  const exposed = exposingTests(report);

  return {
    expectedFindingDetected: matched.length > 0,
    // Only a confirmed finding counts. The confirmation gate already refuses to
    // promote a finding whose supporting test never compiled or never produced
    // what it declared, so this reads that decision rather than second-guessing.
    expectedFindingConfirmed: confirmed.length > 0,
    expectedInvariantGenerated: report.invariants.some((invariant) =>
      invariantMatches(invariant, expected),
    ),
    testGenerated: report.generatedTests.length > 0,
    testCompiled: compiledTests.length > 0,
    expectedBehaviorExposed: exposed.length > 0,
    unsupportedClaims: report.findings.filter((finding) => finding.evidence.length === 0).length,
    falsePositives: report.findings.filter((finding) => !isAcceptableClass(finding, expected))
      .length,
    findingEvidenceIds: sortedUnique(
      matched.flatMap((finding) => finding.evidence.map((reference) => reference.evidenceId)),
    ),
    executionEvidenceIds: sortedUnique(
      exposed.flatMap((test) =>
        test.evidenceId === undefined
          ? [test.compileEvidenceId]
          : [test.compileEvidenceId, test.evidenceId],
      ),
    ),
  };
}
