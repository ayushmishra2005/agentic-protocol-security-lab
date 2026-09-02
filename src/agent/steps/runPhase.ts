/**
 * The shared analysis-phase runner.
 *
 * Every Phase 8 step is the same procedure with different trusted text, so the
 * procedure lives here once and the steps supply only their objective,
 * acceptance requirements, tool guidance, and which prior artifacts they need.
 * There is no second loop and no second dispatch path: this calls the Phase 7
 * `runBoundedLoop`, which calls `runToolUse`, which calls the Phase 6
 * `dispatchTool`. A step module never touches a provider client and never
 * imports a tool implementation.
 *
 * Two host gates stand between a model response and an advanced phase:
 *
 *   1. Zod validation against the schema for the phase the host is running.
 *   2. Evidence resolvability. A schema-valid artifact can still cite
 *      `ev_0123456789abcdef`, which is well-formed and entirely made up. Only
 *      the evidence store knows which identifiers exist, so every reference is
 *      resolved against the records this run actually produced. This is the
 *      difference between Article I being a rule and Article I being enforced.
 *
 * Both gates share one bounded retry budget. Failing either does not advance
 * the phase, and exhausting the budget marks the phase degraded rather than
 * looping or fabricating an artifact.
 */
import { MODEL_LOOP_DEFAULTS } from '../../config.js';
import { EvidenceIdSchema } from '../../schemas/findings.js';
import type { ModelPhase } from '../../schemas/phases.js';
import type { ModelClient } from '../../model/client.js';
import { buildProviderTools } from '../../model/tools.js';
import type { UsageAccumulator } from '../../model/usage.js';
import type { ToolContext } from '../../tools/dispatch.js';
import { runBoundedLoop, type LoopBudgets, type LoopTranscript } from '../loop.js';
import { buildPhasePrompt, type UntrustedFence } from '../prompt.js';
import { validateWithRetry } from '../validate.js';

export class PhaseStepError extends Error {
  override readonly name = 'PhaseStepError';
}

/** The trusted, target-independent description of one analysis phase. */
export interface PhaseDefinition<P extends ModelPhase = ModelPhase> {
  readonly phase: P;
  readonly objective: string;
  readonly acceptance: readonly string[];
  readonly toolGuidance: string;
  /** Prior phases whose validated artifacts this phase needs, and only those. */
  readonly consumes: readonly ModelPhase[];
  /**
   * Consistency checks against earlier artifacts that a schema cannot express,
   * such as a scenario referencing an invariant that exists. Returns issues.
   */
  readonly crossChecks?: (
    artifact: unknown,
    priors: readonly ValidatedArtifact[],
  ) => readonly string[];
}

export interface ValidatedArtifact {
  readonly phase: ModelPhase;
  readonly artifact: unknown;
}

export interface RunPhaseOptions {
  readonly definition: PhaseDefinition;
  readonly client: ModelClient;
  readonly context: ToolContext;
  readonly targetPath: string;
  /** Artifacts validated in earlier phases, in phase order. */
  readonly priorArtifacts?: readonly ValidatedArtifact[];
  readonly budgets?: LoopBudgets;
  readonly usage?: UsageAccumulator;
  readonly maxValidationAttempts?: number;
  readonly fence?: UntrustedFence;
  readonly signal?: AbortSignal;
}

export type RunPhaseResult =
  | {
      readonly status: 'valid';
      readonly phase: ModelPhase;
      readonly artifact: unknown;
      readonly attempts: number;
      readonly transcripts: readonly LoopTranscript[];
    }
  | {
      readonly status: 'degraded';
      readonly phase: ModelPhase;
      readonly attempts: number;
      readonly issues: readonly string[];
      readonly transcripts: readonly LoopTranscript[];
    };

/**
 * Collect every evidence identifier reachable in an artifact.
 *
 * References appear at the artifact root and nested inside findings and
 * invariants, so the walk is generic rather than keyed to one shape. The
 * `evidenceId` field of an execute-phase result is picked up too, since it is
 * the same kind of claim.
 */
