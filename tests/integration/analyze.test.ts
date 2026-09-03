// Phase 10: the deterministic end-to-end run of User Story 1.
//
// `analyze` is driven over the real F01 fixture with everything real except the
// provider: the pinned Daml 3.5.5 toolchain compiles and runs the generated
// Script, the evidence store records every invocation, the phase machine gates
// every transition, and the host assembles and renders the report. The model is
// a script, so what this proves is the pipeline — six analysis artifacts, a
// generated adversarial test, a real compile, a real execution, and a report
// whose confirmed finding is backed by that execution.
//
// What it does not prove is model quality. The fake is told what to write. A
// real model finding F01 on its own is a separate, later, explicitly authorised
// run.
//
// No Anthropic request is made and no credential is read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { analyze, AnalyzeSetupError, type AnalyzeResult } from '../../src/cli/analyze.js';
import { HOST_ONLY_FIXTURE_ENTRIES } from '../../src/eval/analysisView.js';
import { renderReport } from '../../src/report/render.js';
import { ANALYSIS_PHASES } from '../../src/agent/steps/index.js';
import { ReportSchema } from '../../src/schemas/report.js';
import { FAKE_MODEL_ID, type ScriptedClient } from '../helpers/fakeModel.js';
import { F01_EXPLOIT_SOURCE, createF01Client } from '../helpers/f01ScriptedRun.js';

/** First element, or a clear failure. Keeps assertions free of index guards. */
function first<T>(items: readonly T[]): T {
  const [head] = items;
  if (head === undefined) throw new Error('expected at least one element');
  return head;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(repoRoot, 'fixtures', 'f01-wrong-controller');

let scratch: string;
let result: AnalyzeResult;
let client: ScriptedClient;
let fixtureBefore: string;

/** Size-and-name snapshot, so any write to the committed fixture is visible. */
function snapshotFixture(): string {
  const entries: string[] = [];
  const walk = (dir: string, relative: string): void => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.daml') continue;
        walk(absolute, childRelative);
      } else if (entry.isFile()) {
        entries.push(`${childRelative}:${String(fs.statSync(absolute).size)}`);
      }
    }
  };
  walk(FIXTURE, '');
  return entries.join('\n');
}

