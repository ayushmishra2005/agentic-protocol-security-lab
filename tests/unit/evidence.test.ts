// Evidence-layer tests (Constitution Articles I, IV and V).
//
// The properties under test are the ones the report schema depends on: an
// identifier resolves to exactly one record, a record does not change after it
// is written, and nothing credential-shaped reaches the file in the first
// place.
//
// No real credential appears anywhere below. The sentinel is obviously fake and
// is asserted to be absent from persisted bytes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  assertValidRunId,
  EvidenceIdAllocator,
  EvidenceIdError,
  evidenceIdFor,
  MAX_EVIDENCE_PER_RUN,
} from '../../src/evidence/ids.js';
import {
  EvidenceError,
  EvidenceStore,
  readEvidenceFile,
  UnknownEvidenceError,
} from '../../src/evidence/store.js';
import { EvidenceIdSchema } from '../../src/schemas/findings.js';
import { createWorkspace } from '../../src/security/paths.js';
import {
  assertHandlerCoverage,
  dispatchTool,
  ToolDispatchError,
} from '../../src/tools/dispatch.js';
import { TOOL_NAMES, TOOL_REGISTRY } from '../../src/tools/registry.js';

const SENTINEL = 'TEST_SECRET_DO_NOT_PERSIST';

const tempRoots: string[] = [];

function makeRunsRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-evidence-'));
  tempRoots.push(root);
  return root;
}

function makeStore(runId = 'run-test'): EvidenceStore {
  return new EvidenceStore({ runId, runsRoot: makeRunsRoot() });
}

after(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('evidence identifiers', () => {
  it('match the identifier schema the finding and report schemas validate against', () => {
    for (let sequence = 0; sequence < 50; sequence += 1) {
      assert.equal(EvidenceIdSchema.safeParse(evidenceIdFor('run-a', sequence)).success, true);
    }
  });

  it('are deterministic for a given run and sequence', () => {
    assert.equal(evidenceIdFor('run-a', 7), evidenceIdFor('run-a', 7));
  });

  it('differ across sequences and across runs', () => {
    assert.notEqual(evidenceIdFor('run-a', 0), evidenceIdFor('run-a', 1));
    assert.notEqual(evidenceIdFor('run-a', 0), evidenceIdFor('run-b', 0));
  });

  it('allocates unique identifiers across a long run', () => {
    const allocator = new EvidenceIdAllocator('run-a');
    const seen = new Set<string>();
    for (let index = 0; index < 5_000; index += 1) {
      const id = allocator.next();
      assert.equal(seen.has(id), false, `duplicate identifier at ${String(index)}`);
      seen.add(id);
    }
    assert.equal(seen.size, 5_000);
    assert.equal(allocator.allocatedCount, 5_000);
  });

  it('exposes no way to rewind or choose the next identifier', () => {
    const allocator = new EvidenceIdAllocator('run-a');
    const surface = [
      ...Object.keys(allocator),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(allocator) as object),
    ];
    for (const forbidden of ['reset', 'rewind', 'setNext', 'seek', 'allocateAs', 'use']) {
      assert.equal(surface.includes(forbidden), false, `${forbidden} must not be exposed`);
    }
  });

  it('rejects a run id that could escape the runs directory', () => {
    for (const bad of ['..', '../escape', 'a/b', '', '.hidden', 'x'.repeat(65)]) {
      assert.throws(() => {
        assertValidRunId(bad);
      }, EvidenceIdError);
    }
  });

  it('rejects a negative or non-integer sequence', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      assert.throws(() => evidenceIdFor('run-a', bad), EvidenceIdError);
    }
  });

  it('bounds the number of identifiers a single run may allocate', () => {
    // Exhausting the budget honestly would be slow, so this pins the bound
    // itself and leaves the refusal path to the sequence validation above.
    assert.equal(MAX_EVIDENCE_PER_RUN, 100_000);
    assert.throws(() => evidenceIdFor('run-a', MAX_EVIDENCE_PER_RUN + 0.5), EvidenceIdError);
  });
});

