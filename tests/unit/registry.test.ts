import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertNoNetworkCapableTools,
  findTool,
  TOOL_NAMES,
  TOOL_REGISTRY,
} from '../../src/tools/registry.js';

describe('tool registry', () => {
  it('registers no network-capable or mutating tool', () => {
    assert.doesNotThrow(() => {
      assertNoNetworkCapableTools();
    });
  });

  it('exposes no mutating git operation', () => {
    const forbidden = [
      'add',
      'commit',
      'push',
      'checkout',
      'switch',
      'branch',
      'reset',
      'clean',
      'stash',
      'rebase',
      'merge',
      'cherry_pick',
      'config',
    ];
    for (const operation of forbidden) {
      assert.equal(
        TOOL_NAMES.includes(`git_${operation}`),
        false,
        `git_${operation} must not be registered`,
      );
    }
  });

  it('exposes no write, fetch or shell tool', () => {
    for (const name of TOOL_NAMES) {
      assert.doesNotMatch(name, /write|delete|remove|fetch|http|shell|exec|network/i);
    }
  });

  it('describes parameters as schemas and never as command strings', () => {
    for (const tool of TOOL_REGISTRY) {
      const serialised = JSON.stringify(tool.description);
      assert.doesNotMatch(serialised, /dpm |git |--/);
      assert.equal(typeof tool.parameters.safeParse, 'function');
    }
  });

  it('rejects unknown parameters for a registered tool', () => {
    const tool = findTool('repo_read_file');
    assert.ok(tool !== undefined);
    assert.equal(tool.parameters.safeParse({ path: 'a.daml' }).success, true);
    assert.equal(
      tool.parameters.safeParse({ path: 'a.daml', executable: '/bin/sh' }).success,
      false,
    );
  });

  it('has unique tool names', () => {
    assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
  });
});
