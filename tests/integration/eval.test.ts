// Phase 12: the full evaluation across F01–F04 (T087).
//
// HARNESS VALIDATION, NOT A BENCHMARK RESULT.
//
// The model is a script. It is told which template and choice to name and which
// exploit Script to write, so a perfect scorecard here says exactly one thing:
// the harness computes the score it should compute when given a report that
// deserves it. It says nothing whatsoever about any model's ability to find any
// of these vulnerabilities, and the scorecard records `harness_validation` so
// that the file itself cannot be quoted as if it did.
//
// Everything except the provider is real: the pinned Daml 3.5.5 toolchain
// compiles and runs each generated Script, the evidence store records every
// invocation, and the host assembles each report and scores it.
//
// No Anthropic request is made and no credential is read.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { DEFAULT_FIXTURE_IDS, evaluate, type EvalResult } from '../../src/cli/eval.js';
import { buildScorecard } from '../../src/eval/scorer.js';
import { ScorecardSchema, SCORE_DIMENSIONS } from '../../src/schemas/scorecard.js';
import {
  FAKE_MODEL_ID,
  ScriptedClient,
  promptText,
  textBlock,
  toolUseBlock,
} from '../helpers/fakeModel.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesRoot = path.join(repoRoot, 'fixtures');

const TOOLCHAIN_TIMEOUT_MS = 900_000;

interface FixturePlan {
  readonly fixtureId: string;
  readonly module: string;
  readonly sourceFile: string;
  readonly template: string;
  readonly choice?: string;
  readonly findingClass: string;
  readonly exploit: string;
}

const PLANS: readonly FixturePlan[] = [
  {
    fixtureId: 'f01-wrong-controller',
    module: 'Asset',
    sourceFile: 'main/daml/Asset.daml',
    template: 'Asset',
    choice: 'Transfer',
    findingClass: 'incorrect_controller',
    exploit: `module Exploit where

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
`,
  },
  {
    fixtureId: 'f02-observer-exposure',
    module: 'Payroll',
    sourceFile: 'main/daml/Payroll.daml',
    template: 'CompensationRecord',
    findingClass: 'observer_exposure',
    exploit: `module Exploit where

import Daml.Script
import Payroll

run : Script ()
run = do
  employer <- allocateParty "Employer"
  employee <- allocateParty "Employee"
  vendor <- allocateParty "Vendor"

  _ <- submit employer do
    createCmd CompensationRecord with
      employer = employer
      employee = employee
      vendor = vendor
      annualSalary = 100000.0
      reviewNotes = "confidential"

  visible <- query @CompensationRecord vendor
  assertMsg "the vendor should not see the compensation record" (length visible == 1)
`,
  },
  {
    fixtureId: 'f03-missing-multiparty',
    module: 'JointAccount',
    sourceFile: 'main/daml/JointAccount.daml',
    template: 'JointAccount',
    choice: 'Withdraw',
    findingClass: 'missing_multi_party_authorization',
    exploit: `module Exploit where

import Daml.Script
import JointAccount

run : Script ()
run = do
  bank <- allocateParty "Bank"
  holderA <- allocateParty "HolderA"
  holderB <- allocateParty "HolderB"

  accountId <- submit bank do
    createCmd JointAccount with
      bank = bank
      holderA = holderA
      holderB = holderB
      balance = 100.0

  _ <- submit holderA do
    exerciseCmd accountId Withdraw with amount = 100.0

  pure ()
`,
  },
  {
    fixtureId: 'f04-propose-accept-bypass',
    module: 'Trade',
    sourceFile: 'main/daml/Trade.daml',
    template: 'TradeProposal',
    choice: 'SellerConfirm',
    findingClass: 'propose_accept_bypass',
    exploit: `module Exploit where

import Daml.Script
import Trade

run : Script ()
run = do
  seller <- allocateParty "Seller"
  buyer <- allocateParty "Buyer"

  proposalId <- submit seller do
    createCmd TradeProposal with
      seller = seller
      buyer = buyer
      instrument = "TEST"
      quantity = 1
      price = 1.0

  _ <- submit seller do
    exerciseCmd proposalId SellerConfirm

  pure ()
`,
  },
];

