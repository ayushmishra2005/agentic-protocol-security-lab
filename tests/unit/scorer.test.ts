// The scorer is the component with the strongest incentive to be wrong in a
// flattering direction, so these tests are written mostly as negatives: a wrong
// class must fail, a missing invariant must fail, and a finding the host never
// confirmed must not collect confirmation credit.
//
// Reports here are hand-built fixtures. They exercise scoring arithmetic and say
// nothing about any model.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeMetrics } from '../../src/eval/metrics.js';
import { aggregate, buildScorecard, scoreFixture } from '../../src/eval/scorer.js';
import type { Expected } from '../../src/schemas/expected.js';
import type { Finding, Invariant } from '../../src/schemas/findings.js';
import {
  BOUNDARY_STATEMENT,
  SCOPE_LIMITATIONS,
  VERIFICATION_NOTE,
  type GeneratedTestResult,
  type Report,
} from '../../src/schemas/report.js';
import {
  SCORE_DIMENSIONS,
  ScorecardSchema,
  type DimensionStatus,
  type ScoreDimension,
} from '../../src/schemas/scorecard.js';

const EXPECTED: Expected = {
  schemaVersion: 1,
  fixtureId: 'f01-wrong-controller',
  damlSdkVersion: '3.5.5',
  description: 'Transfer names the custodian as controller instead of the owner.',
  expectedFindings: [
    {
      id: 'f01-transfer-wrong-controller',
      class: 'incorrect_controller',
      mustCiteTemplate: 'Asset',
      mustCiteChoice: 'Transfer',
    },
  ],
  expectedInvariants: [{ id: 'f01-only-owner-transfers', class: 'incorrect_controller' }],
  allowedExtraClasses: [],
  generatedTestExpectations: { mustCompile: true, mustExposeExpectedBehavior: true },
  oracleScript: 'Oracle:oracle',
};

const CONFIRMED_FINDING: Finding = {
  id: 'model-chosen-id',
  class: 'incorrect_controller',
  title: 'Transfer is controlled by the custodian',
  detail: 'The custodian can reassign ownership without the owner.',
  template: 'Asset',
  choice: 'Transfer',
  severity: 'high',
  state: 'confirmed',
  evidence: [{ evidenceId: 'ev_3' }, { evidenceId: 'ev_1' }],
};

const INVARIANT: Invariant = {
  id: 'model-invariant',
  class: 'incorrect_controller',
  statement: 'Only the current owner may transfer an Asset.',
  template: 'Asset',
  choice: 'Transfer',
  evidence: [{ evidenceId: 'ev_1' }],
};

const PASSING_TEST: GeneratedTestResult = {
  id: 'gen-1',
  scenarioId: 'scenario-1',
  relativePath: 'generated/Exploit.daml',
  attempt: 1,
  expectedOutcome: 'script_passes',
  outcome: 'executed_expected',
  compiled: true,
  passed: true,
  compileEvidenceId: 'ev_10',
  evidenceId: 'ev_11',
};

function report(overrides: Partial<Report> = {}): Report {
  return {
    schemaVersion: 1,
    runId: 'run_1',
    target: { relativePath: 'f01-wrong-controller' },
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:05:00.000Z',
    toolchain: { damlSdkVersion: '3.5.5', dpmVersion: '1.0.21' },
    model: { id: 'pinned-model' },
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      modelCalls: 2,
      toolInvocations: 3,
      toolInvocationsRefused: 0,
    },
    findings: [CONFIRMED_FINDING],
    invariants: [INVARIANT],
    generatedTests: [PASSING_TEST],
    degradedPhases: [],
    summary: 'Host-composed summary.',
    verification: { note: VERIFICATION_NOTE, scopeLimitations: [...SCOPE_LIMITATIONS] },
    boundaryStatement: BOUNDARY_STATEMENT,
    ...overrides,
  };
}

