/**
 * The `invariants` phase (T053).
 *
 * Turns the threat model into security properties precise enough that a later
 * phase can write a Daml Script whose whole purpose is to violate one. That
 * precision is the deliverable. "Authorisation should be correct" cannot fail a
 * test, so it cannot pass one either, and an invariant that cannot be targeted
 * is not worth carrying into test generation.
 *
 * The guidance is written to be target-agnostic. It names no template, choice,
 * party, or finding class from any fixture: the model has to derive those from
 * source evidence, because a hint supplied by the host would be measuring the
 * host's knowledge rather than the model's analysis. The fixture expectation
 * file is unreadable through the repository tools by policy, which is the
 * mechanism behind that; this text just does not undermine it.
 */
import type { PhaseDefinition } from './runPhase.js';

export const invariantsPhase: PhaseDefinition<'invariants'> = {
  phase: 'invariants',
  consumes: ['inspect', 'threat_model'],
  objective:
    'State the security properties that must hold for the constructs you inspected, in a form a ' +
    'later adversarial test can attempt to violate.',
  toolGuidance: [
    'Work from the validated artifacts above; read further source with repo_read_file only if a',
    'specific property needs it, and cite the evidence.',
    '',
    'An invariant is testable when a reader can tell, from the statement alone, exactly what',
    'operation to attempt, as which party, and what the ledger must do in response. Name the',
    'template and choice as they appear in the source you read, and name the role in the terms the',
    'source uses. Statements of the shape "only <role> may successfully exercise <Template>.<Choice>"',
    'or "<role> must not be able to observe <Template>" are targetable; "access control must be',
    'correct" is not.',
    '',
    'Classify each invariant with a lower_snake_case class describing the kind of property at stake.',
    'Derive the class from what you observed. Do not assume a fixed vocabulary.',
  ].join('\n'),
  acceptance: [
    'invariants: each with an id, a class, and a statement naming the construct and the role.',
    'Set template and choice to the names as they appear in the source.',
    'evidence: identifiers for the tool calls that showed the construct the invariant is about.',
    'An invariant states what must hold. It does not state whether it currently holds — that is ' +
      'decided later by execution, not here.',
    'Do not restate a threat as an invariant. A threat is what an actor might do; an invariant is ' +
      'the property that would be broken if they did.',
  ],
};