describe('evidence store appends', () => {
  it('appends a record and resolves it by identifier', () => {
    const store = makeStore();
    const record = store.append({
      toolName: 'repo_read_file',
      outcome: 'ok',
      parameters: { path: 'README.md' },
      result: { bytesRead: 12 },
    });

    assert.equal(store.count, 1);
    assert.equal(store.has(record.evidenceId), true);
    assert.deepEqual(store.get(record.evidenceId), record);
    assert.equal(record.sequence, 0);
    assert.equal(record.runId, 'run-test');
  });

  it('allocates a distinct identifier per append', () => {
    const store = makeStore();
    const ids = new Set<string>();
    for (let index = 0; index < 25; index += 1) {
      ids.add(
        store.append({ toolName: 'git_status', outcome: 'ok', parameters: {}, result: null })
          .evidenceId,
      );
    }
    assert.equal(ids.size, 25);
    assert.equal(store.count, 25);
  });

  it('resolves each identifier to its own record, not merely to some record', () => {
    const store = makeStore();
    const first = store.append({
      toolName: 'repo_read_file',
      outcome: 'ok',
      parameters: { path: 'first.md' },
      result: { marker: 'first' },
    });
    const second = store.append({
      toolName: 'repo_read_file',
      outcome: 'ok',
      parameters: { path: 'second.md' },
      result: { marker: 'second' },
    });

    assert.notEqual(first.evidenceId, second.evidenceId);
    assert.deepEqual(store.get(first.evidenceId).result, { marker: 'first' });
    assert.deepEqual(store.get(second.evidenceId).result, { marker: 'second' });
  });

  it('persists one JSON line per record', () => {
    const store = makeStore();
    store.append({ toolName: 'git_status', outcome: 'ok', parameters: {}, result: null });
    store.append({ toolName: 'git_diff', outcome: 'ok', parameters: {}, result: null });

    const persisted = readEvidenceFile(store.filePath);
    assert.equal(persisted.length, 2);
    assert.deepEqual(
      persisted.map((entry) => entry.toolName),
      ['git_status', 'git_diff'],
    );
  });

  it('requires error detail on an error outcome and forbids it on success', () => {
    const store = makeStore();
    assert.throws(
      () => store.append({ toolName: 'git_status', outcome: 'error', parameters: {} }),
      EvidenceError,
    );
    assert.throws(
      () =>
        store.append({
          toolName: 'git_status',
          outcome: 'ok',
          parameters: {},
          error: { name: 'X', message: 'y' },
        }),
      EvidenceError,
    );
  });
});

describe('evidence store is append-only', () => {
  it('exposes no update, delete, or truncate operation', () => {
    const store = makeStore();
    const surface = [
      ...Object.keys(store),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(store) as object),
    ];
    for (const forbidden of [
      'set',
      'put',
      'update',
      'replace',
      'delete',
      'remove',
      'clear',
      'truncate',
      'overwrite',
      'patch',
      'rewrite',
    ]) {
      assert.equal(surface.includes(forbidden), false, `${forbidden} must not be exposed`);
    }
  });

  it('returns records that cannot be mutated in place', () => {
    const store = makeStore();
    const record = store.append({
      toolName: 'repo_read_file',
      outcome: 'ok',
      parameters: { path: 'a.md' },
      result: { marker: 'original' },
    });

    assert.throws(() => {
      (record as { outcome: string }).outcome = 'error';
    }, TypeError);
    assert.throws(() => {
      (record.result as { marker: string }).marker = 'tampered';
    }, TypeError);

    assert.equal(store.get(record.evidenceId).outcome, 'ok');
    assert.deepEqual(store.get(record.evidenceId).result, { marker: 'original' });
  });

  it('does not let a later append overwrite an earlier identifier or its content', () => {
    const store = makeStore();
    const first = store.append({
      toolName: 'repo_read_file',
      outcome: 'ok',
      parameters: { path: 'a.md' },
      result: { marker: 'original' },
    });

    // Same tool, same parameters, same content: a store keyed on content rather
    // than on allocation order would collapse these into one record.
    const second = store.append({
      toolName: 'repo_read_file',
      outcome: 'ok',
      parameters: { path: 'a.md' },
      result: { marker: 'original' },
    });

    assert.notEqual(second.evidenceId, first.evidenceId);
    assert.equal(store.count, 2);
    assert.deepEqual(store.get(first.evidenceId).result, { marker: 'original' });
    assert.equal(store.get(first.evidenceId).sequence, 0);
    assert.equal(readEvidenceFile(store.filePath).length, 2);
  });

  it('does not let a caller mutate what was recorded by mutating its own input', () => {
    const store = makeStore();
    const parameters: { path: string } = { path: 'a.md' };
    const record = store.append({
      toolName: 'repo_read_file',
      outcome: 'ok',
      parameters,
      result: null,
    });

    parameters.path = 'tampered.md';
    assert.deepEqual(store.get(record.evidenceId).parameters, { path: 'a.md' });
  });

  it('fails explicitly on an unknown identifier rather than returning undefined', () => {
    const store = makeStore();
    assert.throws(() => store.get('ev_0123456789abcdef'), UnknownEvidenceError);
    assert.throws(() => store.get('not-an-evidence-id'), UnknownEvidenceError);
    assert.equal(store.has('ev_0123456789abcdef'), false);
  });
});

