/**
 * The analysis pipeline: the six model-facing phases that precede test
 * generation, run in the order the host fixes here.
 *
 * The order is not read from a response, a config file, or an artifact. It is
 * this array, checked against the phase machine at every step, and the machine
 * independently refuses a transition that does not follow `MODEL_PHASE_SEQUENCE`.
 * A model cannot skip a phase because it never gets to name one.
 */
import type { ModelClient } from '../../model/client.js';
import type { UsageAccumulator } from '../../model/usage.js';
import type { ModelPhase } from '../../schemas/phases.js';
import type { ToolContext } from '../../tools/dispatch.js';
import type { LoopBudgets } from '../loop.js';
import { PhaseMachine } from '../phases.js';
import type { UntrustedFence } from '../prompt.js';
import { authSemanticsPhase } from './authSemantics.js';
import { invariantsPhase } from './invariants.js';
import { scenariosPhase } from './scenarios.js';
import { threatModelPhase } from './threatModel.js';
import { inspectPhase, understandPhase } from './understand.js';
import {
  runPhase,
  type PhaseDefinition,
  type RunPhaseResult,
  type ValidatedArtifact,
} from './runPhase.js';

export {
  runPhase,
  checkEvidenceResolvable,
  collectEvidenceIds,
  PHASE_BUDGETS,
} from './runPhase.js';
export type { PhaseDefinition, RunPhaseResult, ValidatedArtifact } from './runPhase.js';
export { understandPhase, inspectPhase } from './understand.js';
export { threatModelPhase } from './threatModel.js';
export { invariantsPhase } from './invariants.js';
export { authSemanticsPhase } from './authSemantics.js';
export { scenariosPhase } from './scenarios.js';

/** The Phase 8 chain, in host-fixed order. */
export const ANALYSIS_PHASES: readonly PhaseDefinition[] = [
  understandPhase,
  inspectPhase,
  threatModelPhase,
  invariantsPhase,
  authSemanticsPhase,
  scenariosPhase,
];

export interface RunAnalysisOptions {
  readonly client: ModelClient;
  readonly context: ToolContext;
  readonly targetPath: string;
  readonly machine?: PhaseMachine;
  readonly budgets?: LoopBudgets;
  readonly usage?: UsageAccumulator;
  readonly maxValidationAttempts?: number;
  readonly fence?: UntrustedFence;
  readonly signal?: AbortSignal;
}

export interface AnalysisResult {
  readonly artifacts: readonly ValidatedArtifact[];
  readonly results: readonly RunPhaseResult[];
  /** The phase that degraded, if the run stopped short. */
  readonly degradedAt?: ModelPhase;
  readonly machine: PhaseMachine;
}

/**
 * Run the analysis chain until it completes or a phase degrades.
 *
 * A degraded phase stops the run. Continuing would mean building a threat model
 * on an understanding the host rejected, and the artifacts that follow would
 * inherit that without any record of it in their own contents.
 */
export async function runAnalysis(options: RunAnalysisOptions): Promise<AnalysisResult> {
  const machine = options.machine ?? new PhaseMachine();
  const artifacts: ValidatedArtifact[] = [];
  const results: RunPhaseResult[] = [];

  for (const definition of ANALYSIS_PHASES) {
    // The host and the machine must agree on what is running. Disagreement is a
    // host bug rather than a model action, and the machine throws on it.
    machine.assertExpectedPhase(definition.phase);

    const result = await runPhase({
      definition,
      client: options.client,
      context: options.context,
      targetPath: options.targetPath,
      priorArtifacts: artifacts,
      ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
      ...(options.usage === undefined ? {} : { usage: options.usage }),
      ...(options.maxValidationAttempts === undefined
        ? {}
        : { maxValidationAttempts: options.maxValidationAttempts }),
      ...(options.fence === undefined ? {} : { fence: options.fence }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    results.push(result);

    if (result.status === 'degraded') {
      machine.markDegraded();
      return { artifacts, results, degradedAt: definition.phase, machine };
    }

    artifacts.push({ phase: definition.phase, artifact: result.artifact });
    machine.advance({ validArtifact: true });
  }

  return { artifacts, results, machine };
}
