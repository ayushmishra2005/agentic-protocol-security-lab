// The checked-in example run (Constitution Article VI).
//
// The example exists so that a reviewer without an API key can judge whether a
// conclusion was earned. That only works if the published copy is intact and
// safe, so this test treats it as a published artifact rather than as output:
// the report must still validate, the Markdown must still be exactly the
// rendering of it, every cited evidence identifier must still resolve, the
// digests must match the bytes shown, and nothing in the directory may carry a
// credential or a host path.
//
// It also asserts the provenance disclaimer. The example was produced by a
// scripted fake, and a reader who missed that would draw a conclusion about a
// model from a file that says nothing about one.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { renderReport } from '../../src/report/render.js';
import { ReportSchema, type Report } from '../../src/schemas/report.js';
import { ScorecardSchema } from '../../src/schemas/scorecard.js';
import { FAKE_MODEL_ID } from '../helpers/fakeModel.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exampleRoot = path.join(repoRoot, 'examples');
const runRoot = path.join(exampleRoot, 'run-f01');

function read(relative: string): string {
  return fs.readFileSync(path.join(runRoot, relative), 'utf8');
}

interface EvidenceLine {
  readonly evidenceId: string;
  readonly toolName: string;
  readonly outcome: string;
  readonly process?: {
    readonly argv: readonly string[];
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly stdoutSha256: string;
    readonly stderrSha256: string;
  };
}

const report: Report = ReportSchema.parse(JSON.parse(read('report.json')));
const evidence = read('evidence.jsonl')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as EvidenceLine);

const everyFile = fs
  .readdirSync(exampleRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.join(entry.parentPath, entry.name));

describe('the example run is complete', () => {
  it('publishes the report, the rendering, the evidence, and the generated Script', () => {
    for (const file of ['report.json', 'report.md', 'evidence.jsonl', 'README.md']) {
      assert.ok(fs.existsSync(path.join(runRoot, file)), `${file} is missing`);
    }
    assert.ok(fs.existsSync(path.join(runRoot, 'generated', 'Exploit.daml')));
  });

  it('renders report.md from report.json exactly', () => {
    assert.equal(read('report.md'), renderReport(report));
  });

  it('records tool invocations with their exit codes', () => {
    const processes = evidence.filter((record) => record.process !== undefined);
    assert.ok(processes.length > 0);

    for (const record of processes) {
      assert.ok(record.process !== undefined);
      assert.equal(
        typeof record.process.exitCode,
        'number',
        `${record.evidenceId} has no exit code`,
      );
      assert.ok(record.process.argv.length > 0);
    }
  });

  it('resolves every evidence identifier the report cites', () => {
    const recorded = new Set(evidence.map((record) => record.evidenceId));
    const cited = [
      ...report.findings.flatMap((finding) => finding.evidence),
      ...report.invariants.flatMap((invariant) => invariant.evidence),
    ].map((reference) => reference.evidenceId);

    assert.ok(cited.length > 0);
    for (const evidenceId of cited) {
      assert.ok(recorded.has(evidenceId), `${evidenceId} does not resolve`);
    }
    for (const test of report.generatedTests) {
      assert.ok(recorded.has(test.compileEvidenceId));
      if (test.evidenceId !== undefined) assert.ok(recorded.has(test.evidenceId));
    }
  });

  it('shows a confirmed finding backed by a Script that compiled and ran', () => {
    const [finding] = report.findings;
    assert.ok(finding !== undefined);
    assert.equal(finding.state, 'confirmed');
    assert.equal(finding.class, 'incorrect_controller');

    const [test] = report.generatedTests;
    assert.ok(test !== undefined);
    assert.equal(test.compiled, true);
    assert.equal(test.outcome, 'executed_expected');
    assert.ok(
      read(path.join('generated', 'Exploit.daml')).includes('exerciseCmd assetId Transfer'),
    );
  });

  it('publishes digests a reader can check against the published bytes', () => {
    const digest = (text: string): string =>
      createHash('sha256').update(text, 'utf8').digest('hex');

    for (const record of evidence) {
      if (record.process === undefined) continue;
      assert.equal(
        record.process.stdoutSha256,
        digest(record.process.stdout),
        `${record.evidenceId} stdout digest does not match`,
      );
      assert.equal(record.process.stderrSha256, digest(record.process.stderr));
    }
  });
});

describe('the example run is safe to publish', () => {
  it('contains no credential material', () => {
    for (const file of everyFile) {
      const contents = fs.readFileSync(file, 'utf8');
      assert.equal(/sk-ant-/.test(contents), false, `${file} contains a key-shaped string`);
      assert.equal(contents.includes('ANTHROPIC_API_KEY'), false, `${file} names the credential`);
      assert.equal(/\bBearer\s+\S/.test(contents), false, `${file} contains a bearer token`);
      assert.equal(/x-api-key/i.test(contents), false, `${file} contains an API key header`);
    }
  });

  it('contains no absolute host path', () => {
    for (const file of everyFile) {
      const contents = fs.readFileSync(file, 'utf8');
      for (const pattern of [
        /\/Users\//,
        /\/home\/[a-z]/,
        /\/var\/folders\//,
        /\/private\/var\//,
      ]) {
        assert.equal(
          pattern.test(contents),
          false,
          `${file} leaks a host path (${String(pattern)})`,
        );
      }
    }
  });

  it('publishes only the target basename, not where it lived', () => {
    assert.equal(report.target.relativePath, 'f01-wrong-controller');
    assert.equal(report.target.relativePath.includes('/'), false);
  });
});

describe('the example states what produced it', () => {
  it('says the provider was a script and not a model', () => {
    const readme = read('README.md');
    assert.match(readme, /script, not a model/i);
    assert.match(readme, /No live\s+provider request has ever been made/i);
  });

  it('carries the capability boundary from the report itself', () => {
    assert.equal(
      report.boundaryStatement,
      'AI review and research prototype, not a formal security audit.',
    );
    assert.ok(read('report.md').includes(report.boundaryStatement));
    assert.ok(read('report.md').includes(report.verification.note));
  });

  it('names the fake model, so no reader can mistake it for a benchmark', () => {
    assert.equal(report.model.id, FAKE_MODEL_ID);
  });
});

describe('the example scorecard', () => {
  const scorecard = ScorecardSchema.parse(
    JSON.parse(fs.readFileSync(path.join(exampleRoot, 'scorecard.json'), 'utf8')),
  );

  it('validates, and records the fixture set, toolchain, and model that produced it', () => {
    assert.equal(scorecard.aggregate.fixtures, 4);
    assert.deepEqual(
      scorecard.results.map((entry) => entry.fixtureId),
      [
        'f01-wrong-controller',
        'f02-observer-exposure',
        'f03-missing-multiparty',
        'f04-propose-accept-bypass',
      ],
    );
    assert.equal(scorecard.toolchain.damlSdkVersion, '3.5.5');
    assert.equal(scorecard.toolchain.dpmVersion, '1.0.21');
    assert.equal(scorecard.model.id, FAKE_MODEL_ID);
  });

  it('is labelled harness validation rather than a model benchmark', () => {
    assert.equal(scorecard.provenance, 'harness_validation');
    assert.match(scorecard.note, /measures the harness, not any model/);
  });
});
