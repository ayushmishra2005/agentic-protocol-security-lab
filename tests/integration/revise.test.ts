// T066: the generate/execute/revise cycle against the real toolchain.
//
// Everything here is real except the model: the pinned Daml 3.5.5 compiler, the
// write boundary, the evidence store, the execution workspace, and the phase
// machine. The provider is a deterministic script, so the test proves the
// mechanism — a broken test is observed as broken, corrected once, and re-run —
// rather than anything about model quality. No Anthropic request is made and no
// API key is read.
//
// The fake does not know the answer to F01. It writes a test from what the
// fixture source says, which is all the analysis phases would have had. The
// expectation file and the oracle package are not in the workspace at all.
//
// Requires the pinned toolchain, so this is an integration test and does not run
// in CI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { PhaseMachine } from '../../src/agent/phases.js';
import { createExecutionWorkspace } from '../../src/agent/execWorkspace.js';
import { runTestCycle, type TestCycleResult } from '../../src/agent/steps/testCycle.js';
import type { ValidatedArtifact } from '../../src/agent/steps/runPhase.js';
import { WriteBoundary } from '../../src/agent/writeBoundary.js';
import { EvidenceStore } from '../../src/evidence/store.js';
import { createWorkspace } from '../../src/security/paths.js';
import type { ToolContext } from '../../src/tools/dispatch.js';
import { ScriptedClient, promptText, textBlock } from '../helpers/fakeModel.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(repoRoot, 'fixtures', 'f01-wrong-controller');

// First attempt: references a binding that does not exist. Chosen because it
// fails in the type checker, so the failure is unambiguous.
const BROKEN_SOURCE = `module Exploit where

import Daml.Script
import Asset

run : Script ()
run = do
  custodian <- allocateParty "Custodian"
  submit custodian do exerciseCmd thisBindingDoesNotExist Transfer with newOwner = custodian
`;

// Corrected attempt. Written from the template as declared in the fixture
// source: Transfer names custodian as its controller, so a submission by the
// custodian is expected to be accepted, and the Script should complete.
const FIXED_SOURCE = `module Exploit where

import Daml.Script
import Asset

run : Script ()
run = do
  issuer <- allocateParty "Issuer"
  owner <- allocateParty "Owner"
  custodian <- allocateParty "Custodian"

  assetId <- submit issuer do
    createCmd Asset with
      issuer = issuer
      owner = owner
      custodian = custodian
      description = "Test asset"

  _ <- submit custodian do
    exerciseCmd assetId Transfer with newOwner = custodian

  pure ()
`;

function testArtifact(source: string, phase: 'generate_tests' | 'revise'): string {
  const test = {
    id: 'gt-1',
    scenarioId: 'sc-1',
    scriptName: 'Exploit',
    entryPoint: 'run',
    source,
    property: 'Only the current owner may transfer ownership away from themselves.',
    // Declared before anything runs, and not restated afterwards.
    expectedOutcome: 'script_passes',
    expectedBehavior:
      'The custodian submits Transfer. If the declared controller is the custodian, the ' +
      'submission is accepted and the Script completes.',
    evidence: [],
  };

  return JSON.stringify(
    phase === 'generate_tests'
      ? { phase, tests: [test], evidence: [] }
      : {
          phase,
          attempt: 1,
          reason: 'compilation_failure',
          changes: ['Replaced the undefined binding with a contract created in the Script.'],
          tests: [test],
          evidence: [],
        },
  );
}

const PRIOR_ARTIFACTS: readonly ValidatedArtifact[] = [
  {
    phase: 'invariants',
    artifact: {
      phase: 'invariants',
      invariants: [
        {
          id: 'inv-1',
          class: 'incorrect_controller',
          statement:
            'Only the current owner may transfer ownership of an Asset away from themselves.',
          template: 'Asset',
          choice: 'Transfer',
          evidence: [],
        },
      ],
      evidence: [],
    },
  },
  {
    phase: 'auth_semantics',
    artifact: {
      phase: 'auth_semantics',
      templates: [
        {
          name: 'Asset',
          signatories: ['issuer'],
          observers: ['owner', 'custodian'],
          choices: [{ name: 'Transfer', controllers: ['custodian'], consuming: true }],
          heuristic: true,
        },
      ],
      evidence: [],
    },
  },
  {
    phase: 'scenarios',
    artifact: {
      phase: 'scenarios',
      scenarios: [
        {
          id: 'sc-1',
          invariantId: 'inv-1',
          description:
            'The custodian exercises Transfer to reassign ownership without the owner submitting.',
        },
      ],
      evidence: [],
    },
  },
];