function statusOf(
  scored: ReturnType<typeof scoreFixture>,
  dimension: ScoreDimension,
): DimensionStatus {
  const found = scored.dimensions.find((entry) => entry.dimension === dimension);
  assert.ok(found !== undefined, `${dimension} missing from the scorecard`);
  return found.status;
}

describe('scorer matches mechanically against host-owned expectations', () => {
  it('scores a fully successful run as passing every dimension', () => {
    const scored = scoreFixture({ expected: EXPECTED, report: report() });

    for (const dimension of SCORE_DIMENSIONS) {
      assert.equal(statusOf(scored, dimension), 'pass', `${dimension} did not pass`);
    }
    assert.equal(scored.unsupportedClaims, 0);
    assert.equal(scored.falsePositives, 0);
  });

  it('always emits every dimension, so a shortfall cannot vanish', () => {
    const scored = scoreFixture({ expected: EXPECTED, report: report({ findings: [] }) });
    assert.deepEqual(
      scored.dimensions.map((entry) => entry.dimension),
      [...SCORE_DIMENSIONS],
    );
  });

  it('fails detection when the finding names the wrong class', () => {
    const scored = scoreFixture({
      expected: EXPECTED,
      report: report({ findings: [{ ...CONFIRMED_FINDING, class: 'observer_exposure' }] }),
    });

    assert.equal(statusOf(scored, 'expected_finding_detected'), 'fail');
    assert.equal(statusOf(scored, 'expected_finding_confirmed'), 'fail');
    // Wrong class, not listed as allowed: a false positive as well as a miss.
    assert.equal(scored.falsePositives, 1);
  });

  it('fails detection when the finding cites the wrong construct', () => {
    const wrongChoice = scoreFixture({
      expected: EXPECTED,
      report: report({ findings: [{ ...CONFIRMED_FINDING, choice: 'Archive' }] }),
    });
    assert.equal(statusOf(wrongChoice, 'expected_finding_detected'), 'fail');

    const noTemplate = scoreFixture({
      expected: EXPECTED,
      report: report({ findings: [{ ...CONFIRMED_FINDING, template: undefined }] }),
    });
    assert.equal(statusOf(noTemplate, 'expected_finding_detected'), 'fail');
    // The class was right, so it is a miss on specificity rather than a false
    // positive: the scorer must not punish it twice.
    assert.equal(noTemplate.falsePositives, 0);
  });

  it('fails when no invariant of the expected class was produced', () => {
    const scored = scoreFixture({
      expected: EXPECTED,
      report: report({ invariants: [{ ...INVARIANT, class: 'propose_accept_bypass' }] }),
    });
    assert.equal(statusOf(scored, 'expected_invariant_generated'), 'fail');
  });
});

describe('confirmation credit is only given for confirmed findings', () => {
  it('detects but does not confirm an unconfirmed finding', () => {
    const scored = scoreFixture({
      expected: EXPECTED,
      report: report({
        findings: [
          { ...CONFIRMED_FINDING, state: 'unconfirmed', evidence: [{ evidenceId: 'ev_1' }] },
        ],
      }),
    });

    assert.equal(statusOf(scored, 'expected_finding_detected'), 'pass');
    assert.equal(statusOf(scored, 'expected_finding_confirmed'), 'fail');
  });

  it('gives no confirmation credit to a finding with no evidence at all', () => {
    const scored = scoreFixture({
      expected: EXPECTED,
      report: report({
        findings: [{ ...CONFIRMED_FINDING, state: 'unconfirmed', evidence: [] }],
      }),
    });

    assert.equal(statusOf(scored, 'expected_finding_confirmed'), 'fail');
    assert.equal(scored.unsupportedClaims, 1);
  });

  it('attaches evidence identifiers only where the dimension passed', () => {
    const passing = scoreFixture({ expected: EXPECTED, report: report() });
    const confirmedDimension = passing.dimensions.find(
      (entry) => entry.dimension === 'expected_finding_confirmed',
    );
    // Sorted, so two runs cite evidence in the same order.
    assert.deepEqual(confirmedDimension?.evidenceIds, ['ev_1', 'ev_3']);

    const unconfirmed = scoreFixture({
      expected: EXPECTED,
      report: report({
        findings: [
          { ...CONFIRMED_FINDING, state: 'unconfirmed', evidence: [{ evidenceId: 'ev_1' }] },
        ],
      }),
    });
    const failed = unconfirmed.dimensions.find(
      (entry) => entry.dimension === 'expected_finding_confirmed',
    );
    assert.deepEqual(failed?.evidenceIds, []);
  });
});

