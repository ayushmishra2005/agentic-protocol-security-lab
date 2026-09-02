/**
 * The `threat_model` phase (T052).
 *
 * Consumes the validated `understand` and `inspect` artifacts. It does not go
 * back to the repository for fresh context of its own accord — if a fact was
 * not established by inspection, it is not available here, and the honest
 * response is to say so rather than to reason about source that was never read.
 * The tools remain available for a targeted follow-up read, and any such read
 * produces its own evidence like every other tool call.
 *
 * Scope is deliberately narrow: language-level authorisation and visibility in
 * the Daml source in front of it. Network topology, sequencer and mediator
 * behaviour, participant deployment, and library-level protocol concerns are
 * outside what this system inspects, so claims about them would be assertions
 * with nothing behind them.
 */
import type { PhaseDefinition } from './runPhase.js';

export const threatModelPhase: PhaseDefinition<'threat_model'> = {
  phase: 'threat_model',
  consumes: ['understand', 'inspect'],
  objective:
    'Build a threat model for the authorisation and visibility constructs found during inspection. ' +
    'For each threat, name the actor, the capability that actor would need, and the impact if the ' +
    'capability were exercised.',
  toolGuidance: [
    'Work from the validated artifacts above. If a specific claim needs a line of source you have',
    'not yet read, read that file with repo_read_file and cite the new evidence identifier.',
    '',
    'Stay within what this system can actually inspect: the Daml source of the target. Its',
    'authority model — signatories, observers, controllers, choice structure, party roles, and any',
    'propose/accept flow — is in scope. Ledger deployment topology, sequencer, mediator and',
    'participant-node security, and the internals of third-party libraries are not: nothing here has',
    'inspected them, so do not raise threats about them.',
  ].join('\n'),
  acceptance: [
    'threats: each with an id, the actor, the capability required, and the impact.',
    'Where a threat concerns a specific template, set the template field to the name as it appears ' +
      'in the source.',
    'evidence: identifiers for the tool calls that established the source facts a threat rests on.',
    'Separate the two kinds of statement in your wording. A source fact is something a tool result ' +
      'showed, and cites evidence. An inference is your reasoning about what that fact implies, and ' +
      'must be worded as a possibility. Say "would be able to" or "appears to permit", not "can" or ' +
      '"does", for anything that has not been executed.',
    'Nothing has been run against a ledger at this point, so no threat may be described as ' +
      'demonstrated, exploited, confirmed, or verified.',
  ],
};