/** Schema-valid artifacts, citing evidence the fake actually collected. */
function artifactFor(plan: FixturePlan, phase: string, evidence: readonly string[]): unknown {
  const refs = evidence.map((evidenceId) => ({ evidenceId }));
  const construct = plan.choice === undefined ? plan.template : `${plan.template}.${plan.choice}`;

  switch (phase) {
    case 'understand':
      return {
        phase,
        summary: `A Daml package under main/ containing the ${plan.template} template.`,
        damlPackages: ['main/daml.yaml'],
        evidence: refs,
      };
    case 'inspect':
      return {
        phase,
        inspectedFiles: [plan.sourceFile],
        changeSummary: 'No version-control context; inspected the package source instead.',
        evidence: refs,
      };
    case 'threat_model':
      return {
        phase,
        threats: [
          {
            id: 'th-1',
            actor: 'a party named on the contract',
            capability: `would be able to act on ${construct} beyond its intended authority`,
            impact: 'a state change or disclosure the policy does not permit',
            template: plan.template,
          },
        ],
        evidence: refs,
      };
    case 'invariants':
      return {
        phase,
        invariants: [
          {
            id: 'inv-1',
            class: plan.findingClass,
            statement: `The intended authorization or disclosure policy for ${construct} must hold.`,
            template: plan.template,
            ...(plan.choice === undefined ? {} : { choice: plan.choice }),
            evidence: refs,
          },
        ],
        evidence: refs,
      };
    case 'auth_semantics':
      return {
        phase,
        templates: [
          {
            name: plan.template,
            signatories: ['issuer'],
            observers: ['other'],
            choices:
              plan.choice === undefined
                ? []
                : [{ name: plan.choice, controllers: ['actor'], consuming: true }],
            heuristic: false,
          },
        ],
        evidence: refs,
      };
    case 'scenarios':
      return {
        phase,
        scenarios: [
          {
            id: 'sc-1',
            invariantId: 'inv-1',
            title: `Unauthorized action against ${construct}`,
            severity: 'high',
            description: `Set up the parties, then exercise ${construct} as the party that should not be able to.`,
          },
        ],
        evidence: refs,
      };
    case 'generate_tests':
      return {
        phase,
        tests: [
          {
            id: 'gt-1',
            scenarioId: 'sc-1',
            scriptName: 'Exploit',
            entryPoint: 'run',
            source: plan.exploit,
            property: `The intended policy for ${construct}.`,
            expectedOutcome: 'script_passes',
            violationIndicatedBy: 'script_passes',
            expectedBehavior: 'The Script completes, which is the ledger permitting the action.',
            evidence: refs,
          },
        ],
        evidence: refs,
      };
    default:
      throw new Error(`no artifact for phase ${phase}`);
  }
}

function currentPhase(prompt: string): string {
  return /CURRENT PHASE: (\w+)/.exec(prompt)?.[1] ?? 'understand';
}

/**
 * One client per fixture.
 *
 * The fixture cannot be inferred from the prompt — the first turn of a run has
 * not yet read any source, so nothing in it names the module. Binding a client
 * to a plan up front also keeps each run's prompts separate, which is what the
 * leakage assertions inspect.
 */
function makeClient(plan: FixturePlan): ScriptedClient {
  const answered = new Set<string>();
  return new ScriptedClient((request) => {
    const prompt = promptText(request);
    const phase = currentPhase(prompt);

    if (!answered.has(phase)) {
      answered.add(phase);
      return {
        stopReason: 'tool_use',
        content: [toolUseBlock(`t-${phase}`, 'repo_read_file', { path: plan.sourceFile })],
      };
    }

    const ids = [...prompt.matchAll(/ev_[0-9a-f]{16}/g)].map((match) => match[0]);
    return { content: [textBlock(JSON.stringify(artifactFor(plan, phase, [...new Set(ids)])))] };
  });
}

