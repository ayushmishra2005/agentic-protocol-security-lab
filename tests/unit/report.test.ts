// T072: report integrity.
//
// Two properties are under test. First, that a finding reaches `confirmed` only
// when the evidence and the execution actually support it — every other path is
// a downgrade, not a deletion. Second, that the Markdown says nothing the JSON
// does not: the renderer is given an object and its output is checked against
// that object, never against a file or a model response.
//
// No provider is contacted and no credential is read. The only key-shaped
// string anywhere below is an obvious sentinel.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { after, describe, it } from 'node:test';

import { EvidenceStore } from '../../src/evidence/store.js';
import { buildReport, reportPhaseArtifact, type BuildReportInput } from '../../src/report/build.js';
import { renderReport } from '../../src/report/render.js';
import { writeReportOutputs } from '../../src/report/write.js';
import type { ExecuteArtifact, GeneratedTest, TestOutcome } from '../../src/schemas/phases.js';
import { PhaseArtifactSchema } from '../../src/schemas/phases.js';
import { ReportSchema, type Report } from '../../src/schemas/report.js';
import { createWorkspace } from '../../src/security/paths.js';
import { dispatchTool } from '../../src/tools/dispatch.js';

/** First element, or a clear failure. Keeps assertions free of index guards. */
function first<T>(items: readonly T[]): T {
  const [head] = items;
  if (head === undefined) throw new Error('expected at least one element');
  return head;
}

const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A real store with two real records, so evidence resolution is not simulated. */
async function makeStore(): Promise<{ store: EvidenceStore; ids: string[] }> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-report-'));
  scratchDirs.push(scratch);

  const target = path.join(scratch, 'target');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'Asset.daml'), 'module Asset where\n', 'utf8');

  const store = new EvidenceStore({ runId: 'run-report', runsRoot: path.join(scratch, 'runs') });
  const context = { workspace: createWorkspace(target), store };

  const ids: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const invocation = await dispatchTool(context, 'repo_list_files', { directory: '.' });
    ids.push(invocation.evidenceId);
  }
  return { store, ids };
}

const FAKE_KEY_SENTINEL = 'sk-ant-fake-not-a-real-credential';

function generatedTest(overrides: Partial<GeneratedTest> = {}): GeneratedTest {
  return {
    id: 'test-1',
    scenarioId: 'sc-1',
    scriptName: 'Exploit',
    entryPoint: 'exploit',
    source: 'module Exploit where\n',
    property: 'Only the owner may transfer.',
    expectedOutcome: 'script_passes',
    violationIndicatedBy: 'script_passes',
    expectedBehavior: 'The custodian submission is accepted, which it should not be.',
    evidence: [],
    ...overrides,
  };
}

function execution(
  outcome: TestOutcome,
  compileEvidenceId: string,
  options: { passed?: boolean; evidenceId?: string; testId?: string } = {},
): ExecuteArtifact {
  return {
    phase: 'execute',
    results: [
      {
        testId: options.testId ?? 'test-1',
        attempt: 1,
        outcome,
        compiled: outcome !== 'compile_failed',
        ...(options.passed === undefined ? {} : { passed: options.passed }),
        compileEvidenceId,
        ...(options.evidenceId === undefined ? {} : { evidenceId: options.evidenceId }),
      },
    ],
  } as ExecuteArtifact;
}

