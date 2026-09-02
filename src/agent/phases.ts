/**
 * The host-owned phase state machine (Constitution Article IV).
 *
 * This module contains no security reasoning. It owns one question only: which
 * phase may follow which, and on what condition. Keeping that separate from the
 * analysis steps is what stops a persuasive model response from becoming a
 * control-flow instruction.
 *
 * The phase order is `MODEL_PHASE_SEQUENCE` in `src/schemas/phases.ts`, and it
 * is a host constant. No method here accepts a model-proposed next phase, so
 * the model cannot reorder, skip, or re-enter phases: it can only produce an
 * artifact for the phase the host is currently running, and a schema-valid
 * artifact is the sole thing that advances the machine.
 *
 * `evaluate` is deliberately absent. It is not a member of `ModelPhase`, it has
 * no artifact schema, and there is no transition into it from anywhere in this
 * file, so no model-facing code path can reach the scoring stage.
 *
 * Deliberately not implemented: plan.md describes `revise` as entered by host
 * decision on observed compilation or execution results, which implies a
 * conditional `execute → revise → execute` cycle. Phase 9 owns that design, and
 * inventing the edges now would mean guessing at a graph the specification has
 * not settled. Until then the machine runs the documented linear order, and
 * there are no backward transitions at all.
 */
import {
  HOST_ONLY_PHASE,
  MODEL_PHASE_SEQUENCE,
  nextPhase,
  type ModelPhase,
} from '../schemas/phases.js';

export class PhaseTransitionError extends Error {
  override readonly name = 'PhaseTransitionError';
}

/** Why the machine stopped, when it is no longer running. */
export type PhaseMachineStatus = 'running' | 'completed' | 'halted';

export const FIRST_PHASE: ModelPhase = MODEL_PHASE_SEQUENCE[0];
export const FINAL_PHASE: ModelPhase = MODEL_PHASE_SEQUENCE[
  MODEL_PHASE_SEQUENCE.length - 1
] as ModelPhase;

/** True for the host-only stage, which is never a model phase. */
export function isHostOnlyPhase(candidate: string): boolean {
  return candidate === HOST_ONLY_PHASE;
}

/** True when `candidate` names a phase the model may be asked to produce. */
export function isModelPhase(candidate: string): candidate is ModelPhase {
  return (MODEL_PHASE_SEQUENCE as readonly string[]).includes(candidate);
}

/**
 * The one legal transition out of a phase.
 *
 * Returning a single successor rather than a set is the point: there is no
 * branch for a caller to influence.
 */
export function legalSuccessor(phase: ModelPhase): ModelPhase | undefined {
  return nextPhase(phase);
}

export interface PhaseCompletion {
  readonly phase: ModelPhase;
  readonly degraded: boolean;
}

export class PhaseMachine {
  #current: ModelPhase = FIRST_PHASE;
  #status: PhaseMachineStatus = 'running';
  readonly #completed: PhaseCompletion[] = [];

  get current(): ModelPhase {
    return this.#current;
  }

  get status(): PhaseMachineStatus {
    return this.#status;
  }

  get isTerminal(): boolean {
    return this.#status !== 'running';
  }

  /** Phases finished so far, in order, each flagged if it degraded. */
  completed(): readonly PhaseCompletion[] {
    return [...this.#completed];
  }

  /** Phases that exhausted their validation budget, for the report. */
  degradedPhases(): readonly ModelPhase[] {
    return this.#completed.filter((entry) => entry.degraded).map((entry) => entry.phase);
  }

  /**
   * Advance out of the current phase.
   *
   * `validArtifact` is the gate. It is set by the host validator after Zod has
   * accepted the artifact, never by anything the model said about its own
   * output, so an invalid artifact cannot advance the machine.
   */
  advance(options: { validArtifact: boolean }): ModelPhase | undefined {
    this.#assertRunning();

    if (!options.validArtifact) {
      throw new PhaseTransitionError(
        `Cannot advance out of ${this.#current}: no schema-valid artifact was produced.`,
      );
    }

    this.#completed.push({ phase: this.#current, degraded: false });

    const successor = legalSuccessor(this.#current);
    if (successor === undefined) {
      this.#status = 'completed';
      return undefined;
    }

    this.#current = successor;
    return successor;
  }

  /**
   * Record that the current phase exhausted its validation budget.
   *
   * A degraded phase does not advance. The run halts and the phase is reported
   * as degraded, because continuing would build later phases on an artifact the
   * host never accepted, and fabricating a placeholder artifact to keep going
   * would be worse still.
   */
  markDegraded(): void {
    this.#assertRunning();
    this.#completed.push({ phase: this.#current, degraded: true });
    this.#status = 'halted';
  }

  /** Stop the run without claiming the current phase succeeded. */
  halt(): void {
    this.#assertRunning();
    this.#status = 'halted';
  }

  /**
   * Reject a model-proposed phase.
   *
   * The machine never consults a model-supplied phase name. This exists so a
   * caller that receives one — for instance a stray `phase` field on an
   * artifact — has a single typed place to refuse it.
   */
  assertExpectedPhase(candidate: string): void {
    if (isHostOnlyPhase(candidate)) {
      throw new PhaseTransitionError(
        `${HOST_ONLY_PHASE} is a host-only stage and is never model-facing.`,
      );
    }
    if (!isModelPhase(candidate)) {
      throw new PhaseTransitionError(`Unknown phase: ${candidate}`);
    }
    if (candidate !== this.#current) {
      throw new PhaseTransitionError(
        `Artifact declares phase ${candidate}, but the host is running ${this.#current}. ` +
          'The model does not choose the phase.',
      );
    }
  }

  #assertRunning(): void {
    if (this.#status !== 'running') {
      throw new PhaseTransitionError(
        `Phase machine is ${this.#status}; no further transition is legal.`,
      );
    }
  }
}