let scratch: string;
let result: TestCycleResult;
let store: EvidenceStore;
let machine: PhaseMachine;
let client: ScriptedClient;
let execRoot: string;
let fixtureStateBefore: string;

/** A stable description of the committed fixture, to detect any mutation. */
function snapshotFixture(): string {
  const entries: string[] = [];
  const walk = (dir: string, relative: string): void => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.daml') continue;
        walk(absolute, childRelative);
      } else if (entry.isFile()) {
        entries.push(`${childRelative}:${String(fs.statSync(absolute).size)}`);
      }
    }
  };
  walk(FIXTURE, '');
  return entries.join('\n');
}

before(async () => {
  fixtureStateBefore = snapshotFixture();

  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-revise-'));
  const runsRoot = path.join(scratch, 'runs');
  const runId = 'run-revise';
  store = new EvidenceStore({ runId, runsRoot });

  execRoot = path.join(runsRoot, runId, 'exec');
  fs.mkdirSync(execRoot, { recursive: true });

  const execWorkspace = createExecutionWorkspace({
    sourceRoot: FIXTURE,
    destination: execRoot,
    // The multi-package manifest names the oracle package, which is host-only.
    // Carrying it would both disclose the oracle and break the build.
    additionalHostOnly: ['multi-package.yaml'],
  });

  const boundary = new WriteBoundary({
    generatedRoot: execWorkspace.generatedSourceRoot,
    store,
  });

  // The model's own read surface is the same copied view, so it can never read
  // anything the execution workspace does not contain.
  const modelContext: ToolContext = {
    workspace: createWorkspace(path.join(execRoot, 'target')),
    store,
  };
  const hostToolContext: ToolContext = { workspace: execWorkspace.workspace, store };

  machine = new PhaseMachine();
  while (machine.current !== 'generate_tests') machine.advance({ validArtifact: true });

  client = new ScriptedClient((request) => {
    const prompt = promptText(request);
    // The revise prompt is the one carrying the host's revision context.
    const revising = prompt.includes('The host is requesting a revision');
    return {
      content: [
        textBlock(
          testArtifact(
            revising ? FIXED_SOURCE : BROKEN_SOURCE,
            revising ? 'revise' : 'generate_tests',
          ),
        ),
      ],
    };
  });

  result = await runTestCycle({
    client,
    context: modelContext,
    execution: {
      execWorkspace,
      boundary,
      toolContext: hostToolContext,
      sdkVersion: '3.5.5',
    },
    machine,
    targetPath: '.',
    // Stands in for the Phase 8 output. Deliberately says only what reading
    // Asset.daml would support, and nothing the expectation file says.
    priorArtifacts: PRIOR_ARTIFACTS,
  });
});

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('the revision cycle against the real toolchain', () => {
  it('observes the first attempt failing to compile', () => {
    const first = result.attempts[0];
    assert.ok(first);
    const observed = first.execution.results[0];
    assert.ok(observed);

    assert.equal(first.attempt, 1);
    assert.equal(observed.outcome, 'compile_failed');
    assert.equal(observed.compiled, false);
    // Never ran, so there is no pass/fail to report and none is invented.
    assert.equal(observed.passed, undefined);
    assert.equal(first.revisionRequired, true);
  });

  it('revises exactly once', () => {
    assert.equal(result.revisions, 1);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.revisionExhausted, false);
  });

  it('compiles and runs the corrected attempt', () => {
    const second = result.attempts[1];
    assert.ok(second);
    const observed = second.execution.results[0];
    assert.ok(observed);

    assert.equal(second.attempt, 2);
    assert.equal(observed.compiled, true);
    assert.equal(observed.outcome, 'executed_expected');
    assert.equal(observed.passed, true);
    assert.ok(second.runEvidenceId);
  });

  it('does not revise again once the result matched the prediction', () => {
    assert.equal(result.attempts[1]?.revisionRequired, false);
    assert.equal(machine.current, 'report');
    assert.equal(machine.revisions, 1);
    assert.ok(machine.revisions <= machine.maxRevisions);
  });

  it('followed the conditional graph', () => {
    const phases = machine.completed().map((entry) => entry.phase);
    assert.deepEqual(phases.slice(phases.indexOf('generate_tests')), [
      'generate_tests',
      'execute',
      'revise',
      'execute',
    ]);
  });
});

