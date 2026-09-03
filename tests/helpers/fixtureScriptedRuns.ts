/**
 * Scripted runs for the whole fixture set.
 *
 * As with the F01 script, these are model-shaped scripts and not models. Each
 * plan states which file to read, which template and choice to name, and which
 * exploit Script to write, so a run driven by one exercises the pipeline and the
 * scorer and says nothing about a model's ability to find the vulnerability.
 *
 * Shared between the evaluation integration test and the example capture, so the
 * published scorecard and the tested one come from the same scripts.
 */
import { F01_EXPLOIT_SOURCE, currentPhase } from './f01ScriptedRun.js';
import { ScriptedClient, promptText, textBlock, toolUseBlock } from './fakeModel.js';

export interface FixturePlan {
  readonly fixtureId: string;
  readonly module: string;
  readonly sourceFile: string;
  readonly template: string;
  readonly choice?: string;
  readonly findingClass: string;
  readonly exploit: string;
}

export const FIXTURE_PLANS: readonly FixturePlan[] = [
  {
    fixtureId: 'f01-wrong-controller',
    module: 'Asset',
    sourceFile: 'main/daml/Asset.daml',
    template: 'Asset',
    choice: 'Transfer',
    findingClass: 'incorrect_controller',
    exploit: F01_EXPLOIT_SOURCE,
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
export function artifactFor(
  plan: FixturePlan,
  phase: string,
  evidence: readonly string[],
): unknown {
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

/**
 * One client per fixture.
 *
 * The fixture cannot be inferred from the prompt — the first turn of a run has
 * not yet read any source, so nothing in it names the module. Binding a client
 * to a plan up front also keeps each run's prompts separate, which is what the
 * leakage assertions inspect.
 */
export function makeClient(plan: FixturePlan): ScriptedClient {
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

export interface FixtureClients {
  /** Passed to the evaluator as its client factory. */
  readonly create: () => ScriptedClient;
  /** The clients created so far, for prompt-leakage assertions. */
  readonly clients: ScriptedClient[];
}

/**
 * One client per fixture, handed out in plan order.
 *
 * The fixture cannot be inferred from a prompt: the first turn of a run has not
 * read any source yet, so nothing in it names the module. Fixtures are analysed
 * in the order given, so the nth client is the nth plan.
 */
export function createFixtureClients(): FixtureClients {
  const clients: ScriptedClient[] = [];

  return {
    clients,
    create: () => {
      const plan = FIXTURE_PLANS[clients.length];
      if (plan === undefined) throw new Error('more analyses than fixture plans');
      const client = makeClient(plan);
      clients.push(client);
      return client;
    },
  };
}
