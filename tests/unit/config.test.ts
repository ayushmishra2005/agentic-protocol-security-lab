import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  ConfigError,
  DEFAULT_MODEL_ID,
  resolveDpmExecutable,
  resolveExecutable,
  resolveGitExecutable,
  resolveModelId,
  REQUIRED_DAML_SDK_VERSION,
  REQUIRED_DPM_CLI_VERSION,
} from '../../src/config.js';

describe('resolveExecutable', () => {
  it('rejects a bare command name, which would require a PATH lookup', () => {
    assert.throws(
      () => resolveExecutable('git', 'git executable'),
      (error: unknown) => error instanceof ConfigError && /absolute path/.test(error.message),
    );
  });

  it('rejects a relative path', () => {
    assert.throws(
      () => resolveExecutable('./bin/dpm', 'dpm executable'),
      (error: unknown) => error instanceof ConfigError,
    );
  });

  it('rejects a path that does not exist', () => {
    assert.throws(
      () => resolveExecutable(path.join(os.tmpdir(), 'apsl-no-such-binary'), 'test executable'),
      (error: unknown) => error instanceof ConfigError && /was not found/.test(error.message),
    );
  });

  it('rejects a directory', () => {
    assert.throws(
      () => resolveExecutable(os.tmpdir(), 'test executable'),
      (error: unknown) => error instanceof ConfigError && /not a regular file/.test(error.message),
    );
  });

  it('resolves an absolute executable to a canonical path', () => {
    const resolved = resolveExecutable('/bin/echo', 'echo');
    assert.ok(path.isAbsolute(resolved));
  });
});

// `resolveExecutable` canonicalises through `realpath`, so the resolved path is
// not required to equal the path that was passed in. On a usr-merged Linux
// distribution `/bin` is a symlink to `usr/bin`, so `/bin/echo` canonicalises to
// `/usr/bin/echo`; on macOS `/bin` is a real directory and it does not. The
// expectation is therefore stated against the canonical form of the override.
const OVERRIDE_BIN = '/bin/echo';
const OVERRIDE_BIN_CANONICAL = fs.realpathSync(OVERRIDE_BIN);

describe('environment overrides', () => {
  it('honours DPM_BIN instead of the default location', () => {
    assert.equal(resolveDpmExecutable({ DPM_BIN: OVERRIDE_BIN }), OVERRIDE_BIN_CANONICAL);
  });

  it('honours GIT_BIN instead of the default location', () => {
    const resolved = resolveGitExecutable({ GIT_BIN: OVERRIDE_BIN });
    assert.equal(resolved, OVERRIDE_BIN_CANONICAL);
    // The override must actually displace the default, not merely coexist with it.
    assert.notEqual(resolved, resolveGitExecutable({}));
  });

  it('rejects a relative DPM_BIN override', () => {
    assert.throws(
      () => resolveDpmExecutable({ DPM_BIN: 'dpm' }),
      (error: unknown) => error instanceof ConfigError,
    );
  });

  it('ignores an empty override and falls back to the default', () => {
    assert.equal(resolveGitExecutable({ GIT_BIN: '   ' }), resolveGitExecutable({}));
  });
});

describe('model identifier', () => {
  it('is pinned by default', () => {
    assert.equal(resolveModelId({}), DEFAULT_MODEL_ID);
  });

  it('is overridable', () => {
    assert.equal(resolveModelId({ SECURITY_LAB_MODEL: 'other-model' }), 'other-model');
  });
});

describe('toolchain pins', () => {
  it('matches the versions recorded in plan.md', () => {
    assert.equal(REQUIRED_DAML_SDK_VERSION, '3.5.5');
    assert.equal(REQUIRED_DPM_CLI_VERSION, '1.0.21');
  });
});
