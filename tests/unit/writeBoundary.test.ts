// T060: the run-scoped write boundary.
//
// The premise of every test here is a model that has been fully compromised by
// target content and is actively trying to write outside the run directory. It
// cannot, and the reason is structural: it has no path to supply. The only
// thing it controls is a script name, and a name is not a path.
//
// The layout below mirrors the real one — a checked-in fixture with an
// expectation and an oracle, host source, and a run directory — so the
// forbidden destinations are real files that would be damaged if a write ever
// landed on them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  generatedRootFor,
  WriteBoundary,
  WriteBoundaryError,
} from '../../src/agent/writeBoundary.js';
import { EvidenceStore } from '../../src/evidence/store.js';
import { TOOL_NAMES } from '../../src/tools/registry.js';

const SCRIPT = 'module Generated where\nimport Daml.Script\n';

const tempRoots: string[] = [];

interface Harness {
  readonly boundary: WriteBoundary;
  readonly store: EvidenceStore;
  readonly generatedRoot: string;
  readonly projectRoot: string;
}

function makeHarness(): Harness {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-wb-'));
  tempRoots.push(projectRoot);

  // Files that must survive every attempt below.
  fs.mkdirSync(path.join(projectRoot, 'fixtures', 'f01', 'test', 'daml'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'src', 'eval'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'fixtures', 'f01', 'expected.json'), '{"real":true}');
  fs.writeFileSync(
    path.join(projectRoot, 'fixtures', 'f01', 'test', 'daml', 'Oracle.daml'),
    'module Oracle where\n',
  );
  fs.writeFileSync(
    path.join(projectRoot, 'src', 'eval', 'scorer.ts'),
    'export const scorer = 1;\n',
  );
  fs.writeFileSync(path.join(projectRoot, '.env'), 'ANTHROPIC_API_KEY=placeholder\n');

  const runsRoot = path.join(projectRoot, 'runs');
  const store = new EvidenceStore({ runId: 'run-wb', runsRoot });
  const generatedRoot = generatedRootFor(runsRoot, 'run-wb');

  return {
    boundary: new WriteBoundary({ generatedRoot, store }),
    store,
    generatedRoot: fs.realpathSync(generatedRoot),
    projectRoot,
  };
}

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

describe('generated script writes', () => {
  it('writes a valid script inside the run directory', () => {
    const { boundary, generatedRoot, store } = makeHarness();

    const written = boundary.writeGeneratedScript({ scriptName: 'Generated', source: SCRIPT });

    assert.equal(written.relativePath, 'Generated.daml');
    assert.equal(written.replaced, false);
    assert.equal(path.dirname(written.absolutePath), generatedRoot);
    assert.equal(fs.readFileSync(written.absolutePath, 'utf8'), SCRIPT);
    assert.equal(store.get(written.evidenceId).outcome, 'ok');
  });

  it('lets a revision replace only that script, in place', () => {
    const { boundary, generatedRoot } = makeHarness();

    const first = boundary.writeGeneratedScript({ scriptName: 'Generated', source: SCRIPT });
    const second = boundary.writeGeneratedScript({
      scriptName: 'Generated',
      source: `${SCRIPT}-- corrected\n`,
    });

    assert.equal(second.replaced, true);
    assert.equal(second.absolutePath, first.absolutePath);
    assert.match(fs.readFileSync(second.absolutePath, 'utf8'), /corrected/);
    // Replacement created nothing else and reached nowhere else.
    assert.deepEqual(boundary.listGeneratedScripts(), ['Generated.daml']);
    assert.deepEqual(fs.readdirSync(generatedRoot), ['Generated.daml']);
    // Both attempts are permanently recorded; neither overwrote the other.
    assert.notEqual(first.evidenceId, second.evidenceId);
  });

  it('gives the model no say in the destination', () => {
    const { boundary, generatedRoot } = makeHarness();

    const written = boundary.writeGeneratedScript({ scriptName: 'Exploit', source: SCRIPT });

    // The host built the filename from a validated identifier. The only thing
    // the model influenced is the stem.
    assert.equal(written.absolutePath, path.join(generatedRoot, 'Exploit.daml'));
  });
});