before(async () => {
  fixtureBefore = snapshotFixture();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-analyze-'));

  client = createF01Client();

  result = await analyze({
    targetPath: FIXTURE,
    runsRoot: path.join(scratch, 'runs'),
    runId: 'run-analyze',
    createClient: () => client,
    // Benchmark isolation: this fixture carries its own answer and oracle.
    hostOnlyEntries: HOST_ONLY_FIXTURE_ENTRIES,
  });
});

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('analyze: pipeline', () => {
  it('produced all six analysis artifacts and one generated test', () => {
    assert.equal(result.degradedAt, undefined);
    assert.equal(ANALYSIS_PHASES.length, 6);
    assert.equal(result.report.invariants.length, 1);
    assert.equal(result.report.generatedTests.length, 1);
  });

  it('compiled and executed the generated Script with the real toolchain', () => {
    const test = first(result.report.generatedTests);
    assert.equal(test.compiled, true);
    assert.equal(test.outcome, 'executed_expected');
    assert.equal(test.passed, true);
    assert.notEqual(test.evidenceId, undefined);
  });

  it('wrote the generated Script only inside the run directory', () => {
    const generated = path.join(result.runDirectory, 'exec', 'generated', 'daml', 'Exploit.daml');
    assert.equal(fs.existsSync(generated), true);
    assert.equal(fs.readFileSync(generated, 'utf8'), F01_EXPLOIT_SOURCE);
    assert.equal(first(result.report.generatedTests).relativePath.includes('..'), false);
  });

  it('needed no revision, because the first attempt compiled and ran', () => {
    const revision = result.report.revision;
    assert.notEqual(revision, undefined);
    assert.deepEqual(revision, { attempts: 1, revisions: 0, maxRevisions: 2, exhausted: false });
  });

  it('confirmed the finding, backed by execution evidence that resolves', () => {
    assert.equal(result.report.findings.length, 1);
    const finding = first(result.report.findings);
    assert.equal(finding.state, 'confirmed');
    assert.equal(finding.class, 'incorrect_controller');
    assert.equal(result.downgrades.length, 0);

    const recorded = fs
      .readFileSync(path.join(result.runDirectory, 'evidence.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => (JSON.parse(line) as { evidenceId: string }).evidenceId);

    for (const ref of finding.evidence) {
      assert.ok(recorded.includes(ref.evidenceId), `${ref.evidenceId} is not in the store`);
    }

    // The confirmation gate's own condition, restated against the report.
    const supporting = result.report.generatedTests.filter(
      (test) => test.scenarioId === 'sc-1' && test.outcome === 'executed_expected',
    );
    assert.equal(supporting.length, 1);
  });
});

describe('analyze: outputs', () => {
  it('wrote a schema-valid report.json under the run directory', () => {
    assert.equal(path.dirname(result.jsonPath), fs.realpathSync(result.runDirectory));
    const onDisk = JSON.parse(fs.readFileSync(result.jsonPath, 'utf8')) as unknown;
    assert.equal(ReportSchema.safeParse(onDisk).success, true);
  });

  it('wrote report.md as exactly the rendering of that JSON', () => {
    const onDisk = fs.readFileSync(result.markdownPath, 'utf8');
    assert.equal(onDisk, renderReport(result.report));

    for (const finding of result.report.findings) assert.ok(onDisk.includes(finding.title));
    // The Markdown carries no finding the JSON lacks.
    assert.equal((onDisk.match(/^### \d+\./gm) ?? []).length, result.report.findings.length);
  });

  it('records the real toolchain, the fake model identity, and host counters', () => {
    assert.equal(result.report.toolchain.damlSdkVersion, '3.5.5');
    assert.equal(result.report.toolchain.dpmVersion, '1.0.21');
    assert.equal(result.report.model.id, FAKE_MODEL_ID);
    assert.equal(result.report.usage.modelCalls, client.calls);
    assert.ok(result.report.usage.toolInvocations > 0);
  });

  it('carries the prototype boundary in the JSON and renders it from there', () => {
    const markdown = fs.readFileSync(result.markdownPath, 'utf8');
    assert.equal(
      result.report.boundaryStatement,
      'AI review and research prototype, not a formal security audit.',
    );
    assert.ok(markdown.includes(result.report.boundaryStatement));
    assert.ok(markdown.includes(result.report.verification.note));
  });
});

describe('analyze: benchmark isolation', () => {
  it('kept the expectation and the oracle out of the workspace the model reads', () => {
    const targetCopy = path.join(result.runDirectory, 'exec', 'target');
    assert.equal(fs.existsSync(path.join(targetCopy, 'expected.json')), false);
    assert.equal(fs.existsSync(path.join(targetCopy, 'test')), false);
    assert.equal(fs.existsSync(path.join(targetCopy, 'main', 'daml', 'Asset.daml')), true);

    // The manifest was rewritten to name only what the view contains.
    const manifest = fs.readFileSync(path.join(targetCopy, 'multi-package.yaml'), 'utf8');
    assert.equal(manifest.includes('./test'), false);
    assert.ok(manifest.includes('./main'));
  });

  it('never put the benchmark answer into a prompt', () => {
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'expected.json'), 'utf8')) as {
      expectedFindings: { id: string }[];
      expectedInvariants: { id: string }[];
      oracleScript: string;
    };

    const prompts = client.seenPrompts.join('\n');
    for (const answer of [
      ...expected.expectedFindings.map((entry) => entry.id),
      ...expected.expectedInvariants.map((entry) => entry.id),
      expected.oracleScript,
    ]) {
      assert.equal(prompts.includes(answer), false, `${answer} leaked into a prompt`);
    }
    assert.equal(prompts.includes('expected.json'), false);
    assert.equal(/Oracle/.test(prompts), false);
  });

  it('keeps the shipped phase definitions free of fixture-specific answers', () => {
    // The prompts the product would send for any target. A name here would mean
    // the system was told what to look for.
    const definitions = ANALYSIS_PHASES.map((definition) =>
      [definition.objective, definition.toolGuidance, ...definition.acceptance].join('\n'),
    ).join('\n');

    for (const term of ['F01', 'Asset', 'Transfer', 'custodian', 'incorrect_controller']) {
      assert.equal(definitions.includes(term), false, `${term} is hard-coded in a phase prompt`);
    }
  });

  it('left the committed fixture byte-identical', () => {
    assert.equal(snapshotFixture(), fixtureBefore);
  });
});

describe('analyze: setup failures', () => {
  it('refuses a target that does not exist', async () => {
    await assert.rejects(
      analyze({
        targetPath: path.join(scratch, 'nope'),
        runsRoot: path.join(scratch, 'runs'),
        createClient: () => client,
      }),
      AnalyzeSetupError,
    );
  });

  it('refuses a directory that is not a Daml project', async () => {
    const plain = path.join(scratch, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, 'README.md'), 'not daml', 'utf8');

    await assert.rejects(
      analyze({
        targetPath: plain,
        runsRoot: path.join(scratch, 'runs'),
        createClient: () => client,
      }),
      AnalyzeSetupError,
    );
  });

  it('used no credential and contacted no provider', () => {
    // The only client the run could reach is the scripted one, and it has no
    // transport. Its call count is the whole of the run's provider traffic.
    assert.ok(client.calls > 0);
    assert.equal(client.modelId, FAKE_MODEL_ID);

    const published = `${fs.readFileSync(result.jsonPath, 'utf8')}${fs.readFileSync(result.markdownPath, 'utf8')}`;
    assert.equal(/sk-ant-/.test(published), false);
    assert.equal(published.includes('ANTHROPIC_API_KEY'), false);
  });
});