export function collectEvidenceIds(value: unknown): readonly string[] {
  const found: string[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (node === null || typeof node !== 'object') return;

    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'evidenceId' && typeof entry === 'string') {
        found.push(entry);
        continue;
      }
      walk(entry);
    }
  };

  walk(value);
  return found;
}

/**
 * Reject citations that do not resolve to a real record.
 *
 * A malformed identifier is reported separately from a well-formed one that
 * does not exist: the first is a formatting mistake, the second is a fabricated
 * citation, and they deserve different feedback.
 */
export function checkEvidenceResolvable(
  context: ToolContext,
  artifact: unknown,
): readonly string[] {
  const issues: string[] = [];

  for (const id of collectEvidenceIds(artifact)) {
    if (!EvidenceIdSchema.safeParse(id).success) {
      issues.push(`evidence: ${id} is not a well-formed evidence identifier`);
      continue;
    }
    if (!context.store.has(id)) {
      issues.push(
        `evidence: ${id} does not resolve to a tool invocation in this run. ` +
          'Cite only identifiers returned to you by a tool result.',
      );
    }
  }

  return issues;
}

/**
 * Run one analysis phase to a validated artifact, or to a degraded outcome.
 *
 * The host supplies the phase; nothing the model returns influences which
 * schema is used or which phase runs next.
 */
export async function runPhase(options: RunPhaseOptions): Promise<RunPhaseResult> {
  const { definition, context } = options;

  // Only the artifacts this phase declares it needs are carried forward. The
  // conversation that produced them is not: a phase reads validated output,
  // not the transcript of how it was reached.
  const required = new Set(definition.consumes);
  const priors = (options.priorArtifacts ?? []).filter((entry) => required.has(entry.phase));

  for (const needed of definition.consumes) {
    if (!priors.some((entry) => entry.phase === needed)) {
      throw new PhaseStepError(
        `Phase ${definition.phase} requires the validated ${needed} artifact, which was not supplied.`,
      );
    }
  }

  const transcripts: LoopTranscript[] = [];
  let attempts = 0;

  const outcome = await validateWithRetry(
    definition.phase,
    async (attempt, previousIssues) => {
      attempts = attempt;

      const prompt = buildPhasePrompt({
        phase: definition.phase,
        objective: definition.objective,
        acceptance: definition.acceptance,
        targetPath: options.targetPath,
        toolGuidance: definition.toolGuidance,
        priorArtifacts: priors,
        previousIssues,
        ...(options.fence === undefined ? {} : { fence: options.fence }),
      });

      const result = await runBoundedLoop({
        client: options.client,
        context,
        request: {
          system: prompt.system,
          messages: prompt.messages,
          tools: buildProviderTools(),
        },
        ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
        ...(options.usage === undefined ? {} : { usage: options.usage }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });

      transcripts.push(result.transcript);

      // A loop that ran out of budget produced no answer. Returning its partial
      // text would let a truncated run masquerade as a considered one, so the
      // attempt is failed explicitly instead.
      if (result.stopReason !== 'answered') {
        return { __loopStopReason: result.stopReason };
      }
      return result.text;
    },
    {
      ...(options.maxValidationAttempts === undefined
        ? {}
        : { maxAttempts: options.maxValidationAttempts }),
      additionalChecks: (artifact) => [
        ...checkEvidenceResolvable(context, artifact),
        ...(definition.crossChecks?.(artifact, priors) ?? []),
      ],
    },
  );

  if (outcome.status === 'valid') {
    return {
      status: 'valid',
      phase: definition.phase,
      artifact: outcome.artifact,
      attempts,
      transcripts,
    };
  }

  return {
    status: 'degraded',
    phase: definition.phase,
    attempts: outcome.attempts,
    issues: outcome.issues,
    transcripts,
  };
}

/** Default per-phase budgets. Host-owned; nothing in a response can raise them. */
export const PHASE_BUDGETS: LoopBudgets = {
  maxTurns: MODEL_LOOP_DEFAULTS.maxTurns,
  maxToolCalls: MODEL_LOOP_DEFAULTS.maxToolCalls,
  maxToolCallsPerTurn: MODEL_LOOP_DEFAULTS.maxToolCallsPerTurn,
};