describe('execution dimensions follow the recorded outcome', () => {
  it('fails compilation and exposure when the test never compiled', () => {
    const scored = scoreFixture({
      expected: EXPECTED,
      report: report({
        generatedTests: [
          {
            ...PASSING_TEST,
            outcome: 'compile_failed',
            compiled: false,
            passed: undefined,
            evidenceId: undefined,
          },
        ],
      }),
    });

    assert.equal(statusOf(scored, 'test_generated'), 'pass');
    assert.equal(statusOf(scored, 'test_compiled'), 'fail');
    assert.equal(statusOf(scored, 'expected_behavior_exposed'), 'fail');
  });

  it('fails exposure when execution contradicted the pre-declared outcome', () => {
    const scored = scoreFixture({
      expected: EXPECTED,
      report: report({
        generatedTests: [{ ...PASSING_TEST, outcome: 'executed_contradiction', passed: false }],
      }),
    });

    assert.equal(statusOf(scored, 'test_compiled'), 'pass');
    assert.equal(statusOf(scored, 'expected_behavior_exposed'), 'fail');
  });

  it('marks runtime dimensions not applicable when the fixture does not require them', () => {
    const scored = scoreFixture({
      expected: {
        ...EXPECTED,
        generatedTestExpectations: { mustCompile: false, mustExposeExpectedBehavior: false },
      },
      report: report({ generatedTests: [] }),
    });

    assert.equal(statusOf(scored, 'test_compiled'), 'not_applicable');
    assert.equal(statusOf(scored, 'expected_behavior_exposed'), 'not_applicable');
    // Counted separately, so opting out cannot masquerade as passing.
    assert.equal(aggregate([scored]).passed.test_compiled, 0);
    assert.equal(aggregate([scored]).notApplicable.test_compiled, 1);
  });
});

describe('allowedExtraClasses admits defensible alternate classifications', () => {
  const permissive: Expected = {
    ...EXPECTED,
    allowedExtraClasses: ['missing_multi_party_authorization'],
  };

  it('does not count an allowed alternate class as a false positive', () => {
    const alternate: Finding = {
      ...CONFIRMED_FINDING,
      id: 'alternate',
      class: 'missing_multi_party_authorization',
    };

    const scored = scoreFixture({
      expected: permissive,
      report: report({ findings: [CONFIRMED_FINDING, alternate] }),
    });

    assert.equal(scored.falsePositives, 0);
    assert.equal(statusOf(scored, 'expected_finding_detected'), 'pass');
  });

  it('still counts a class that is neither expected nor allowed', () => {
    const unrelated: Finding = {
      ...CONFIRMED_FINDING,
      id: 'unrelated',
      class: 'propose_accept_bypass',
    };

    const scored = scoreFixture({
      expected: permissive,
      report: report({ findings: [CONFIRMED_FINDING, unrelated] }),
    });

    assert.equal(scored.falsePositives, 1);
  });

  it('does not let an allowed alternate class substitute for the expected finding', () => {
    const onlyAlternate: Finding = {
      ...CONFIRMED_FINDING,
      class: 'missing_multi_party_authorization',
    };

    const scored = scoreFixture({
      expected: permissive,
      report: report({ findings: [onlyAlternate] }),
    });

    assert.equal(scored.falsePositives, 0);
    assert.equal(statusOf(scored, 'expected_finding_detected'), 'fail');
  });
});