describe('rejected destinations', () => {
  const hostileNames: readonly { readonly label: string; readonly name: string }[] = [
    { label: 'traversal into the fixture', name: '../../../fixtures/f01/main/daml/Asset' },
    { label: 'traversal to an expectation', name: '../../../fixtures/f01/expected' },
    { label: 'traversal to the oracle', name: '../../../fixtures/f01/test/daml/Oracle' },
    { label: 'traversal to the scorer', name: '../../../src/eval/scorer' },
    { label: 'a dotfile', name: '../../../.env' },
    { label: 'an absolute path', name: '/etc/passwd' },
    { label: 'a nested path', name: 'sub/dir/Generated' },
    { label: 'an extension trick', name: 'Generated.daml' },
    { label: 'a shell script', name: 'payload.sh' },
    { label: 'a backslash path', name: '..\\..\\Asset' },
    { label: 'a NUL byte', name: 'Generated\u0000.sh' },
    { label: 'a lowercase module', name: 'generated' },
    { label: 'an empty name', name: '' },
  ];

  for (const { label, name } of hostileNames) {
    it(`refuses ${label}`, () => {
      const { boundary, store, generatedRoot, projectRoot } = makeHarness();
      const before = store.count;

      assert.throws(
        () => boundary.writeGeneratedScript({ scriptName: name, source: SCRIPT }),
        (error: unknown) => error instanceof WriteBoundaryError,
      );

      // Nothing was written anywhere.
      assert.deepEqual(fs.readdirSync(generatedRoot), []);
      assert.equal(
        fs.readFileSync(path.join(projectRoot, 'fixtures', 'f01', 'expected.json'), 'utf8'),
        '{"real":true}',
      );
      assert.match(
        fs.readFileSync(
          path.join(projectRoot, 'fixtures', 'f01', 'test', 'daml', 'Oracle.daml'),
          'utf8',
        ),
        /module Oracle/,
      );
      assert.match(
        fs.readFileSync(path.join(projectRoot, 'src', 'eval', 'scorer.ts'), 'utf8'),
        /scorer/,
      );

      // The refusal is recorded as a refusal, with no invented process detail.
      assert.equal(store.count, before + 1);
      const record = store.all()[before];
      assert.ok(record);
      assert.equal(record.outcome, 'error');
      assert.equal(record.process, undefined);
      assert.ok(record.error);
    });
  }

  it('refuses to write through a symbolic link at the destination', () => {
    const { boundary, generatedRoot, projectRoot } = makeHarness();
    const victim = path.join(projectRoot, 'fixtures', 'f01', 'expected.json');

    // A symlink planted where the script would go, pointing at a file the model
    // was told to overwrite.
    fs.symlinkSync(victim, path.join(generatedRoot, 'Generated.daml'));

    // Caught by canonical containment: the destination resolves through the
    // link to a path outside the generated root.
    assert.throws(
      () => boundary.writeGeneratedScript({ scriptName: 'Generated', source: SCRIPT }),
      (error: unknown) => error instanceof WriteBoundaryError && /outside/i.test(error.message),
    );
    assert.equal(fs.readFileSync(victim, 'utf8'), '{"real":true}');
  });

  it('refuses a symbolic link that stays inside the generated root', () => {
    const { boundary, generatedRoot } = makeHarness();
    const inside = path.join(generatedRoot, 'Decoy.daml');
    fs.writeFileSync(inside, 'module Decoy where\n');
    fs.symlinkSync(inside, path.join(generatedRoot, 'Generated.daml'));

    // Containment holds here, so the link check is what refuses it. Following
    // it would write to a file under a name the host did not choose.
    assert.throws(
      () => boundary.writeGeneratedScript({ scriptName: 'Generated', source: SCRIPT }),
      (error: unknown) =>
        error instanceof WriteBoundaryError && /symbolic link/i.test(error.message),
    );
    assert.equal(fs.readFileSync(inside, 'utf8'), 'module Decoy where\n');
  });

  it('refuses a script larger than the byte budget', () => {
    const { boundary, generatedRoot } = makeHarness();

    assert.throws(
      () => boundary.writeGeneratedScript({ scriptName: 'Huge', source: 'x'.repeat(300_000) }),
      (error: unknown) => error instanceof WriteBoundaryError,
    );
    assert.deepEqual(fs.readdirSync(generatedRoot), []);
  });

  it('refuses an empty source', () => {
    const { boundary } = makeHarness();
    assert.throws(
      () => boundary.writeGeneratedScript({ scriptName: 'Generated', source: '' }),
      (error: unknown) => error instanceof WriteBoundaryError,
    );
  });

  it('rejects a run id that is not a plain identifier', () => {
    const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-wb-run-'));
    tempRoots.push(runsRoot);
    assert.throws(() => generatedRootFor(runsRoot, '../escape'));
    assert.throws(() => generatedRootFor('relative/runs', 'run-1'));
  });
});

describe('write surface', () => {
  it('exposes no filesystem-mutating tool to the model', () => {
    for (const name of TOOL_NAMES) {
      assert.equal(/write|mkdir|delete|remove|rename|move|chmod|touch/.test(name), false);
    }
  });

  it('redacts credential-shaped content out of a recorded refusal', () => {
    const { boundary, store } = makeHarness();

    assert.throws(() =>
      boundary.writeGeneratedScript({
        scriptName: 'sk-ant-TEST_SECRET_DO_NOT_PERSIST-abcdefghijklmnop',
        source: SCRIPT,
      }),
    );

    const persisted = fs.readFileSync(store.filePath, 'utf8');
    assert.equal(persisted.includes('TEST_SECRET_DO_NOT_PERSIST'), false);
    assert.ok(persisted.includes('[REDACTED]'));
  });
});
