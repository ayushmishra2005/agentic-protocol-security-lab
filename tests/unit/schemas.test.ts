import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConfirmedFindingSchema,
  FindingSchema,
  InvariantSchema,
} from '../../src/schemas/findings.js';
import { PhaseArtifactSchema, schemaForPhase } from '../../src/schemas/phases.js';
import { BOUNDARY_STATEMENT, ReportSchema } from '../../src/schemas/report.js';
import { ExpectedSchema } from '../../src/schemas/expected.js';

const evidenceRef = { evidenceId: 'ev_0123456789abcdef' };

const findingCore = {
  id: 'f1',
  class: 'incorrect_controller',
  title: 'Controller is not the party bearing the obligation',
  detail: 'The Transfer choice is controlled by the receiver rather than the owner.',
  severity: 'high' as const,
};

describe('confirmed findings require evidence', () => {
  it('rejects a confirmed finding with no evidence references', () => {
    const result = FindingSchema.safeParse({ ...findingCore, state: 'confirmed', evidence: [] });
    assert.equal(result.success, false);
  });

  it('rejects a confirmed finding that omits the evidence field entirely', () => {
    const result = FindingSchema.safeParse({ ...findingCore, state: 'confirmed' });
    assert.equal(result.success, false);
  });

  it('accepts a confirmed finding carrying at least one evidence reference', () => {
    const result = FindingSchema.safeParse({
      ...findingCore,
      state: 'confirmed',
      evidence: [evidenceRef],
    });
    assert.equal(result.success, true);
  });

  it('rejects a refuted finding with no evidence', () => {
    const result = FindingSchema.safeParse({ ...findingCore, state: 'refuted', evidence: [] });
    assert.equal(result.success, false);
  });

  it('allows an unconfirmed finding to carry no evidence', () => {
    const result = FindingSchema.safeParse({ ...findingCore, state: 'unconfirmed', evidence: [] });
    assert.equal(result.success, true);
  });

  it('rejects a malformed evidence identifier', () => {
    const result = ConfirmedFindingSchema.safeParse({
      ...findingCore,
      state: 'confirmed',
      evidence: [{ evidenceId: 'not-an-evidence-id' }],
    });
    assert.equal(result.success, false);
  });

  it('rejects unknown keys rather than silently dropping them', () => {
    const result = ConfirmedFindingSchema.safeParse({
      ...findingCore,
      state: 'confirmed',
      evidence: [evidenceRef],
      confidence: 0.9,
    });
    assert.equal(result.success, false);
  });

  it('rejects a finding class that is not lower_snake_case', () => {
    const result = FindingSchema.safeParse({
      ...findingCore,
      class: 'Incorrect-Controller',
      state: 'unconfirmed',
      evidence: [],
    });
    assert.equal(result.success, false);
  });
});

describe('invariants', () => {
  it('accepts a well-formed invariant', () => {
    const result = InvariantSchema.safeParse({
      id: 'inv1',
      class: 'incorrect_controller',
      statement: 'Only the owner may exercise Transfer.',
      evidence: [evidenceRef],
    });
    assert.equal(result.success, true);
  });
});

describe('phase artifacts validate against their own phase only', () => {
  it('accepts an artifact parsed with its own phase schema', () => {
    const artifact = { phase: 'understand', summary: 'A summary.', damlPackages: [], evidence: [] };
    assert.equal(schemaForPhase('understand').safeParse(artifact).success, true);
  });

  it('rejects an artifact parsed with a different phase schema', () => {
    const artifact = { phase: 'understand', summary: 'A summary.', damlPackages: [], evidence: [] };
    assert.equal(schemaForPhase('threat_model').safeParse(artifact).success, false);
  });

  it('rejects an artifact whose phase discriminant is unknown', () => {
    const result = PhaseArtifactSchema.safeParse({ phase: 'exfiltrate', evidence: [] });
    assert.equal(result.success, false);
  });

  it('rejects the host-only evaluate stage as a model phase artifact', () => {
    const result = PhaseArtifactSchema.safeParse({ phase: 'evaluate', evidence: [] });
    assert.equal(result.success, false);
  });

  it('propagates the confirmed-finding evidence rule into the report phase', () => {
    const result = schemaForPhase('report').safeParse({
      phase: 'report',
      findings: [{ ...findingCore, state: 'confirmed', evidence: [] }],
      invariants: [],
      summary: 'Summary.',
      evidence: [],
    });
    assert.equal(result.success, false);
  });
});

describe('report', () => {
  const baseReport = {
    schemaVersion: 1 as const,
    runId: 'run_1',
    target: { relativePath: 'fixtures/example' },
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:05:00.000Z',
    toolchain: { damlSdkVersion: '3.5.5', dpmVersion: '1.0.21' },
    model: { id: 'pinned-model' },
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      toolInvocations: 3,
    },
    findings: [],
    invariants: [],
    generatedTests: [],
    degradedPhases: [],
    summary: 'Summary.',
    boundaryStatement: BOUNDARY_STATEMENT,
  };

  it('accepts a well-formed report', () => {
    assert.equal(ReportSchema.safeParse(baseReport).success, true);
  });

  it('rejects a report whose boundary statement was altered', () => {
    const result = ReportSchema.safeParse({
      ...baseReport,
      boundaryStatement: 'Full security audit.',
    });
    assert.equal(result.success, false);
  });

  it('rejects a report that omits the boundary statement', () => {
    const withoutBoundary: Record<string, unknown> = { ...baseReport };
    delete withoutBoundary['boundaryStatement'];
    assert.equal(ReportSchema.safeParse(withoutBoundary).success, false);
  });
});

describe('fixture expectations', () => {
  const expected = {
    schemaVersion: 1 as const,
    fixtureId: 'f01',
    damlSdkVersion: '3.5.5',
    description: 'A wrong-controller vulnerability.',
    expectedFindings: [{ id: 'e1', class: 'incorrect_controller' }],
    expectedInvariants: [],
    allowedExtraClasses: [],
    generatedTestExpectations: { mustCompile: true, mustExposeExpectedBehavior: true },
    oracleScript: 'Oracle:testWrongController',
  };

  it('accepts a well-formed expectation file', () => {
    assert.equal(ExpectedSchema.safeParse(expected).success, true);
  });

  it('requires at least one expected finding', () => {
    assert.equal(ExpectedSchema.safeParse({ ...expected, expectedFindings: [] }).success, false);
  });

  it('rejects unknown keys, so a stray hint cannot leak into scoring', () => {
    const result = ExpectedSchema.safeParse({ ...expected, hint: 'look at the Transfer choice' });
    assert.equal(result.success, false);
  });
});
