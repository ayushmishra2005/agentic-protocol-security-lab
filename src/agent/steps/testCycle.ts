/**
 * The generate/execute/revise cycle.
 *
 * This is where the host's authority over the loop is most visible. The model
 * writes tests and, when asked, corrects them. Everything else — whether the
 * tests run, whether the result warrants another attempt, how many attempts
 * remain, and when the cycle ends — is decided here and in `PhaseMachine`, from
 * evidence the toolchain produced.
 *
 * The order is fixed and the exit conditions are exhaustive:
 *
 *   generate_tests  model writes Scripts; host validates them
 *   execute         host writes, compiles and runs them; no model turn
 *   revise          only if the host observed a compile failure or a
 *                   contradiction, and only while budget remains
 *
 * There is no path from a model response into the branch. `revisionRequired`
 * comes from `executeGeneratedTests`, the budget lives on the machine, and the
 * loop below cannot run more times than the machine allows because the machine
 * is what returns the next phase.
 */
import type { ModelClient } from '../../model/client.js';
import type { UsageAccumulator } from '../../model/usage.js';
import {
  GenerateTestsArtifactSchema,
  ReviseArtifactSchema,
  type ExecuteArtifact,
  type GeneratedTest,
} from '../../schemas/phases.js';
import type { ToolContext } from '../../tools/dispatch.js';
import type { LoopBudgets } from '../loop.js';
import type { PhaseMachine } from '../phases.js';
import { validateArtifact } from '../validate.js';
import { executeGeneratedTests, type ExecutionContext, type ExecutionOutcome } from './execute.js';
import { generateTestsPhase } from './generateTests.js';
import { buildRevisionContext, revisePhase, revisionReasonFor } from './revise.js';
import { runPhase, type RunPhaseResult, type ValidatedArtifact } from './runPhase.js';

export class TestCycleError extends Error {
  override readonly name = 'TestCycleError';
}

export interface TestCycleOptions {
  readonly client: ModelClient;
  /** Tool context for the model's own reads: the analysis view. */
  readonly context: ToolContext;
  /** Host-side execution context: the run workspace, boundary and tools. */
  readonly execution: ExecutionContext;
  readonly machine: PhaseMachine;
  readonly targetPath: string;
  /** Validated Phase 8 artifacts. */
  readonly priorArtifacts: readonly ValidatedArtifact[];
  readonly budgets?: LoopBudgets;
  readonly usage?: UsageAccumulator;
  readonly maxValidationAttempts?: number;
  readonly signal?: AbortSignal;
}

export interface TestAttempt {
  readonly attempt: number;
  readonly tests: readonly GeneratedTest[];
  readonly execution: ExecuteArtifact;
  readonly revisionRequired: boolean;
  readonly compileEvidenceId: string;
  readonly runEvidenceId?: string;
}

export interface TestCycleResult {
  readonly attempts: readonly TestAttempt[];
  /** Revisions the host ordered. Never more than the machine's budget. */
  readonly revisions: number;
  /** True when revision was still required after the budget ran out. */
  readonly revisionExhausted: boolean;
  /** The last execution artifact. What the report is entitled to describe. */
  readonly finalExecution: ExecuteArtifact;
  readonly phaseResults: readonly RunPhaseResult[];
  /** Degraded when the model could not produce a valid artifact in budget. */
  readonly degradedAt?: 'generate_tests' | 'revise';
}

export async function runTestCycle(options: TestCycleOptions): Promise<TestCycleResult> {
  const { machine } = options;
  machine.assertExpectedPhase('generate_tests');

  const phaseResults: RunPhaseResult[] = [];
  const attempts: TestAttempt[] = [];

  const generated = await runPhase({
    definition: generateTestsPhase,
    client: options.client,
    context: options.context,
    targetPath: options.targetPath,
    priorArtifacts: options.priorArtifacts,
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
    ...(options.maxValidationAttempts === undefined
      ? {}
      : { maxValidationAttempts: options.maxValidationAttempts }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  phaseResults.push(generated);

  if (generated.status === 'degraded') {
    machine.markDegraded();
    throw new TestCycleError('The model produced no schema-valid generated-test artifact.');
  }

  let tests = GenerateTestsArtifactSchema.parse(generated.artifact).tests;
  const carried: ValidatedArtifact[] = [
    ...options.priorArtifacts,
    { phase: 'generate_tests', artifact: generated.artifact },
  ];

  machine.advance({ validArtifact: true });

  let attempt = 1;
  let outcome: ExecutionOutcome | undefined;

  for (;;) {
    machine.assertExpectedPhase('execute');
    outcome = await executeGeneratedTests({ context: options.execution, tests, attempt });

    // The host built this artifact, and it is still validated against the
    // schema before it advances anything. A host bug should fail loudly here
    // rather than propagate into a report.
    const validated = validateArtifact('execute', outcome.artifact);
    if (!validated.ok) {
      throw new TestCycleError(
        `Host-built execute artifact failed its own schema: ${validated.issues.join('; ')}`,
      );
    }

    attempts.push({
      attempt,
      tests,
      execution: outcome.artifact,
      revisionRequired: outcome.revisionRequired,
      compileEvidenceId: outcome.compileEvidenceId,
      ...(outcome.runEvidenceId === undefined ? {} : { runEvidenceId: outcome.runEvidenceId }),
    });

    const next = machine.advance({
      validArtifact: true,
      revisionRequired: outcome.revisionRequired,
    });

    // `report` is reached both when nothing needed revising and when the budget
    // ran out; the machine records which, and the caller can tell them apart.
    if (next !== 'revise') break;

    const reason = revisionReasonFor(outcome.artifact.results);
    if (reason === undefined) {
      throw new TestCycleError('The machine entered revise without a documented reason.');
    }

    const revised = await runPhase({
      definition: revisePhase,
      client: options.client,
      context: options.context,
      targetPath: options.targetPath,
      priorArtifacts: [...carried, { phase: 'execute', artifact: outcome.artifact }],
      hostContext: buildRevisionContext({
        reason,
        attempt,
        previousTests: tests,
        compileDiagnostics: outcome.compileDiagnostics,
        failureDetail: outcome.failureDetail,
      }),
      ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
      ...(options.usage === undefined ? {} : { usage: options.usage }),
      ...(options.maxValidationAttempts === undefined
        ? {}
        : { maxValidationAttempts: options.maxValidationAttempts }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    phaseResults.push(revised);

    if (revised.status === 'degraded') {
      // A revision that never validated leaves the last real execution as the
      // run's final observation. Nothing is fabricated to replace it.
      machine.markDegraded();
      return {
        attempts,
        revisions: machine.revisions,
        revisionExhausted: machine.revisionExhausted,
        finalExecution: outcome.artifact,
        phaseResults,
        degradedAt: 'revise',
      };
    }

    tests = ReviseArtifactSchema.parse(revised.artifact).tests;
    attempt += 1;
    machine.advance({ validArtifact: true });
  }

  return {
    attempts,
    revisions: machine.revisions,
    revisionExhausted: machine.revisionExhausted,
    finalExecution: outcome.artifact,
    phaseResults,
  };
}