/** A run whose single scenario was tested successfully. The confirmable case. */
async function baseInput(): Promise<BuildReportInput & { execution: ExecuteArtifact }> {
  const { store, ids } = await makeStore();
  const [invariantEvidence, compileEvidence, runEvidence] = ids as [string, string, string];

  return {
    runId: 'run-report',
    targetRelativePath: 'example-project',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: new Date('2026-01-01T00:05:00.000Z'),
    toolchain: { damlSdkVersion: '3.5.5', dpmVersion: '1.0.21' },
    modelId: 'fake-model-for-tests',
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      modelCalls: 4,
      toolCallsRequested: 6,
      toolCallsDispatched: 5,
      toolCallsRefused: 1,
    },
    artifacts: [
      {
        phase: 'invariants',
        artifact: {
          phase: 'invariants',
          invariants: [
            {
              id: 'inv-1',
              class: 'incorrect_controller',
              statement: 'Only the owner may transfer their holding.',
              template: 'Asset',
              choice: 'Transfer',
              evidence: [{ evidenceId: invariantEvidence }],
            },
          ],
          evidence: [{ evidenceId: invariantEvidence }],
        },
      },
      {
        phase: 'scenarios',
        artifact: {
          phase: 'scenarios',
          scenarios: [
            {
              id: 'sc-1',
              invariantId: 'inv-1',
              title: 'Custodian transfers without the owner',
              severity: 'high',
              description: 'The custodian submits Transfer alone and the ledger accepts it.',
              // Deliberate sentinel: a credential-shaped string arriving from
              // target-controlled analysis must never reach an output file.
            },
          ],
          evidence: [{ evidenceId: invariantEvidence }],
        },
      },
    ],
    generatedTests: [generatedTest({ evidence: [{ evidenceId: invariantEvidence }] })],
    execution: execution('executed_expected', compileEvidence, {
      passed: true,
      evidenceId: runEvidence,
    }),
    revision: { attempts: 1, revisions: 0, maxRevisions: 2, exhausted: false },
    degradedPhases: [],
    store,
  };
}

describe('report assembly: evidence', () => {
  it('confirms a finding whose evidence resolves and whose test executed as declared', async () => {
    const { report } = buildReport(await baseInput());

    assert.equal(report.findings.length, 1);
    const finding = first(report.findings);
    assert.equal(finding.state, 'confirmed');
    assert.ok(finding.evidence.length > 0);
    assert.equal(ReportSchema.safeParse(report).success, true);
  });

  it('downgrades a finding whose cited evidence does not resolve', async () => {
    const input = await baseInput();
    // Well-formed and completely fabricated: the shape passes the schema, so
    // only resolution against the store can catch it.
    const fabricated = 'ev_0123456789abcdef';
    const { report, downgrades } = buildReport({
      ...input,
      generatedTests: [generatedTest({ evidence: [{ evidenceId: fabricated }] })],
      artifacts: input.artifacts.map((entry) =>
        entry.phase !== 'invariants'
          ? entry
          : {
              phase: 'invariants',
              artifact: {
                ...(entry.artifact as object),
                invariants: [
                  {
                    id: 'inv-1',
                    class: 'incorrect_controller',
                    statement: 'Only the owner may transfer their holding.',
                    evidence: [{ evidenceId: fabricated }],
                  },
                ],
              },
            },
      ),
    });

    const finding = first(report.findings);
    assert.equal(finding.state, 'unconfirmed');
    assert.match(finding.detail, /did not resolve/);
    assert.equal(
      downgrades.some((entry) => entry.subject === 'finding' && entry.id === finding.id),
      true,
    );

    // The fabricated identifier is dropped, never substituted.
    assert.equal(
      report.findings.some((entry) => entry.evidence.some((ref) => ref.evidenceId === fabricated)),
      false,
    );

    // The invariant cited nothing else, so it is not published at all: Article I
    // gives an invariant no unsupported state to be emitted in.
    assert.equal(report.invariants.length, 0);
    assert.equal(
      downgrades.some((entry) => entry.subject === 'invariant' && entry.id === 'inv-1'),
      true,
    );
  });

  it('keeps an invariant that retains one resolvable reference', async () => {
    const input = await baseInput();
    const real = first(input.generatedTests).evidence;
    const { report, downgrades } = buildReport({
      ...input,
      artifacts: input.artifacts.map((entry) =>
        entry.phase !== 'invariants'
          ? entry
          : {
              phase: 'invariants',
              artifact: {
                ...(entry.artifact as object),
                invariants: [
                  {
                    id: 'inv-1',
                    class: 'incorrect_controller',
                    statement: 'Only the owner may transfer their holding.',
                    evidence: [{ evidenceId: 'ev_0123456789abcdef' }, ...real],
                  },
                ],
              },
            },
      ),
    });

    // Dropping the bad reference is not the same as dropping the invariant.
    const invariant = first(report.invariants);
    assert.equal(invariant.id, 'inv-1');
    assert.deepEqual(invariant.evidence, [...real]);
    assert.equal(
      downgrades.some((entry) => entry.subject === 'invariant'),
      false,
    );
  });

  it('never emits a confirmed finding with no evidence at all', async () => {
    const withExecution = await baseInput();
    const input: BuildReportInput = { ...withExecution };
    delete (input as { execution?: unknown }).execution;
    const { report } = buildReport({
      ...input,
      // No execution at all, so there is no compile or run evidence to attach.
      generatedTests: [generatedTest({ evidence: [] })],
      artifacts: input.artifacts.map((entry) =>
        entry.phase !== 'invariants'
          ? entry
          : {
              phase: 'invariants',
              artifact: {
                phase: 'invariants',
                invariants: [
                  {
                    id: 'inv-1',
                    class: 'incorrect_controller',
                    statement: 'Only the owner may transfer their holding.',
                    evidence: [],
                  },
                ],
                evidence: [],
              },
            },
      ),
    });

    assert.equal(first(report.findings).state, 'unconfirmed');
    assert.equal(first(report.findings).evidence.length, 0);
    for (const finding of report.findings) {
      if (finding.state === 'confirmed') assert.ok(finding.evidence.length > 0);
    }
  });
});