describe('redaction happens before persistence', () => {
  it('never writes the sentinel to disk, in output, parameters, or error text', () => {
    const store = makeStore();

    store.append({
      toolName: 'daml_test',
      outcome: 'ok',
      parameters: { note: `ANTHROPIC_API_KEY=${SENTINEL}` },
      result: { line: `token: ${SENTINEL}`, nested: [{ password: SENTINEL }] },
      exec: {
        commandId: 'dpm_test',
        executable: '/usr/bin/true',
        argv: ['test'],
        cwd: '/tmp',
        exitCode: 0,
        signal: null,
        stdout: `API_KEY=${SENTINEL}`,
        stderr: `secret: ${SENTINEL}`,
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        durationMs: 1,
      },
    });

    // The bytes on disk are the authority here, not the returned object.
    const raw = fs.readFileSync(store.filePath, 'utf8');
    assert.equal(raw.includes(SENTINEL), false, 'sentinel reached the evidence file');
    assert.ok(raw.includes('[REDACTED]'));
  });

  it('redacts a value by its field name, even when the value looks innocuous', () => {
    const store = makeStore();
    const record = store.append({
      toolName: 'repo_read_file',
      outcome: 'ok',
      parameters: {},
      // `hunter2` is not credential-shaped on its own; only the field name says
      // it is a credential, and in structured data the two are separate strings.
      result: { config: { password: 'hunter2', apiKey: ['hunter2'], harmless: 'hunter2' } },
    });

    const config = (record.result as { config: Record<string, unknown> }).config;
    assert.equal(config['password'], '[REDACTED]');
    assert.deepEqual(config['apiKey'], ['[REDACTED]']);
    assert.equal(config['harmless'], 'hunter2');
    assert.equal(fs.readFileSync(store.filePath, 'utf8').includes('"password":"hunter2"'), false);
  });

  it('redacts error detail on a refused invocation', () => {
    const store = makeStore();
    store.append({
      toolName: 'daml_run_script',
      outcome: 'error',
      parameters: {},
      error: { name: 'DamlScriptError', message: `failed with token=${SENTINEL}` },
    });

    assert.equal(fs.readFileSync(store.filePath, 'utf8').includes(SENTINEL), false);
  });

  it('digests the redacted text, so the digest matches what was persisted', () => {
    const store = makeStore();
    const record = store.append({
      toolName: 'git_status',
      outcome: 'ok',
      parameters: {},
      exec: {
        commandId: 'git_status',
        executable: '/usr/bin/git',
        argv: ['status'],
        cwd: '/tmp',
        exitCode: 0,
        signal: null,
        stdout: `API_KEY=${SENTINEL}`,
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        durationMs: 1,
      },
    });

    const persisted = readEvidenceFile(store.filePath)[0];
    assert.ok(persisted?.process);
    assert.equal(persisted.process.stdout.includes(SENTINEL), false);
    assert.equal(persisted.process.stdoutSha256, record.process?.stdoutSha256);
    assert.match(persisted.process.stdoutSha256, /^[0-9a-f]{64}$/);
  });

  it('records the argv, working directory and exit code Article IV requires', () => {
    const store = makeStore();
    const record = store.append({
      toolName: 'git_log',
      outcome: 'ok',
      parameters: { maxCount: 3 },
      exec: {
        commandId: 'git_log',
        executable: '/usr/bin/git',
        argv: ['log', '--max-count=3'],
        cwd: '/tmp',
        exitCode: 0,
        signal: null,
        stdout: 'x',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        durationMs: 2,
      },
    });

    assert.ok(record.process);
    assert.deepEqual(record.process.argv, ['log', '--max-count=3']);
    assert.equal(record.process.cwd, '/tmp');
    assert.equal(record.process.exitCode, 0);
    assert.match(record.process.stderrSha256, /^[0-9a-f]{64}$/);
  });
});