/** Digest of every committed fixture file, to prove the run did not touch them. */
function fixtureDigest(): string {
  const parts: string[] = [];
  for (const fixtureId of DEFAULT_FIXTURE_IDS) {
    const root = path.join(fixturesRoot, fixtureId);
    const walk = (dir: string, relative: string): void => {
      for (const entry of fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === '.daml') continue;
        const absolute = path.join(dir, entry.name);
        const childRelative = `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(absolute, childRelative);
        else if (entry.isFile()) {
          parts.push(
            `${childRelative}:${crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`,
          );
        }
      }
    };
    walk(root, fixtureId);
  }
  return parts.join('\n');
}

let scratch: string;
let evaluation: EvalResult;
const clients: ScriptedClient[] = [];
let digestBefore: string;

before(
  async () => {
    digestBefore = fixtureDigest();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-eval-'));

    evaluation = await evaluate({
      fixturesRoot,
      runsRoot: path.join(scratch, 'runs'),
      outputRoot: path.join(scratch, 'out'),
      scratchRoot: path.join(scratch, 'targets'),
      // Fixtures are analysed in the order given, so the nth client is the nth plan.
      createClient: () => {
        const plan = PLANS[clients.length];
        if (plan === undefined) throw new Error('more analyses than fixture plans');
        const client = makeClient(plan);
        clients.push(client);
        return client;
      },
      runIdFor: (fixtureId) => `run-${fixtureId}`,
      now: () => new Date('2026-03-03T12:00:00.000Z'),
    });
  },
  { timeout: TOOLCHAIN_TIMEOUT_MS },
);

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('eval runs the whole fixture set', () => {
  it('scored every fixture', () => {
    assert.equal(evaluation.scorecard.results.length, DEFAULT_FIXTURE_IDS.length);
    assert.deepEqual(
      evaluation.scorecard.results.map((entry) => entry.fixtureId),
      [...DEFAULT_FIXTURE_IDS].sort(),
    );
  });

  it('compiled and executed a generated Script for each fixture', () => {
    for (const run of evaluation.runs) {
      const tests = run.result.report.generatedTests;
      assert.equal(tests.length, 1, `${run.fixtureId} generated ${String(tests.length)} tests`);
      const test = tests[0];
      assert.ok(test !== undefined);
      assert.equal(test.compiled, true, `${run.fixtureId} did not compile`);
      assert.equal(
        test.outcome,
        'executed_expected',
        `${run.fixtureId} did not execute as declared`,
      );
    }
  });

  it('passed every applicable dimension, which validates the harness only', () => {
    for (const fixture of evaluation.scorecard.results) {
      for (const dimension of fixture.dimensions) {
        assert.notEqual(
          dimension.status,
          'fail',
          `${fixture.fixtureId}: ${dimension.dimension} failed`,
        );
      }
      assert.equal(fixture.unsupportedClaims, 0);
      assert.equal(fixture.falsePositives, 0);
      assert.deepEqual(fixture.degradedPhases, []);
    }
  });

  it('labels the result as harness validation rather than a model benchmark', () => {
    assert.equal(evaluation.scorecard.provenance, 'harness_validation');
    assert.equal(evaluation.scorecard.model.id, FAKE_MODEL_ID);
    assert.match(evaluation.scorecard.note, /measures the harness, not any model/);
  });

  it('records the real pinned toolchain', () => {
    assert.equal(evaluation.scorecard.toolchain.damlSdkVersion, '3.5.5');
    assert.equal(evaluation.scorecard.toolchain.dpmVersion, '1.0.21');
  });
});

describe('eval writes a host-owned scorecard', () => {
  it('wrote a schema-valid scorecard.json', () => {
    const onDisk = JSON.parse(fs.readFileSync(evaluation.scorecardPath, 'utf8')) as unknown;
    assert.equal(ScorecardSchema.safeParse(onDisk).success, true);
    assert.equal(path.basename(evaluation.scorecardPath), 'scorecard.json');
  });

  it('reports every dimension for every fixture', () => {
    for (const fixture of evaluation.scorecard.results) {
      assert.deepEqual(
        fixture.dimensions.map((entry) => entry.dimension),
        [...SCORE_DIMENSIONS],
      );
    }
  });

  it('cites evidence that resolves in the run it came from', () => {
    for (const run of evaluation.runs) {
      const recorded = fs
        .readFileSync(path.join(run.result.runDirectory, 'evidence.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => (JSON.parse(line) as { evidenceId: string }).evidenceId);

      const scored = evaluation.scorecard.results.find(
        (entry) => entry.fixtureId === run.fixtureId,
      );
      for (const dimension of scored?.dimensions ?? []) {
        for (const evidenceId of dimension.evidenceIds) {
          assert.ok(recorded.includes(evidenceId), `${evidenceId} is not in ${run.fixtureId}`);
        }
      }
    }
  });

  it('scores identically when the same reports are scored again', () => {
    const inputs = evaluation.runs.map((run) => ({
      expected: run.expected,
      report: run.result.report,
    }));
    const again = buildScorecard({
      inputs,
      toolchain: evaluation.scorecard.toolchain,
      modelId: evaluation.scorecard.model.id,
      provenance: 'harness_validation',
      generatedAt: new Date(evaluation.scorecard.generatedAt),
    });

    assert.equal(JSON.stringify(again), JSON.stringify(evaluation.scorecard));
  });
});

describe('eval preserves the evaluation boundary', () => {
  it('analysed scratch copies, leaving every committed fixture byte-identical', () => {
    assert.equal(fixtureDigest(), digestBefore);
    for (const run of evaluation.runs) {
      assert.equal(run.scratchRoot.startsWith(fixturesRoot), false);
    }
  });

  it('kept expectations and oracles out of every workspace the model read', () => {
    for (const run of evaluation.runs) {
      const targetCopy = path.join(run.result.runDirectory, 'exec', 'target');
      assert.equal(fs.existsSync(path.join(targetCopy, 'expected.json')), false);
      assert.equal(fs.existsSync(path.join(targetCopy, 'test')), false);
    }
  });

  it('never put a benchmark answer into a prompt', () => {
    const prompts = clients.flatMap((client) => client.seenPrompts).join('\n');
    for (const run of evaluation.runs) {
      for (const answer of [
        ...run.expected.expectedFindings.map((entry) => entry.id),
        ...run.expected.expectedInvariants.map((entry) => entry.id),
        run.expected.oracleScript,
        run.expected.description,
      ]) {
        assert.equal(prompts.includes(answer), false, `${answer} leaked into a prompt`);
      }
    }
    assert.equal(prompts.includes('expected.json'), false);
  });

  it('contacted no provider and published no credential', () => {
    assert.equal(clients.length, DEFAULT_FIXTURE_IDS.length);
    for (const client of clients) {
      assert.ok(client.calls > 0);
      assert.equal(client.modelId, FAKE_MODEL_ID);
    }

    const published = fs.readFileSync(evaluation.scorecardPath, 'utf8');
    assert.equal(/sk-ant-/.test(published), false);
    assert.equal(published.includes('ANTHROPIC_API_KEY'), false);
  });
});