describe('report assembly: execution', () => {
  const cases: readonly {
    readonly name: string;
    readonly outcome: TestOutcome;
    readonly passed?: boolean;
    readonly withRunEvidence: boolean;
  }[] = [
    { name: 'a test that never compiled', outcome: 'compile_failed', withRunEvidence: false },
    {
      name: 'a test that compiled but never ran',
      outcome: 'execution_failed',
      withRunEvidence: false,
    },
    {
      name: 'a test whose result contradicted its own prediction',
      outcome: 'executed_contradiction',
      passed: false,
      withRunEvidence: true,
    },
  ];

  for (const testCase of cases) {
    it(`cannot confirm on ${testCase.name}`, async () => {
      const input = await baseInput();
      const compileEvidence = first(input.execution.results).compileEvidenceId;
      const runEvidence = first(input.execution.results).evidenceId;

      const { report } = buildReport({
        ...input,
        execution: execution(testCase.outcome, compileEvidence, {
          ...(testCase.passed === undefined ? {} : { passed: testCase.passed }),
          ...(testCase.withRunEvidence && runEvidence !== undefined
            ? { evidenceId: runEvidence }
            : {}),
        }),
      });

      assert.equal(first(report.findings).state, 'unconfirmed');
      assert.equal(first(report.generatedTests).outcome, testCase.outcome);
    });
  }

  it('reports revision exhaustion without inventing a successful outcome', async () => {
    const input = await baseInput();
    const compileEvidence = first(input.execution.results).compileEvidenceId;

    const { report } = buildReport({
      ...input,
      execution: execution('compile_failed', compileEvidence),
      revision: { attempts: 3, revisions: 2, maxRevisions: 2, exhausted: true },
    });

    assert.equal(first(report.findings).state, 'unconfirmed');
    assert.deepEqual(report.revision, {
      attempts: 3,
      revisions: 2,
      maxRevisions: 2,
      exhausted: true,
    });
    assert.equal(first(report.generatedTests).compiled, false);
    assert.equal(first(report.generatedTests).passed, undefined);
    assert.match(report.summary, /exhausted/);

    // And the Markdown says so too, rather than presenting the last attempt as
    // the answer.
    assert.match(renderReport(report), /budget of 2 was exhausted/);
  });

  it('does not confirm a scenario that a passing test does not indicate a violation for', async () => {
    const input = await baseInput();
    const { report } = buildReport({
      ...input,
      // The Script asserts the ledger rejects the misuse, so completing means
      // the invariant held.
      generatedTests: [
        generatedTest({
          violationIndicatedBy: 'script_fails',
          evidence: first(input.generatedTests).evidence,
        }),
      ],
    });

    assert.equal(first(report.findings).state, 'unconfirmed');
  });
});

