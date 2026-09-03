// A benchmark answer that reaches the model invalidates the run that produced it,
// and it does so silently: the score still looks like a score.
//
// These tests assert the boundary at the level that matters — the tree the model
// can actually read — using the same function the runner uses to build it, rather
// than a reimplementation that could drift from it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { DEFAULT_FIXTURE_IDS } from '../../src/cli/eval.js';
import { HOST_ONLY_FIXTURE_ENTRIES } from '../../src/eval/analysisView.js';
import { materializeFixtureView, readExpectation } from '../../src/eval/runner.js';
import { ExpectedSchema } from '../../src/schemas/expected.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesRoot = path.join(repoRoot, 'fixtures');

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { force: true, recursive: true });
});

function viewOf(fixtureId: string): string {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), `${fixtureId}-isolation-`));
  tempRoots.push(destination);
  return materializeFixtureView(fixturesRoot, fixtureId, path.join(destination, 'view'));
}

function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(path.relative(root, full));
    }
  };
  walk(root);
  return found;
}

describe('a fixture expectation never enters the tree the model reads', () => {
  for (const fixtureId of DEFAULT_FIXTURE_IDS) {
    it(`${fixtureId}: withholds expected.json and the oracle package`, () => {
      const view = viewOf(fixtureId);
      const files = filesUnder(view);

      assert.equal(files.includes('expected.json'), false);
      for (const file of files) {
        assert.notEqual(path.basename(file), 'expected.json', `${file} is an expectation`);
        assert.notEqual(file.split(path.sep)[0], 'test', `${file} comes from the oracle package`);
      }
    });

    it(`${fixtureId}: still contains the source to be analysed`, () => {
      // The other half of the property. Withholding the answer must not withhold
      // the question: a view with nothing in it would pass an isolation test and
      // make the fixture unanalysable.
      const files = filesUnder(viewOf(fixtureId));
      assert.ok(
        files.some((file) => file.startsWith(`main${path.sep}`) && file.endsWith('.daml')),
        `${fixtureId} view has no Daml source`,
      );
      assert.ok(files.includes(path.join('main', 'daml.yaml')));
    });

    it(`${fixtureId}: leaves no manifest entry pointing at the withheld oracle`, () => {
      const manifestPath = path.join(viewOf(fixtureId), 'multi-package.yaml');
      const manifest = fs.readFileSync(manifestPath, 'utf8');

      assert.equal(manifest.includes('./test'), false);
      assert.ok(manifest.includes('./main'));
    });
  }

  it('never contains benchmark answer values from any fixture expectation', () => {
    // The strongest form: take the actual expected identifiers and classes out of
    // each host-owned expectation and prove none of those strings appears anywhere
    // in the corresponding model-visible tree.
    for (const fixtureId of DEFAULT_FIXTURE_IDS) {
      const expected = readExpectation(fixturesRoot, fixtureId);
      const view = viewOf(fixtureId);

      const answers = [
        ...expected.expectedFindings.map((finding) => finding.id),
        ...expected.expectedInvariants.map((invariant) => invariant.id),
        expected.oracleScript,
        expected.description,
      ];

      const contents = filesUnder(view)
        .map((file) => fs.readFileSync(path.join(view, file), 'utf8'))
        .join('\n');

      for (const answer of answers) {
        assert.equal(contents.includes(answer), false, `${fixtureId} leaked ${answer}`);
      }
    }
  });
});

describe('expectations stay host-owned and are read from the committed fixture', () => {
  it('reads and validates every fixture expectation', () => {
    for (const fixtureId of DEFAULT_FIXTURE_IDS) {
      const expected = readExpectation(fixturesRoot, fixtureId);
      assert.equal(ExpectedSchema.safeParse(expected).success, true);
      assert.equal(expected.fixtureId, fixtureId);
      assert.equal(expected.damlSdkVersion, '3.5.5');
    }
  });

  it('refuses an expectation whose fixtureId would misattribute the score', () => {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-expectation-'));
    tempRoots.push(staging);

    const fixtureId = 'f99-mislabelled';
    fs.mkdirSync(path.join(staging, fixtureId), { recursive: true });
    const source = readExpectation(fixturesRoot, 'f01-wrong-controller');
    fs.writeFileSync(
      path.join(staging, fixtureId, 'expected.json'),
      JSON.stringify({ ...source, fixtureId: 'f01-wrong-controller' }),
      'utf8',
    );

    assert.throws(() => readExpectation(staging, fixtureId), /misattribute/);
  });

  it('names the host-only entries the withholding depends on', () => {
    // If this list ever loses an entry, every isolation guarantee above weakens
    // silently, so it is pinned rather than assumed.
    assert.deepEqual([...HOST_ONLY_FIXTURE_ENTRIES], ['expected.json', 'test']);
  });
});
