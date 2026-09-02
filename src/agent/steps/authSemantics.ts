/**
 * The `auth_semantics` phase (T054).
 *
 * Records the authorisation structure of the target as it is written: which
 * parties are signatories, which are observers, which control each choice, and
 * whether each choice consumes its contract.
 *
 * The distinction this phase has to hold is between two very different things
 * that read alike in prose. "In Daml, a choice's controllers must authorise its
 * exercise" is general knowledge from the model's training. "In this target,
 * Transfer names the custodian as controller" is a fact about the source, and
 * only the second can be evidenced. General knowledge may guide where to look;
 * it may not stand in for having looked. So every per-template entry must cite
 * the tool call that read the file it came from.
 *
 * The artifact schema carries a `heuristic` flag per template, which exists
 * because a later host-side extractor would be a heuristic rather than a
 * parser. Nothing in this phase parses Daml either: the model reads source and
 * reports it, which is likewise not authoritative parsing, so entries produced
 * this way are flagged accordingly.
 */
import type { PhaseDefinition } from './runPhase.js';

export const authSemanticsPhase: PhaseDefinition<'auth_semantics'> = {
  phase: 'auth_semantics',
  consumes: ['inspect', 'invariants'],
  objective:
    'Record the authorisation and visibility structure of each template you inspected: its ' +
    'signatories and observers, and for each choice its controllers, whether it is consuming, and ' +
    'any choice observers.',
  toolGuidance: [
    'Read the template definitions directly with repo_read_file before describing them. Cite the',
    'evidence identifier for each file you read.',
    '',
    'Report the parties as the source names them. If a signatory or controller is an expression',
    'rather than a plain field, record what the source says rather than resolving it yourself.',
    '',
    'Two kinds of statement must not be confused. What the Daml language does in general is',
    'background knowledge and is not evidence about this target. What this target declares is a',
    'source fact and must cite the read that showed it. Where the two disagree, or where the',
    'language-level consequence of a declaration is something you are not certain of, say so',
    'plainly: a later phase executes real tests against the pinned toolchain, and an acknowledged',
    'uncertainty is resolved there. An asserted certainty is not.',
  ].join('\n'),
  acceptance: [
    'templates: one entry per template you actually read, with its name as written in the source.',
    'For each: signatories, observers, and choices with controllers, consuming, and choice observers ' +
      'where present.',
    'heuristic: set true for every entry derived by reading source rather than by authoritative ' +
      'parsing. Reading a file is not parsing it.',
    'evidence: identifiers for the reads that produced these entries.',
    'Do not state that any party succeeded or failed at exercising anything. No choice has been ' +
      'exercised; nothing has been executed. Behaviour is established in a later phase, not here.',
  ],
};