describe('report assembly: host authorship', () => {
  it('produces a report phase artifact the phase machine accepts', async () => {
    const { report } = buildReport(await baseInput());
    const artifact = reportPhaseArtifact(report);
    const parsed = PhaseArtifactSchema.safeParse(artifact);

    assert.equal(parsed.success, true);
    assert.equal(artifact.phase, 'report');
  });

  it('writes a summary from host counts rather than any model text', async () => {
    const { report } = buildReport(await baseInput());

    assert.match(report.summary, /1 finding\(s\): 1 confirmed, 0 unconfirmed/);
    assert.match(report.summary, /Daml SDK 3\.5\.5/);
  });

  it('records the host toolchain, model identity and counted usage', async () => {
    const { report } = buildReport(await baseInput());

    assert.deepEqual(report.toolchain, { damlSdkVersion: '3.5.5', dpmVersion: '1.0.21' });
    assert.equal(report.model.id, 'fake-model-for-tests');
    assert.equal(report.usage.modelCalls, 4);
    // Dispatched and refused, not the model's own account of what it asked for.
    assert.equal(report.usage.toolInvocations, 5);
    assert.equal(report.usage.toolInvocationsRefused, 1);
  });
});

describe('report semantics: best effort, not proof', () => {
  it('states what confirmed means and what the run does not establish', async () => {
    const { report } = buildReport(await baseInput());
    const markdown = renderReport(report);

    assert.match(report.verification.note, /execution-backed evidence/);
    assert.match(report.verification.note, /not a proof/);
    assert.ok(report.verification.scopeLimitations.length >= 5);
    assert.ok(
      report.verification.scopeLimitations.some((limitation) =>
        /No formal verification/.test(limitation),
      ),
    );
    assert.ok(
      report.verification.scopeLimitations.some((limitation) => /Canton network/.test(limitation)),
    );

    for (const text of [JSON.stringify(report), markdown]) {
      // The claims a passing Script must never be inflated into. Phrased as
      // assertions rather than a word ban, so "No formal verification is
      // performed" remains sayable while "formally verified" does not.
      assert.equal(/formally verified/i.test(text), false);
      assert.equal(/proved (the )?vulnerab/i.test(text), false);
      assert.equal(/proved secure/i.test(text), false);
      assert.equal(/audit confirmed/i.test(text), false);
      assert.equal(/guaranteed/i.test(text), false);
      assert.equal(/the protocol is secure/i.test(text), false);
    }

    assert.match(markdown, /not a formal security audit/);
  });

  it('carries the boundary statement in both outputs, rendered from the JSON', async () => {
    const { report } = buildReport(await baseInput());
    const markdown = renderReport(report);

    assert.equal(
      report.boundaryStatement,
      'AI review and research prototype, not a formal security audit.',
    );
    assert.ok(markdown.includes(report.boundaryStatement));
  });
});

