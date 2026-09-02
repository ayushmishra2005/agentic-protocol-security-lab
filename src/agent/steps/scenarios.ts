/**
 * The `scenarios` phase (T055).
 *
 * The handoff to Phase 9. Each scenario is a candidate adversarial test: a
 * party, a setup, an attempted operation, and the outcome the invariant says
 * should follow. Phase 9 turns these into Daml Scripts and runs them against
 * the pinned toolchain; whether the ledger actually behaves as the invariant
 * requires is decided there, by execution, and not here.
 *
 * That is the line this phase must not cross. A scenario describes an attempt
 * worth making. It is not a claim that the attempt succeeds. The schema keeps
 * scenarios structurally separate from findings — a scenario has no `state`
 * field and cannot be marked confirmed — so a scenario cannot be mistaken for a
 * result no matter how it is worded.
 */
import { InvariantsArtifactSchema, ScenariosArtifactSchema } from '../../schemas/phases.js';
import type { PhaseDefinition, ValidatedArtifact } from './runPhase.js';

/**
 * A scenario whose `invariantId` matches nothing is a test with no purpose, and
 * the schema cannot catch it because the identifier is well-formed. The check
 * runs against the validated invariants artifact instead.
 */
function scenariosReferenceRealInvariants(
  artifact: unknown,
  priors: readonly ValidatedArtifact[],
): readonly string[] {
  const scenarios = ScenariosArtifactSchema.safeParse(artifact);
  if (!scenarios.success) return [];

  const prior = priors.find((entry) => entry.phase === 'invariants');
  const invariants = InvariantsArtifactSchema.safeParse(prior?.artifact);
  if (!invariants.success) return [];

  const known = new Set(invariants.data.invariants.map((invariant) => invariant.id));
  return scenarios.data.scenarios
    .filter((scenario) => !known.has(scenario.invariantId))
    .map(
      (scenario) =>
        `scenarios: scenario ${scenario.id} targets invariant ${scenario.invariantId}, ` +
        'which is not in the validated invariants artifact.',
    );
}

export const scenariosPhase: PhaseDefinition<'scenarios'> = {
  phase: 'scenarios',
  consumes: ['threat_model', 'invariants', 'auth_semantics'],
  crossChecks: scenariosReferenceRealInvariants,
  objective:
    'Enumerate candidate misuse scenarios: concrete attempts that would violate one of the stated ' +
    'invariants if the target permits them. Each must be specific enough that a Daml Script could ' +
    'be written directly from it.',
  toolGuidance: [
    'Work from the validated artifacts above. Re-read source with repo_read_file only where a',
    'scenario needs a detail you do not have, such as a field required to create a contract.',
    '',
    'A scenario is specific enough when it says which parties must exist, what contract must be',
    'created and with which parties in which roles, which choice is then exercised and by whom, and',
    'what the ledger is expected to do — accept the exercise, or reject it with an authorisation',
    'error. Use the template, choice and party role names from the source.',
    '',
    'Each scenario must reference the invariant it targets by its identifier, so the later phase',
    'knows what the test is for.',
  ].join('\n'),
  acceptance: [
    'scenarios: each with an id, the invariantId it targets, and a description containing the ' +
      'parties, the setup, the attempted operation, and the expected ledger response.',
    'invariantId must be the id of an invariant from the validated invariants artifact. Do not ' +
      'invent one.',
    'evidence: identifiers for the tool calls behind the source details the scenario depends on.',
    'Write each scenario as an attempt to be tested, not as a result. Nothing has been executed, so ' +
      'no scenario may say that a party succeeded, that an exploit works, or that a vulnerability is ' +
      'confirmed. The correct form is what will be attempted and what should happen if the invariant ' +
      'holds.',
  ],
};
