/**
 * The deterministic scorer (Constitution Article IV).
 *
 * Host-owned and unreachable from model code paths: nothing under `src/agent/`,
 * `src/model/` or `src/tools/` imports this module, which `evalIsolation.test.ts`
 * asserts structurally rather than by convention. The model never sees an
 * expectation, never sees a score, and cannot write a scorecard.
 *
 * Determinism is a property this module is expected to have and is tested for:
 * given the same expectations and reports, `scoreFixture` and `buildScorecard`
 * produce byte-identical output. Everything that legitimately varies between two
 * runs of the same inputs — the timestamp — is supplied by the caller rather than
 * read here, so there is no clock, no filesystem, and no randomness in scoring.
 */
import { computeMetrics, type FixtureMetrics } from './metrics.js';
import type { Expected } from '../schemas/expected.js';
import type { Report } from '../schemas/report.js';
import {
  SCORE_DIMENSIONS,
  SCORECARD_NOTE,
  ScorecardSchema,
  type Aggregate,
  type DimensionResult,
  type DimensionStatus,
  type FixtureScore,
  type Provenance,
  type ScoreDimension,
  type Scorecard,
} from '../schemas/scorecard.js';
import type { Toolchain } from '../schemas/report.js';

export interface ScoreInput {
  readonly expected: Expected;
  readonly report: Report;
}

function result(
  dimension: ScoreDimension,
  status: DimensionStatus,
  detail: string,
  evidenceIds: readonly string[] = [],
): DimensionResult {
  return { dimension, status, detail, evidenceIds: [...evidenceIds] };
}

function verdict(passed: boolean): DimensionStatus {
  return passed ? 'pass' : 'fail';
}

/**
 * Turn metrics into the fixed dimension list.
 *
 * The order matches `SCORE_DIMENSIONS` so two scorecards can be compared
 * directly, and every dimension is always present: a dimension that silently
 * disappeared when it failed would make a partial run look complete.
 */
function dimensionsFor(expected: Expected, metrics: FixtureMetrics): DimensionResult[] {
  const testExpectations = expected.generatedTestExpectations;

  return [
    result(
      'expected_finding_detected',
      verdict(metrics.expectedFindingDetected),
      metrics.expectedFindingDetected
        ? 'A finding matched an expected class and cited every construct the expectation requires.'
        : 'No finding matched an expected class with the required template and choice.',
      metrics.findingEvidenceIds,
    ),
    result(
      'expected_finding_confirmed',
      verdict(metrics.expectedFindingConfirmed),
      metrics.expectedFindingConfirmed
        ? 'The matched finding was confirmed by the host confirmation gate.'
        : 'No matched finding reached the confirmed state, so no confirmation credit is given.',
      metrics.expectedFindingConfirmed ? metrics.findingEvidenceIds : [],
    ),
    result(
      'expected_invariant_generated',
      verdict(metrics.expectedInvariantGenerated),
      metrics.expectedInvariantGenerated
        ? 'An invariant of the expected class was produced.'
        : 'No invariant of the expected class was produced.',
    ),
    result(
      'test_generated',
      verdict(metrics.testGenerated),
      metrics.testGenerated
        ? 'At least one adversarial Script was generated.'
        : 'No adversarial Script was generated.',
    ),
    result(
      'test_compiled',
      testExpectations.mustCompile ? verdict(metrics.testCompiled) : 'not_applicable',
      testExpectations.mustCompile
        ? metrics.testCompiled
          ? 'A generated Script compiled on the pinned toolchain.'
          : 'No generated Script compiled on the pinned toolchain.'
        : 'This fixture does not require a generated Script to compile.',
    ),
    result(
      // Only scored where the fixture's expectation says runtime behaviour is
      // observable for it. F02 qualifies because its oracle empirically
      // established that a Script query is stakeholder-filtered; that finding is
      // about Script projection and is not extended to participant storage,
      // transmission, or explicit disclosure.
      'expected_behavior_exposed',
      testExpectations.mustExposeExpectedBehavior
        ? verdict(metrics.expectedBehaviorExposed)
        : 'not_applicable',
      testExpectations.mustExposeExpectedBehavior
        ? metrics.expectedBehaviorExposed
          ? 'A generated Script executed and produced the outcome it declared before running.'
          : 'No generated Script executed and produced its pre-declared outcome.'
        : 'This fixture is scored on finding and invariant only; runtime behaviour is not scored.',
      metrics.expectedBehaviorExposed ? metrics.executionEvidenceIds : [],
    ),
  ];
}

/** Score one fixture. Pure: same inputs, same output, always. */
export function scoreFixture(input: ScoreInput): FixtureScore {
  const metrics = computeMetrics(input.expected, input.report);

  return {
    fixtureId: input.expected.fixtureId,
    runId: input.report.runId,
    dimensions: dimensionsFor(input.expected, metrics),
    unsupportedClaims: metrics.unsupportedClaims,
    falsePositives: metrics.falsePositives,
    degradedPhases: [...input.report.degradedPhases],
  };
}

function emptyCounts(): Record<ScoreDimension, number> {
  return Object.fromEntries(SCORE_DIMENSIONS.map((name) => [name, 0])) as Record<
    ScoreDimension,
    number
  >;
}

export function aggregate(results: readonly FixtureScore[]): Aggregate {
  const passed = emptyCounts();
  const failed = emptyCounts();
  const notApplicable = emptyCounts();

  for (const fixture of results) {
    for (const dimension of fixture.dimensions) {
      const bucket =
        dimension.status === 'pass' ? passed : dimension.status === 'fail' ? failed : notApplicable;
      bucket[dimension.dimension] += 1;
    }
  }

  return {
    fixtures: results.length,
    passed,
    failed,
    notApplicable,
    unsupportedClaims: results.reduce((total, fixture) => total + fixture.unsupportedClaims, 0),
    falsePositives: results.reduce((total, fixture) => total + fixture.falsePositives, 0),
  };
}

export interface BuildScorecardInput {
  readonly inputs: readonly ScoreInput[];
  readonly toolchain: Toolchain;
  readonly modelId: string;
  readonly provenance: Provenance;
  /** Supplied, not read from a clock, so scoring itself stays pure. */
  readonly generatedAt: Date;
}

/**
 * Assemble the scorecard.
 *
 * Fixtures are sorted by identifier rather than left in call order, so the same
 * set of results scores identically however the runner happened to iterate.
 */
export function buildScorecard(input: BuildScorecardInput): Scorecard {
  const results = input.inputs
    .map((entry) => scoreFixture(entry))
    .sort((left, right) => left.fixtureId.localeCompare(right.fixtureId));

  return ScorecardSchema.parse({
    schemaVersion: 1,
    generatedAt: input.generatedAt.toISOString(),
    toolchain: input.toolchain,
    model: { id: input.modelId },
    provenance: input.provenance,
    note: SCORECARD_NOTE,
    results,
    aggregate: aggregate(results),
  });
}