describe('scoring is deterministic', () => {
  it('produces identical scorecards from identical inputs', () => {
    const inputs = [{ expected: EXPECTED, report: report() }];
    const generatedAt = new Date('2026-02-02T03:04:05.000Z');
    const build = () =>
      buildScorecard({
        inputs,
        toolchain: { damlSdkVersion: '3.5.5', dpmVersion: '1.0.21' },
        modelId: 'pinned-model',
        provenance: 'harness_validation',
        generatedAt,
      });

    assert.equal(JSON.stringify(build()), JSON.stringify(build()));
  });

  it('differs only in the timestamp when the clock moves', () => {
    const inputs = [{ expected: EXPECTED, report: report() }];
    const at = (iso: string) =>
      buildScorecard({
        inputs,
        toolchain: { damlSdkVersion: '3.5.5', dpmVersion: '1.0.21' },
        modelId: 'pinned-model',
        provenance: 'harness_validation',
        generatedAt: new Date(iso),
      });

    const first = at('2026-02-02T03:04:05.000Z');
    const second = at('2027-12-31T23:59:59.000Z');

    assert.notEqual(first.generatedAt, second.generatedAt);
    assert.deepEqual({ ...first, generatedAt: '' }, { ...second, generatedAt: '' });
  });

  it('orders fixtures by identifier rather than by call order', () => {
    const other: Expected = { ...EXPECTED, fixtureId: 'a00-first' };
    const scorecard = buildScorecard({
      inputs: [
        { expected: EXPECTED, report: report() },
        { expected: other, report: report({ runId: 'run_2' }) },
      ],
      toolchain: { damlSdkVersion: '3.5.5', dpmVersion: '1.0.21' },
      modelId: 'pinned-model',
      provenance: 'harness_validation',
      generatedAt: new Date('2026-02-02T03:04:05.000Z'),
    });

    assert.deepEqual(
      scorecard.results.map((entry) => entry.fixtureId),
      ['a00-first', 'f01-wrong-controller'],
    );
  });
});

describe('scorecard output', () => {
  it('validates against the scorecard schema', () => {
    const scorecard = buildScorecard({
      inputs: [{ expected: EXPECTED, report: report() }],
      toolchain: { damlSdkVersion: '3.5.5', dpmVersion: '1.0.21' },
      modelId: 'pinned-model',
      provenance: 'harness_validation',
      generatedAt: new Date('2026-02-02T03:04:05.000Z'),
    });

    assert.equal(ScorecardSchema.safeParse(scorecard).success, true);
  });

  it('records provenance, so a harness run cannot read as a model benchmark', () => {
    const scorecard = buildScorecard({
      inputs: [{ expected: EXPECTED, report: report() }],
      toolchain: { damlSdkVersion: '3.5.5', dpmVersion: '1.0.21' },
      modelId: 'pinned-model',
      provenance: 'harness_validation',
      generatedAt: new Date('2026-02-02T03:04:05.000Z'),
    });

    assert.equal(scorecard.provenance, 'harness_validation');
    assert.match(scorecard.note, /measures the harness, not any model/);
  });

  it('aggregates counts across fixtures', () => {
    const missing = scoreFixture({ expected: EXPECTED, report: report({ findings: [] }) });
    const complete = scoreFixture({ expected: EXPECTED, report: report() });
    const totals = aggregate([missing, complete]);

    assert.equal(totals.fixtures, 2);
    assert.equal(totals.passed.expected_finding_detected, 1);
    assert.equal(totals.failed.expected_finding_detected, 1);
  });
});

describe('metrics count claims and false positives independently of dimensions', () => {
  it('counts every finding with no evidence as an unsupported claim', () => {
    const metrics = computeMetrics(
      EXPECTED,
      report({
        findings: [
          { ...CONFIRMED_FINDING, state: 'unconfirmed', evidence: [] },
          { ...CONFIRMED_FINDING, id: 'second', state: 'unconfirmed', evidence: [] },
        ],
      }),
    );

    assert.equal(metrics.unsupportedClaims, 2);
  });
});
