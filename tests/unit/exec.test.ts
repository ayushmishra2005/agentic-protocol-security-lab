import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { execute, ExecSecurityError, type CommandDefinition } from '../../src/security/exec.js';

const ECHO = '/bin/echo';
const SLEEP = '/bin/sleep';
const CAT = '/bin/cat';
const ENV = '/usr/bin/env';

const echoCommand: CommandDefinition = {
  id: 'test_echo',
  executable: ECHO,
  allowedFlags: new Set(['-n']),
};

let scratch: string;

before(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-exec-')));
});

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('argv and flag allowlisting', () => {
  it('runs an allowlisted flag', async () => {
    const result = await execute({
      definition: echoCommand,
      argv: ['-n', 'hello'],
      cwd: scratch,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'hello');
  });

  it('rejects a flag that is not allowlisted, before spawning', async () => {
    await assert.rejects(
      execute({ definition: echoCommand, argv: ['-e', 'hello'], cwd: scratch }),
      (error: unknown) =>
        error instanceof ExecSecurityError && /not allowlisted/.test(error.message),
    );
  });

  it('rejects a non-allowlisted flag written in --flag=value form', async () => {
    await assert.rejects(
      execute({ definition: echoCommand, argv: ['--output=/etc/passwd'], cwd: scratch }),
      (error: unknown) => error instanceof ExecSecurityError,
    );
  });

  it('rejects a long flag that merely starts with an allowlisted prefix', async () => {
    await assert.rejects(
      execute({ definition: echoCommand, argv: ['-network'], cwd: scratch }),
      (error: unknown) => error instanceof ExecSecurityError,
    );
  });

  it('rejects an argv token containing a NUL byte', async () => {
    await assert.rejects(
      execute({ definition: echoCommand, argv: ['a\0b'], cwd: scratch }),
      (error: unknown) => error instanceof ExecSecurityError,
    );
  });
});

describe('executable resolution', () => {
  it('rejects a relative executable path', async () => {
    await assert.rejects(
      execute({
        definition: { id: 'relative', executable: 'echo', allowedFlags: new Set() },
        argv: [],
        cwd: scratch,
      }),
      (error: unknown) => error instanceof ExecSecurityError && /absolute path/.test(error.message),
    );
  });

  it('rejects an executable that does not exist', async () => {
    await assert.rejects(
      execute({
        definition: {
          id: 'missing',
          executable: path.join(scratch, 'no-such-binary'),
          allowedFlags: new Set(),
        },
        argv: [],
        cwd: scratch,
      }),
      (error: unknown) => error instanceof ExecSecurityError,
    );
  });
});

describe('working directory', () => {
  it('rejects a relative working directory', async () => {
    await assert.rejects(
      execute({ definition: echoCommand, argv: ['hi'], cwd: 'relative/dir' }),
      (error: unknown) => error instanceof ExecSecurityError,
    );
  });

  it('rejects a working directory that does not exist', async () => {
    await assert.rejects(
      execute({ definition: echoCommand, argv: ['hi'], cwd: path.join(scratch, 'nope') }),
      (error: unknown) => error instanceof ExecSecurityError,
    );
  });
});

describe('no shell interpretation', () => {
  it('treats shell metacharacters as literal argv data', async () => {
    const payload = '$(whoami) `id` && rm -rf / ; echo pwned | tee /tmp/x > /dev/null';
    const result = await execute({
      definition: echoCommand,
      argv: [payload],
      cwd: scratch,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), payload);
  });

  it('does not expand a glob', async () => {
    fs.writeFileSync(path.join(scratch, 'globbed.txt'), 'x');
    const result = await execute({ definition: echoCommand, argv: ['*.txt'], cwd: scratch });
    assert.equal(result.stdout.trim(), '*.txt');
  });
});

describe('timeout enforcement', () => {
  it('kills a process that exceeds its timeout', async () => {
    const result = await execute({
      definition: { id: 'test_sleep', executable: SLEEP, allowedFlags: new Set() },
      argv: ['30'],
      cwd: scratch,
      timeoutMs: 300,
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.signal, 'SIGKILL');
    assert.notEqual(result.exitCode, 0);
  });
});

describe('output size limits', () => {
  it('truncates output beyond the configured cap', async () => {
    const big = path.join(scratch, 'big.txt');
    fs.writeFileSync(big, 'a'.repeat(200_000));

    const result = await execute({
      definition: { id: 'test_cat', executable: CAT, allowedFlags: new Set() },
      argv: [big],
      cwd: scratch,
      maxOutputBytes: 1_024,
    });

    assert.equal(result.stdoutTruncated, true);
    assert.ok(result.stdout.length <= 1_024, `stdout was ${result.stdout.length} bytes`);
  });
});

describe('environment minimisation', () => {
  it('does not forward credentials to the child process', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-fake-value-for-testing-only';
    process.env['SOME_OTHER_SECRET'] = 'fake-secret-value';
    try {
      const result = await execute({
        definition: { id: 'test_env', executable: ENV, allowedFlags: new Set() },
        argv: [],
        cwd: scratch,
      });
      assert.equal(result.exitCode, 0);
      assert.ok(!result.stdout.includes('ANTHROPIC_API_KEY'));
      assert.ok(!result.stdout.includes('SOME_OTHER_SECRET'));
      assert.ok(!result.stdout.includes('fake-secret-value'));
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
      delete process.env['SOME_OTHER_SECRET'];
    }
  });

  it('gives the child a fixed PATH rather than the host PATH', async () => {
    const result = await execute({
      definition: { id: 'test_env', executable: ENV, allowedFlags: new Set() },
      argv: [],
      cwd: scratch,
    });
    const pathLine = result.stdout.split('\n').find((line) => line.startsWith('PATH='));
    assert.ok(pathLine !== undefined, 'child PATH should be set');
    assert.ok(pathLine.includes('/usr/bin'));
    assert.ok(!pathLine.includes('node_modules/.bin'));
  });
});

describe('redaction of captured output', () => {
  it('redacts credential-shaped output before returning it', async () => {
    const result = await execute({
      definition: echoCommand,
      argv: ['sk-ant-api03-FAKEFAKEFAKEFAKEFAKE'],
      cwd: scratch,
    });
    assert.ok(!result.stdout.includes('FAKEFAKEFAKEFAKEFAKE'));
    assert.match(result.stdout, /\[REDACTED\]/);
  });
});
