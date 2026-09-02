// These tests run against this repository itself, deliberately read-only. No
// throwaway repository is initialised and no git write command is issued
// anywhere in the suite.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { createWorkspace, PathSecurityError } from '../../src/security/paths.js';
import { gitDiff, gitLog, gitStatus, GitToolError } from '../../src/tools/git/inspect.js';
import * as gitModule from '../../src/tools/git/inspect.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workspace = createWorkspace(repoRoot);

describe('git tool surface is read-only', () => {
  it('exports no mutating operation', () => {
    const exported = Object.keys(gitModule);
    for (const forbidden of [
      'gitAdd',
      'gitCommit',
      'gitPush',
      'gitCheckout',
      'gitSwitch',
      'gitBranch',
      'gitReset',
      'gitClean',
      'gitStash',
      'gitRebase',
      'gitMerge',
      'gitCherryPick',
      'gitConfig',
    ]) {
      assert.equal(exported.includes(forbidden), false, `${forbidden} must not be exported`);
    }
  });

  it('exports exactly the three inspection operations', () => {
    const operations = Object.keys(gitModule)
      .filter((name) => name.startsWith('git'))
      .sort();
    assert.deepEqual(operations, ['gitDiff', 'gitLog', 'gitStatus']);
  });
});

describe('gitStatus', () => {
  it('reads the working tree without modifying it', async () => {
    const result = await gitStatus(workspace);
    assert.equal(result.operation, 'status');
    assert.equal(result.exec.exitCode, 0);
    assert.deepEqual(result.exec.argv, ['status', '--porcelain=v1', '--untracked-files=all']);
    for (const entry of result.entries) {
      assert.equal(typeof entry.path, 'string');
    }
  });
});

describe('gitDiff', () => {
  it('builds a fixed argv and runs successfully', async () => {
    const result = await gitDiff(workspace);
    assert.equal(result.exec.exitCode, 0);
    assert.deepEqual(result.exec.argv, ['diff', '--no-color']);
  });

  it('terminates option parsing before pathspecs', async () => {
    const result = await gitDiff(workspace, { paths: ['package.json'] });
    assert.deepEqual(result.exec.argv, ['diff', '--no-color', '--', 'package.json']);
  });

  it('rejects a ref that could be read as an option', async () => {
    await assert.rejects(
      gitDiff(workspace, { ref: '--upload-pack=/bin/sh' }),
      (error: unknown) => error instanceof GitToolError,
    );
  });

  it('rejects a ref containing shell metacharacters', async () => {
    await assert.rejects(
      gitDiff(workspace, { ref: 'main; rm -rf /' }),
      (error: unknown) => error instanceof GitToolError,
    );
  });

  it('rejects a pathspec outside the workspace', async () => {
    await assert.rejects(
      gitDiff(workspace, { paths: ['../../etc/passwd'] }),
      (error: unknown) => error instanceof PathSecurityError,
    );
  });
});

describe('gitLog', () => {
  it('rejects an out-of-range commit count', async () => {
    for (const maxCount of [0, -1, 1_000, 1.5]) {
      await assert.rejects(
        gitLog(workspace, { maxCount }),
        (error: unknown) => error instanceof GitToolError,
      );
    }
  });

  it('requests a bounded commit count', async () => {
    const result = await gitLog(workspace, { maxCount: 5 });
    assert.ok(result.exec.argv.includes('--max-count=5'));
    if (result.exec.exitCode === 0) {
      assert.ok(result.entries.length <= 5);
      for (const entry of result.entries) {
        assert.match(entry.commit, /^[0-9a-f]{40}$/);
      }
    }
  });
});
