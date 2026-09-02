/**
 * The `generate_tests` phase (T061).
 *
 * Turns validated scenarios into Daml Scripts that try to violate the stated
 * invariants. The model writes the source; it does not write the file. The
 * artifact carries the script text and a module name, and after host validation
 * the host writes it through the write boundary at a path the host chose. There
 * is no destination field in the schema and no write tool in the registry, so
 * "generate a test" is never a filesystem primitive.
 *
 * Two things must be right before anything runs.
 *
 * First, the expectation has to be declared *before* execution and then left
 * alone. `expectedOutcome` is what the host will compare the JUnit result
 * against to decide whether the run learned something or the test was simply
 * wrong. If the model could restate its expectation after seeing the result,
 * every run would agree with itself and the comparison would mean nothing.
 *
 * Second, none of the benchmark's own answers may be in scope. The scenarios,
 * invariants and auth semantics this phase consumes were derived by earlier
 * phases from source the model read itself; the expectation file and the oracle
 * package are absent from the execution workspace entirely, not merely
 * unmentioned here.
 *
 * The Daml guidance below is pinned to the 3.5.5 API this project verified. It
 * names no template, choice or party from any fixture: those come from the
 * validated artifacts, which came from source evidence.
 */
import type { PhaseDefinition } from './runPhase.js';

export const generateTestsPhase: PhaseDefinition<'generate_tests'> = {
  phase: 'generate_tests',
  consumes: ['invariants', 'auth_semantics', 'scenarios'],
  objective:
    'Write a Daml Script for each scenario that attempts the misuse it describes, and declare, ' +
    'before it runs, what the ledger should do if the invariant holds.',
  toolGuidance: [
    'Write complete, self-contained modules. Each one is compiled against the target package as a',
    'data dependency, so import the target modules by the names you saw in the source.',
    '',
    'Use the Daml 3.5.5 Script API:',
    '- `allocateParty` for the parties the scenario needs.',
    '- `submit party do ...` for a submission expected to succeed.',
    '- For a submission expected to be rejected, use `trySubmit` and match the `SubmitError`.',
    '  When the point is authorisation specifically, match the `AuthorizationError` case rather',
    '  than accepting any failure: a type error and a missing authorisation both fail, and only one',
    '  of them is a security result.',
    '- For multi-party submissions use `submit (actAs [...] <> readAs [...])`. Do not use the',
    '  deprecated `submitMulti` family; it is not available on this SDK.',
    '- A bare `submitMustFail` is acceptable only where the kind of failure genuinely does not',
    '  matter. It does not establish an authorisation property on its own.',
    '',
    'Name each module with a capitalised identifier and nothing else: no path, no dots, no',
    'extension. The host derives the filename and its location; you do not choose where anything is',
    'written, and a name containing a separator will be refused.',
    '',
    'You may re-read target source with repo_read_file to get a field or constructor right, and',
    'should cite the evidence for anything you looked up.',
  ].join('\n'),
  acceptance: [
    'tests: one entry per scenario you are testing, each with id, scenarioId, scriptName, ' +
      'entryPoint, source, property, expectedOutcome and expectedBehavior.',
    'scriptName is the module name declared at the top of source. entryPoint is the Script binding ' +
      'inside it that should run. They must match the source exactly, or the host cannot run it.',
    'expectedOutcome is what you predict the test run will report: script_passes if the Script ' +
      'completes without an assertion failing, script_fails if you expect it to fail. Decide this ' +
      'now, on the evidence you have. The host compares the real result against it, and a ' +
      'mismatch means the analysis was wrong about the target, which is a useful thing to learn.',
    'expectedBehavior states the same prediction at the ledger level: which submission is accepted ' +
      'or rejected, and with what kind of error.',
    'evidence: identifiers for the source you relied on when writing the Script.',
    'Do not describe any test as passing, failing, confirming or proving anything. Nothing has run.',
  ],
};
