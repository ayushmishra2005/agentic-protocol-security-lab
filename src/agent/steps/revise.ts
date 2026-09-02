/**
 * The bounded `revise` phase (T064).
 *
 * The host decides that this phase runs. `executeGeneratedTests` computes
 * `revisionRequired` from compile and execution evidence, `PhaseMachine`
 * checks it against a budget it owns, and only then is the model asked for a
 * correction. Nothing in a model response reaches that decision: there is no
 * artifact field for it, `revise` cannot be named as a next phase, and the
 * revision counter and its maximum live on the machine rather than on anything
 * the model can write to.
 *
 * Two conditions and no others bring the run here:
 *
 *   compilation_failure       the generated Script did not build.
 *   contradicted_expectation  it ran, and did the opposite of what it declared
 *                             it would do before running.
 *
 * A test that exposed a vulnerability is not a reason to revise. Neither is a
 * test that failed exactly as it predicted it would — that is the whole point
 * of an adversarial test, and re-rolling it until it comes out differently
 * would be a way of arguing with evidence.
 *
 * What the model receives here is narrow by construction: its own previous
 * artifact, the reason the host is asking, and redacted compiler or test
 * diagnostics. It does not receive the expectation file, the oracle, scorer
 * data, host filesystem contents, or anything else the earlier phases were not
 * allowed to see either. Diagnostics come from the evidence store, so they have
 * already been through redaction and truncation.
 */
import type { GeneratedTest, RevisionReason } from '../../schemas/phases.js';
import type { PhaseDefinition } from './runPhase.js';

/** Upper bound on diagnostics text handed back for a correction. */
const MAX_DIAGNOSTIC_CHARS = 4_000;

export interface RevisionRequest {
  readonly reason: RevisionReason;
  readonly attempt: number;
  /** The tests as last submitted, so the model corrects its own work. */
  readonly previousTests: readonly GeneratedTest[];
  /** Redacted compiler output, when the reason is a compilation failure. */
  readonly compileDiagnostics?: string;
  /** Redacted per-test failure detail, when the reason is a contradiction. */
  readonly failureDetail?: ReadonlyMap<string, string>;
}

/**
 * Decide the revision reason from what was observed.
 *
 * Host-side and total: a caller cannot end up here without one of the two
 * documented conditions holding.
 */
export function revisionReasonFor(
  outcomes: readonly { readonly outcome: string }[],
): RevisionReason | undefined {
  if (outcomes.some((entry) => entry.outcome === 'compile_failed')) return 'compilation_failure';
  if (outcomes.some((entry) => entry.outcome === 'executed_contradiction')) {
    return 'contradicted_expectation';
  }
  return undefined;
}

/**
 * The context block for a revision, as trusted host text.
 *
 * Assembled here rather than in the prompt builder so there is one place to
 * check what a revision is told, and the diagnostics are truncated on the way
 * in rather than trusted to be short.
 */
export function buildRevisionContext(request: RevisionRequest): string {
  const lines: string[] = [
    `The host is requesting a revision. Reason: ${request.reason}.`,
    `This is revision attempt ${String(request.attempt)}.`,
    '',
    'Your previous submission, unchanged:',
    JSON.stringify(request.previousTests),
  ];

  if (request.reason === 'compilation_failure') {
    lines.push(
      '',
      'The generated package did not compile. Compiler output:',
      (request.compileDiagnostics ?? '(no diagnostics were captured)').slice(
        0,
        MAX_DIAGNOSTIC_CHARS,
      ),
      '',
      'Fix the code so it compiles. Do not change what the test is trying to establish, and do not',
      'change expectedOutcome to make a compile error go away — the two are unrelated.',
    );
    return lines.join('\n');
  }

  lines.push('', 'These tests ran, and the result contradicted the expectation you declared:');
  for (const test of request.previousTests) {
    const detail = request.failureDetail?.get(test.id);
    lines.push(
      `- ${test.id} (${test.scriptName}:${test.entryPoint}) declared ${test.expectedOutcome}.`,
      ...(detail === undefined
        ? []
        : [`  Observed failure: ${detail.slice(0, MAX_DIAGNOSTIC_CHARS)}`]),
    );
  }
  lines.push(
    '',
    'A contradiction means the analysis was wrong about the target, the Script does not test what',
    'it intended, or the expectation was misjudged. Work out which, then submit a corrected test.',
    'If you now believe the earlier expectation was wrong, say so in changes and set the',
    'expectation you actually hold — but only because the evidence says so, never to make the',
    'result agree with the previous attempt.',
  );

  return lines.join('\n');
}

export const revisePhase: PhaseDefinition<'revise'> = {
  phase: 'revise',
  consumes: ['scenarios', 'generate_tests', 'execute'],
  objective:
    'Correct the generated tests in response to what the host observed when it compiled and ran ' +
    'them, and submit the corrected versions in full.',
  toolGuidance: [
    'The host has already run your previous tests; the reason it is asking for a revision, and the',
    'relevant compiler or test output, are in the validated execute artifact above and in the',
    'revision context supplied with it.',
    '',
    'Re-read target source with repo_read_file where the diagnostics point at something you got',
    'wrong about the target, and cite that evidence.',
    '',
    'Submit whole modules, not patches. Keep the same scriptName for a test you are correcting: the',
    'host writes it to the same host-chosen destination, replacing the previous version. Earlier',
    'attempts stay in the evidence log either way.',
  ].join('\n'),
  acceptance: [
    'attempt: which revision this is, starting at 1.',
    'reason: the reason the host gave. Echo it; do not substitute your own.',
    'changes: what you changed and why, one entry per change.',
    'tests: the corrected tests in full, in the same shape as the generate_tests artifact.',
    'evidence: identifiers for anything you re-read while correcting.',
    'A revision is not an opportunity to restate an earlier result. Nothing here has been proven ' +
      'yet; the corrected test still has to run.',
  ],
};
