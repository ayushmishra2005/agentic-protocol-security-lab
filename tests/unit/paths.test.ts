import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  canonicalize,
  createWorkspace,
  isWithin,
  PathSecurityError,
  relativeToWorkspace,
  resolveWithin,
  type Workspace,
} from '../../src/security/paths.js';

let scratch: string;
let workspace: Workspace;
let outsideFile: string;

before(() => {
  // The scratch root itself is realpath'd because macOS /var is a symlink to
  // /private/var; without this the fixtures would not be comparable.
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-paths-')));

  const root = path.join(scratch, 'ws');
  fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'nested', 'inside.txt'), 'inside');

  // Sibling directory sharing a lexical prefix with the workspace root.
  fs.mkdirSync(path.join(scratch, 'ws-evil'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'ws-evil', 'loot.txt'), 'loot');

  outsideFile = path.join(scratch, 'outside.txt');
  fs.writeFileSync(outsideFile, 'outside');

  fs.symlinkSync(outsideFile, path.join(root, 'escape-link'));
  fs.symlinkSync(path.join(scratch, 'ws-evil'), path.join(root, 'escape-dir'));

  workspace = createWorkspace(root);
});

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('createWorkspace', () => {
  it('rejects a root that does not exist', () => {
    assert.throws(
      () => createWorkspace(path.join(scratch, 'missing')),
      (error: unknown) => error instanceof PathSecurityError,
    );
  });

  it('rejects a root that is a file', () => {
    assert.throws(
      () => createWorkspace(outsideFile),
      (error: unknown) => error instanceof PathSecurityError,
    );
  });
});

describe('resolveWithin accepts confined paths', () => {
  it('resolves a relative path inside the workspace', () => {
    const resolved = resolveWithin(workspace, 'nested/inside.txt');
    assert.equal(relativeToWorkspace(workspace, resolved), path.join('nested', 'inside.txt'));
  });

  it('resolves the workspace root itself', () => {
    assert.equal(resolveWithin(workspace, '.'), workspace.root);
  });

  it('resolves a path that does not exist yet but is confined', () => {
    const resolved = resolveWithin(workspace, 'nested/not-created-yet.daml');
    assert.equal(
      relativeToWorkspace(workspace, resolved),
      path.join('nested', 'not-created-yet.daml'),
    );
  });

  it('accepts an absolute path that lies inside the workspace', () => {
    const resolved = resolveWithin(workspace, path.join(workspace.root, 'nested', 'inside.txt'));
    assert.ok(isWithin(workspace.root, resolved));
  });
});

describe('resolveWithin rejects escapes', () => {
  const escapes: readonly (readonly [string, string])[] = [
    ['parent traversal', '../outside.txt'],
    ['deep traversal', 'nested/../../outside.txt'],
    ['traversal to filesystem root', '../../../../../../etc/passwd'],
    ['symlinked file pointing outside', 'escape-link'],
    ['file beneath a symlinked directory', 'escape-dir/loot.txt'],
  ];

  for (const [label, candidate] of escapes) {
    it(`rejects ${label}`, () => {
      assert.throws(
        () => resolveWithin(workspace, candidate),
        (error: unknown) => error instanceof PathSecurityError,
        `expected ${candidate} to be rejected`,
      );
    });
  }

  it('rejects an absolute path outside the workspace', () => {
    assert.throws(
      () => resolveWithin(workspace, outsideFile),
      (error: unknown) => error instanceof PathSecurityError,
    );
  });

  it('rejects an absolute sibling-prefix path', () => {
    assert.throws(
      () => resolveWithin(workspace, path.join(scratch, 'ws-evil', 'loot.txt')),
      (error: unknown) => error instanceof PathSecurityError,
    );
  });

  it('rejects a NUL byte', () => {
    assert.throws(
      () => resolveWithin(workspace, 'nested/inside.txt\0.png'),
      (error: unknown) => error instanceof PathSecurityError,
    );
  });
});

describe('isWithin', () => {
  it('treats the root as contained', () => {
    assert.equal(isWithin('/a/b', '/a/b'), true);
  });

  it('accepts a descendant', () => {
    assert.equal(isWithin('/a/b', '/a/b/c/d'), true);
  });

  it('rejects a sibling that shares a lexical prefix', () => {
    // The exact case a naive startsWith check would let through.
    assert.equal(isWithin('/a/b', '/a/bc'), false);
    assert.equal(isWithin('/a/b', '/a/b-evil/secret'), false);
  });

  it('rejects an ancestor', () => {
    assert.equal(isWithin('/a/b', '/a'), false);
  });
});

describe('canonicalize', () => {
  it('resolves symlinks in the parent chain of a missing file', () => {
    const target = canonicalize(path.join(workspace.root, 'escape-dir', 'brand-new.txt'));
    assert.equal(target, path.join(scratch, 'ws-evil', 'brand-new.txt'));
    assert.equal(isWithin(workspace.root, target), false);
  });
});