describe('evidence across both attempts', () => {
  it('keeps the failed attempt and gives the corrected one new records', () => {
    const first = result.attempts[0];
    const second = result.attempts[1];
    assert.ok(first && second);

    assert.notEqual(first.compileEvidenceId, second.compileEvidenceId);
    // The failed compile is still resolvable after the successful one.
    assert.equal(store.get(first.compileEvidenceId).outcome, 'ok');
    const firstProcess = store.get(first.compileEvidenceId).process;
    const secondProcess = store.get(second.compileEvidenceId).process;
    assert.ok(firstProcess && secondProcess);
    assert.notEqual(firstProcess.exitCode, 0);
    assert.equal(secondProcess.exitCode, 0);
  });

  it('overwrote no record', () => {
    const ids = store.ids();
    assert.equal(new Set(ids).size, ids.length);

    const persisted = fs
      .readFileSync(store.filePath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    assert.equal(persisted.length, ids.length);
  });

  it('records both generated writes, the second replacing the first', () => {
    const writes = store
      .all()
      .filter((record) => record.toolName === 'host_write_generated_script');
    assert.equal(writes.length, 2);
    assert.deepEqual(
      writes.map((record) => (record.result as { replaced: boolean }).replaced),
      [false, true],
    );
  });

  it('ran the real toolchain, with argv recorded', () => {
    const processes = store.all().filter((record) => record.process !== undefined);
    const argvs = processes.flatMap((record) =>
      record.process === undefined ? [] : [record.process],
    );
    assert.ok(argvs.some((process) => process.argv.includes('build')));
    assert.ok(argvs.some((process) => process.argv.includes('test')));
    for (const process of argvs) {
      assert.ok(process.cwd.startsWith(fs.realpathSync(execRoot)));
    }
  });
});

describe('isolation', () => {
  it('left the committed fixture untouched', () => {
    assert.equal(snapshotFixture(), fixtureStateBefore);
  });

  it('never put the expectation or the oracle in the workspace', () => {
    const target = path.join(execRoot, 'target');
    assert.equal(fs.existsSync(path.join(target, 'expected.json')), false);
    assert.equal(fs.existsSync(path.join(target, 'test')), false);
    assert.ok(fs.existsSync(path.join(target, 'main', 'daml', 'Asset.daml')));
  });

  it('never put a benchmark answer in front of the model', () => {
    const delivered = client.seenPrompts.join('\n');
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'expected.json'), 'utf8')) as {
      description: string;
      expectedFindings: readonly { id: string; class: string }[];
      expectedInvariants: readonly { id: string }[];
      oracleScript: string;
    };

    // The answers: the stated defect, the finding and invariant identifiers the
    // scorer grades against, and the oracle entry point. Two fields are
    // deliberately absent. The fixture id is the package name, so it appears in
    // compiler diagnostics as a matter of course. The finding class is a value
    // from the project's public taxonomy, which any analysis may reach on its
    // own and which is not the benchmark's to keep.
    const answers = [
      expected.description,
      ...expected.expectedFindings.map((finding) => finding.id),
      ...expected.expectedInvariants.map((invariant) => invariant.id),
      expected.oracleScript,
    ];

    for (const answer of answers) {
      assert.equal(delivered.includes(answer), false, `benchmark answer leaked: ${answer}`);
    }
    assert.equal(delivered.includes('Oracle'), false);
    assert.equal(delivered.includes('expected.json'), false);
  });

  it('wrote generated code only inside the run directory', () => {
    const generated = path.join(execRoot, 'generated', 'daml');
    assert.deepEqual(fs.readdirSync(generated), ['Exploit.daml']);
    assert.equal(fs.readFileSync(path.join(generated, 'Exploit.daml'), 'utf8'), FIXED_SOURCE);
  });
});