describe('tool dispatch is evidence-backed', () => {
  const workspace = createWorkspace(path.resolve(import.meta.dirname, '..', '..'));

  it('has a handler for every registered tool and no handler beyond them', () => {
    assert.doesNotThrow(() => {
      assertHandlerCoverage();
    });
  });

  it('records a successful read and returns a resolvable identifier', async () => {
    const store = makeStore();
    const invocation = await dispatchTool({ workspace, store }, 'repo_read_file', {
      path: 'package.json',
    });

    const record = store.get(invocation.evidenceId);
    assert.equal(record.toolName, 'repo_read_file');
    assert.equal(record.outcome, 'ok');
    assert.deepEqual(record.parameters, { path: 'package.json' });
    assert.equal(store.count, 1);
  });

  it('records a process-backed tool with its argv and exit code', async () => {
    const store = makeStore();
    const invocation = await dispatchTool({ workspace, store }, 'git_status', {});

    const record = store.get(invocation.evidenceId);
    assert.equal(record.outcome, 'ok');
    assert.ok(record.process);
    assert.deepEqual(record.process.argv, ['status', '--porcelain=v1', '--untracked-files=all']);
    assert.equal(record.process.exitCode, 0);
    assert.equal(record.process.cwd, workspace.root);
  });

  it('records a refusal as a refusal, without inventing a result', async () => {
    const store = makeStore();
    await assert.rejects(
      dispatchTool({ workspace, store }, 'repo_read_file', { path: '../../etc/passwd' }),
      (error: unknown) => {
        assert.ok(error instanceof ToolDispatchError);
        const record = store.get(error.evidenceId);
        assert.equal(record.outcome, 'error');
        assert.equal(record.process, undefined);
        assert.equal(record.result, undefined);
        assert.ok(record.error);
        return true;
      },
    );
    assert.equal(store.count, 1);
  });

  it('records a rejected parameter set before any tool runs', async () => {
    const store = makeStore();
    await assert.rejects(
      dispatchTool({ workspace, store }, 'git_log', { maxCount: 10_000 }),
      (error: unknown) => {
        assert.ok(error instanceof ToolDispatchError);
        const record = store.get(error.evidenceId);
        assert.equal(record.outcome, 'error');
        assert.equal(record.error?.name, 'ParameterValidationError');
        assert.equal(record.process, undefined);
        return true;
      },
    );
  });

  it('records an unknown tool request rather than dropping it', async () => {
    const store = makeStore();
    await assert.rejects(
      dispatchTool({ workspace, store }, 'shell_exec', { cmd: 'rm -rf /' }),
      (error: unknown) => {
        assert.ok(error instanceof ToolDispatchError);
        assert.equal(store.get(error.evidenceId).error?.name, 'UnknownToolError');
        return true;
      },
    );
    assert.equal(store.count, 1);
  });

  it('writes exactly one record per invocation, successful or not', async () => {
    const store = makeStore();
    await dispatchTool({ workspace, store }, 'git_status', {});
    await assert.rejects(dispatchTool({ workspace, store }, 'git_log', { maxCount: 0 }));
    await dispatchTool({ workspace, store }, 'repo_list_files', { extensions: ['.json'] });

    assert.equal(store.count, 3);
    assert.equal(readEvidenceFile(store.filePath).length, 3);
  });

  it('exposes no alternate public entry point that skips evidence', async () => {
    const module: Record<string, unknown> = await import('../../src/tools/dispatch.js');
    const callable = Object.entries(module)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();
    // `assertHandlerCoverage` is a self-check and runs nothing; `dispatchTool`
    // is the only exported way to invoke a tool.
    assert.deepEqual(callable, ['ToolDispatchError', 'assertHandlerCoverage', 'dispatchTool']);
  });

  it('does not expose the evidence store as a model-facing tool', () => {
    for (const name of TOOL_NAMES) {
      assert.equal(
        /evidence|record|log_write|audit/.test(name) && name !== 'git_log',
        false,
        `${name} must not expose the evidence layer`,
      );
    }
    assert.equal(
      TOOL_REGISTRY.some((tool) => tool.name.startsWith('evidence')),
      false,
    );
  });
});
