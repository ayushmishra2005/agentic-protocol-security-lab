/**
 * Host-side artifact validation with a bounded retry budget.
 *
 * Zod is the authoritative gate. The provider in this SDK version can be asked
 * for structured output via `output_config.format`, and the tool descriptors
 * are sent with `strict: true`, but neither is treated as sufficient: both are
 * assurances from the untrusted side of the boundary, and Article IV requires
 * the host to decide what counts as a valid artifact. So every artifact is
 * parsed here regardless of what the provider promised.
 *
 * The retry budget is bounded and host-owned. When it is exhausted the phase is
 * marked degraded — the machine stops rather than looping, and no placeholder
 * artifact is ever synthesised to keep the run moving.
 */
import type { z } from 'zod';

import { MODEL_LOOP_DEFAULTS } from '../config.js';
import { schemaForPhase, type ModelPhase } from '../schemas/phases.js';
import { redact } from '../security/redact.js';

export class ArtifactValidationError extends Error {
  override readonly name = 'ArtifactValidationError';
}

/** Cap on feedback returned to the model, so an error can never carry a payload. */
const MAX_ISSUES = 20;
const MAX_ISSUE_CHARS = 300;

export interface ValidationSuccess<P extends ModelPhase> {
  readonly ok: true;
  readonly phase: P;
  readonly artifact: z.infer<ReturnType<typeof schemaForPhase<P>>>;
}

export interface ValidationFailure {
  readonly ok: false;
  readonly phase: ModelPhase;
  /** Sanitised, bounded messages safe to show the model on a retry. */
  readonly issues: readonly string[];
}

export type ValidationOutcome<P extends ModelPhase> = ValidationSuccess<P> | ValidationFailure;

/**
 * Render Zod issues as short, sanitised strings.
 *
 * Only the path and the rule that failed are kept. The offending value is
 * deliberately never echoed: it is model-controlled text, and reflecting it
 * back into the next prompt would hand a model a channel it did not otherwise
 * have. Redaction runs as well, so a credential that somehow reached an
 * artifact cannot travel outward through a validation message.
 */
function describeIssues(error: z.ZodError): readonly string[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return redact(`${path}: ${issue.message}`).slice(0, MAX_ISSUE_CHARS);
  });
}

/**
 * Parse text or a value as the artifact for exactly `phase`.
 *
 * The phase schema is selected by the host from the phase the host is running.
 * A `phase` discriminant inside the artifact must match it, so an artifact
 * produced for one phase cannot satisfy another.
 */
export function validateArtifact<P extends ModelPhase>(
  phase: P,
  candidate: unknown,
): ValidationOutcome<P> {
  let value: unknown = candidate;

  if (typeof candidate === 'string') {
    try {
      value = JSON.parse(candidate);
    } catch {
      return { ok: false, phase, issues: ['<root>: artifact is not valid JSON'] };
    }
  }

  const result = schemaForPhase(phase).safeParse(value);
  if (!result.success) {
    return { ok: false, phase, issues: describeIssues(result.error) };
  }

  return {
    ok: true,
    phase,
    artifact: result.data as ValidationSuccess<P>['artifact'],
  };
}

export type ValidationRunOutcome<P extends ModelPhase> =
  | { readonly status: 'valid'; readonly artifact: ValidationSuccess<P>['artifact'] }
  | { readonly status: 'degraded'; readonly attempts: number; readonly issues: readonly string[] };

/**
 * Attempt to obtain a valid artifact within a fixed budget.
 *
 * `produce` is called with the issues from the previous attempt so a caller may
 * feed sanitised feedback back to the model. The budget counts attempts, not
 * successes, so a model that keeps returning malformed output cannot extend the
 * loop: after `maxAttempts` the phase is degraded and the caller stops.
 */
export async function validateWithRetry<P extends ModelPhase>(
  phase: P,
  produce: (attempt: number, previousIssues: readonly string[]) => Promise<unknown>,
  options: {
    readonly maxAttempts?: number;
    /**
     * Host checks that a schema cannot express. Zod can confirm an evidence
     * identifier is well-formed, but only the evidence store knows whether it
     * resolves, so that check runs here and its issues share the same budget.
     */
    readonly additionalChecks?: (artifact: unknown) => readonly string[];
  } = {},
): Promise<ValidationRunOutcome<P>> {
  const maxAttempts = options.maxAttempts ?? MODEL_LOOP_DEFAULTS.maxValidationAttempts;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new ArtifactValidationError(`Invalid validation budget: ${String(maxAttempts)}`);
  }

  let issues: readonly string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = await produce(attempt, issues);
    const outcome = validateArtifact(phase, candidate);
    if (!outcome.ok) {
      issues = outcome.issues;
      continue;
    }

    const extra = options.additionalChecks?.(outcome.artifact) ?? [];
    if (extra.length === 0) {
      return { status: 'valid', artifact: outcome.artifact };
    }
    // Schema-valid but rejected by a host check. It does not advance the phase.
    issues = extra.slice(0, MAX_ISSUES).map((issue) => redact(issue).slice(0, MAX_ISSUE_CHARS));
  }

  return { status: 'degraded', attempts: maxAttempts, issues };
}