describe('markdown derivation', () => {
  it('is deterministic for the same report', async () => {
    const { report } = buildReport(await baseInput());
    assert.equal(renderReport(report), renderReport(report));
  });

  it('renders only findings present in the JSON, in their JSON state', async () => {
    const { report } = buildReport(await baseInput());
    const markdown = renderReport(report);

    // Every finding heading in the document maps to a finding in the object.
    const headings = [...markdown.matchAll(/^### \d+\. (.+)$/gm)].map((match) => match[1]);
    assert.equal(headings.length, report.findings.length);
    for (const heading of headings) {
      assert.ok(report.findings.some((finding) => finding.title === heading));
    }

    // A state cannot be upgraded on the way out.
    const states = [...markdown.matchAll(/^- State: (\w+)$/gm)].map((match) => match[1]);
    assert.deepEqual(
      states,
      report.findings.map((finding) => finding.state),
    );
  });

  it('cannot invent a finding, and reflects a downgrade it is handed', async () => {
    const { report } = buildReport(await baseInput());
    const downgraded: Report = {
      ...report,
      findings: report.findings.map((finding) => ({
        ...finding,
        state: 'unconfirmed' as const,
      })),
    };

    const markdown = renderReport(downgraded);
    assert.equal(markdown.includes('State: confirmed'), false);
    assert.equal((markdown.match(/^### \d+\./gm) ?? []).length, downgraded.findings.length);

    const empty = renderReport({ ...report, findings: [] });
    assert.equal(/^### /m.test(empty), false);
    assert.match(empty, /No findings were produced/);
  });

  it('prints exactly the evidence identifiers the JSON carries', async () => {
    const { report } = buildReport(await baseInput());
    const markdown = renderReport(report);

    const rendered = new Set([...markdown.matchAll(/ev_[0-9a-f]{16}/g)].map((match) => match[0]));
    const inJson = new Set([
      ...report.findings.flatMap((finding) => finding.evidence.map((ref) => ref.evidenceId)),
      ...report.invariants.flatMap((invariant) => invariant.evidence.map((ref) => ref.evidenceId)),
      ...report.generatedTests.flatMap((test) =>
        test.evidenceId === undefined
          ? [test.compileEvidenceId]
          : [test.compileEvidenceId, test.evidenceId],
      ),
    ]);

    for (const id of rendered)
      assert.ok(inJson.has(id), `${id} was rendered but is not in the JSON`);
  });

  it('neutralises target-controlled text rather than rendering it as markup', async () => {
    const { report } = buildReport(await baseInput());
    const hostile: Report = {
      ...report,
      findings: report.findings.map((finding) => ({
        ...finding,
        title: '<img src=x onerror=alert(1)> | broken',
        detail: 'before <script>alert(1)</script> after `code` \u0007bell',
      })),
    };

    const markdown = renderReport(hostile);
    assert.equal(markdown.includes('<script>'), false);
    assert.equal(markdown.includes('<img'), false);
    assert.ok(markdown.includes('&lt;script&gt;'));
    assert.equal(markdown.includes('\u0007'), false);
  });
});

describe('report outputs', () => {
  it('writes both files into the run directory, from one object', async () => {
    const { report } = buildReport(await baseInput());
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-report-write-'));
    scratchDirs.push(scratch);

    const written = writeReportOutputs(path.join(scratch, 'runs', 'run-1'), report);

    assert.equal(path.basename(written.jsonPath), 'report.json');
    assert.equal(path.basename(written.markdownPath), 'report.md');

    const onDisk = JSON.parse(fs.readFileSync(written.jsonPath, 'utf8')) as unknown;
    assert.equal(ReportSchema.safeParse(onDisk).success, true);
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(report)));
    assert.equal(fs.readFileSync(written.markdownPath, 'utf8'), renderReport(report));
  });

  it('refuses to write through a symbolic link planted at the report path', async () => {
    const { report } = buildReport(await baseInput());
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-report-link-'));
    scratchDirs.push(scratch);

    const runDir = path.join(scratch, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    const outside = path.join(scratch, 'elsewhere.json');
    fs.writeFileSync(outside, 'original', 'utf8');
    fs.symlinkSync(outside, path.join(runDir, 'report.json'));

    assert.throws(() => writeReportOutputs(runDir, report));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'original');
  });

  it('contains no credential and no environment dump', async () => {
    const input = await baseInput();
    const { report } = buildReport({
      ...input,
      // A credential-shaped string arriving through analysis text would be a
      // leak from somewhere upstream; assert it is not one this layer creates.
      generatedTests: [
        generatedTest({
          expectedBehavior: `Submission accepted. ${FAKE_KEY_SENTINEL}`,
          evidence: first(input.generatedTests).evidence,
        }),
      ],
    });

    const serialised = `${JSON.stringify(report)}\n${renderReport(report)}`;
    assert.equal(serialised.includes(FAKE_KEY_SENTINEL), false);
    assert.equal(/ANTHROPIC_API_KEY/.test(serialised), false);
    assert.equal(serialised.includes(process.env['PATH'] ?? '\u0000none'), false);
  });
});
