import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createWorkspace, PathSecurityError, type Workspace } from '../../src/security/paths.js';
import { listFiles, searchText } from '../../src/tools/repo/list.js';
import { isReadable, RepoPolicyError } from '../../src/tools/repo/policy.js';
import { readFileBounded } from '../../src/tools/repo/read.js';

let scratch: string;
let workspace: Workspace;

before(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-repo-')));
  const root = path.join(scratch, 'ws');

  fs.mkdirSync(path.join(root, 'main', 'daml'), { recursive: true });
  fs.mkdirSync(path.join(root, 'fixtures', 'f00'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'eval'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'main', 'daml', 'Asset.daml'),
    [
      'module Asset where',
      'template Asset with',
      '  owner : Party',
      '  where',
      '    signatory owner',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(root, 'main', 'daml', 'Other.daml'), 'module Other where\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'readme\n');
  fs.writeFileSync(path.join(root, 'fixtures', 'f00', 'expected.json'), '{"answer":"leak"}');
  fs.writeFileSync(path.join(root, 'src', 'eval', 'scorer.ts'), 'export const scorer = 1;');
  fs.writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=fake-not-real');
  fs.writeFileSync(path.join(root, 'server.pem'), 'fake pem');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(50_000));
  fs.writeFileSync(path.join(root, 'leaky.log'), 'ANTHROPIC_API_KEY=sk-ant-fake-value-here\n');

  fs.writeFileSync(path.join(scratch, 'outside.txt'), 'outside');

  workspace = createWorkspace(root);
});

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('read policy', () => {
  const denied = [
    'src/eval/scorer.ts',
    '.env',
    'server.pem',
    'node_modules/pkg/index.js',
    '.git/config',
  ];

  for (const relative of denied) {
    it(`denies ${relative}`, () => {
      assert.equal(isReadable(workspace, path.join(workspace.root, relative)), false);
      assert.throws(
        () => readFileBounded(workspace, relative),
        (error: unknown) => error instanceof RepoPolicyError,
      );
    });
  }

  it('allows ordinary source files', () => {
    assert.equal(isReadable(workspace, path.join(workspace.root, 'main/daml/Asset.daml')), true);
  });

  it('does not treat the basename expected.json as inherently secret', () => {
    // A user's own project may legitimately contain a file by this name, and it
    // is not ours to withhold from them. Keeping a benchmark expectation away
    // from an evaluated model is the job of the evaluation view, which supplies
    // a target directory that does not contain it.
    const relative = 'fixtures/f00/expected.json';
    assert.equal(isReadable(workspace, path.join(workspace.root, relative)), true);
    assert.match(readFileBounded(workspace, relative).content, /leak/);
  });
});

describe('readFileBounded', () => {
  it('reads a confined text file and returns a workspace-relative path', () => {
    const result = readFileBounded(workspace, 'main/daml/Asset.daml');
    assert.equal(result.path, path.join('main', 'daml', 'Asset.daml'));
    assert.match(result.content, /template Asset/);
    assert.equal(result.truncated, false);
  });

  it('truncates a file beyond the byte budget', () => {
    const result = readFileBounded(workspace, 'big.txt', { maxBytes: 1_000 });
    assert.equal(result.bytesRead, 1_000);
    assert.equal(result.truncated, true);
  });

  it('refuses a binary file', () => {
    assert.throws(
      () => readFileBounded(workspace, 'binary.bin'),
      (error: unknown) => error instanceof RepoPolicyError,
    );
  });

  it('refuses a directory', () => {
    assert.throws(
      () => readFileBounded(workspace, 'main'),
      (error: unknown) => error instanceof RepoPolicyError,
    );
  });

  it('refuses to escape the workspace', () => {
    assert.throws(
      () => readFileBounded(workspace, '../outside.txt'),
      (error: unknown) => error instanceof PathSecurityError,
    );
  });

  it('redacts credential-shaped content it does return', () => {
    const result = readFileBounded(workspace, 'leaky.log');
    assert.ok(!result.content.includes('sk-ant-fake-value-here'));
    assert.match(result.content, /\[REDACTED\]/);
  });
});

describe('listFiles', () => {
  it('lists readable files and omits denied subtrees', () => {
    const result = listFiles(workspace);
    assert.ok(result.files.includes(path.join('main', 'daml', 'Asset.daml')));
    assert.ok(result.files.includes('README.md'));
    // Listed, because the name carries no meaning to this policy.
    assert.ok(result.files.includes(path.join('fixtures', 'f00', 'expected.json')));
    for (const denied of ['scorer.ts', '.env', 'server.pem', 'index.js', 'config']) {
      assert.ok(
        !result.files.some((file) => path.basename(file) === denied),
        `${denied} must not be listed`,
      );
    }
  });

  it('filters by extension', () => {
    const result = listFiles(workspace, { extensions: ['.daml'] });
    assert.equal(result.files.length, 2);
    assert.ok(result.files.every((file) => file.endsWith('.daml')));
  });

  it('bounds the number of entries', () => {
    const result = listFiles(workspace, { maxEntries: 1 });
    assert.equal(result.files.length, 1);
    assert.equal(result.truncated, true);
  });

  it('refuses to list outside the workspace', () => {
    assert.throws(
      () => listFiles(workspace, { directory: '..' }),
      (error: unknown) => error instanceof PathSecurityError,
    );
  });
});

describe('searchText', () => {
  it('finds a literal match with a line number', () => {
    const result = searchText(workspace, 'signatory', { extensions: ['.daml'] });
    assert.equal(result.matches.length, 1);

    const match = result.matches[0];
    assert.ok(match !== undefined);
    assert.equal(match.path, path.join('main', 'daml', 'Asset.daml'));
    assert.equal(match.line, 5);
  });

  it('is case-insensitive by default and case-sensitive on request', () => {
    assert.ok(searchText(workspace, 'SIGNATORY', { extensions: ['.daml'] }).matches.length > 0);
    assert.equal(
      searchText(workspace, 'SIGNATORY', { extensions: ['.daml'], caseSensitive: true }).matches
        .length,
      0,
    );
  });

  it('treats the query as a literal, not a regular expression', () => {
    assert.equal(searchText(workspace, '.*', { extensions: ['.daml'] }).matches.length, 0);
  });

  it('never matches inside a denied file', () => {
    // `scorer` appears only in src/eval/, which is host-only.
    assert.equal(searchText(workspace, 'scorer').matches.length, 0);
  });

  it('bounds the number of matches', () => {
    const result = searchText(workspace, 'o', { maxMatches: 2 });
    assert.equal(result.matches.length, 2);
    assert.equal(result.truncated, true);
  });

  it('rejects an empty query', () => {
    assert.throws(() => searchText(workspace, ''));
  });
});
