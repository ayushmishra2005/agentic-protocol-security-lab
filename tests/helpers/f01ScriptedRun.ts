/**
 * The scripted F01 run.
 *
 * This is a model-shaped script, not a model. It is told which file to read,
 * which template and choice to name, and which exploit Script to write, so
 * anything driven by it demonstrates the pipeline around the model and nothing
 * about a model's ability to find F01.
 *
 * It lives here because three things need exactly the same run: the end-to-end
 * integration test, the fixture-set evaluation, and the checked-in example run a
 * reviewer reads. Three copies of an exploit Script would drift, and the one
 * that drifted would be the published one.
 */
import { ScriptedClient, promptText, textBlock, toolUseBlock } from './fakeModel.js';

/**
 * The exploit Script, written from what the fixture source says.
 *
 * `Transfer` names the custodian as its controller, so a submission by the
 * custodian is expected to be accepted. The Script completing is therefore the
 * ledger permitting a transfer the owner never authorised.
 */
export const F01_EXPLOIT_SOURCE = `module Exploit where

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

/** Schema-valid artifacts, citing the evidence the fake actually collected. */
export function f01ArtifactFor(phase: string, evidence: readonly string[]): unknown {
  const refs = evidence.map((evidenceId) => ({ evidenceId }));

  switch (phase) {
    case 'understand':
      return {
        phase,
        summary: 'A Daml package under main/ with a single module describing an asset holding.',
        damlPackages: ['main/daml.yaml'],
        evidence: refs,
      };
    case 'inspect':
      return {
        phase,
        inspectedFiles: ['main/daml/Asset.daml'],
        changeSummary: 'No version-control context; inspected the package source instead.',
        evidence: refs,
      };
    case 'threat_model':
      return {
        phase,
        threats: [
          {
            id: 'th-1',
            actor: 'custodian',
            capability: 'would be able to exercise a choice that moves ownership',
            impact: 'the owner loses the asset without submitting anything',
            template: 'Asset',
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
            class: 'incorrect_controller',
            statement:
              'Only the current owner may transfer ownership of an Asset away from themselves.',
            template: 'Asset',
            choice: 'Transfer',
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
            name: 'Asset',
            signatories: ['issuer'],
            observers: ['owner', 'custodian'],
            choices: [{ name: 'Transfer', controllers: ['custodian'], consuming: true }],
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
            title: 'Custodian transfers ownership without the owner submitting',
            severity: 'high',
            description:
              'Allocate issuer, owner and custodian, create an Asset, then have the custodian ' +
              'submit Transfer. If the invariant holds the ledger should reject it.',
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
            source: F01_EXPLOIT_SOURCE,
            property: 'Only the current owner may transfer ownership away from themselves.',
            expectedOutcome: 'script_passes',
            violationIndicatedBy: 'script_passes',
            expectedBehavior:
              'The custodian submits Transfer. If the declared controller is the custodian, the ' +
              'submission is accepted and the Script completes.',
            evidence: refs,
          },
        ],
        evidence: refs,
      };
    default:
      throw new Error(`no artifact for phase ${phase}`);
  }
}

export function currentPhase(prompt: string): string {
  return /CURRENT PHASE: (\w+)/.exec(prompt)?.[1] ?? 'understand';
}

/**
 * One tool call per phase, then the artifact.
 *
 * The tool call is what makes the cited evidence real: the identifiers come back
 * from the host, and an artifact citing anything else is rejected before it
 * reaches the report.
 */
export function createF01Client(): ScriptedClient {
  const answered = new Set<string>();

  return new ScriptedClient((request) => {
    const prompt = promptText(request);
    const phase = currentPhase(prompt);

    if (!answered.has(phase)) {
      answered.add(phase);
      return {
        stopReason: 'tool_use',
        content: [toolUseBlock(`t-${phase}`, 'repo_read_file', { path: 'main/daml/Asset.daml' })],
      };
    }

    const ids = [...prompt.matchAll(/ev_[0-9a-f]{16}/g)].map((match) => match[0]);
    return { content: [textBlock(JSON.stringify(f01ArtifactFor(phase, [...new Set(ids)])))] };
  });
}
