/**
 * Per-run usage accounting (Constitution Article I).
 *
 * Every number here is either reported by the provider or counted by the host.
 * Nothing is estimated. This module contains no tokeniser and no pricing table:
 * a token count the host guessed and a token count the provider billed are
 * different facts, and reporting the first as the second would be exactly the
 * kind of unsupported claim the constitution exists to prevent. Cost is not
 * computed because the current specification does not ask for it.
 *
 * The deterministic rule for optional provider fields: in this SDK version
 * `cache_creation_input_tokens` and `cache_read_input_tokens` are typed
 * `number | null`, and a `null` means the provider reported no such usage. A
 * null or absent value therefore contributes zero, and never causes the total
 * to become `NaN` or `undefined`.
 *
 * Counters are host-owned. The only way to move one is to complete a real
 * model call or a real tool dispatch; nothing in a model response can set,
 * reset, or decrement them.
 */
import type { Usage } from '@anthropic-ai/sdk/resources/messages';

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly modelCalls: number;
  readonly toolCallsRequested: number;
  readonly toolCallsDispatched: number;
  readonly toolCallsRefused: number;
}

function coerceProviderCount(value: number | null | undefined, field: string): number {
  if (value === null || value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) {
    throw new UsageError(`Provider reported an unusable ${field}: ${String(value)}`);
  }
  return value;
}

export class UsageAccumulator {
  #inputTokens = 0;
  #outputTokens = 0;
  #cacheReadInputTokens = 0;
  #cacheCreationInputTokens = 0;
  #modelCalls = 0;
  #toolCallsRequested = 0;
  #toolCallsDispatched = 0;
  #toolCallsRefused = 0;

  #add(current: number, delta: number, field: string): number {
    const next = current + delta;
    if (!Number.isSafeInteger(next)) {
      throw new UsageError(`Usage counter ${field} exceeded the exact integer range.`);
    }
    return next;
  }

  /** Record one provider response, using the provider's own numbers. */
  recordModelCall(usage: Usage): void {
    this.#inputTokens = this.#add(
      this.#inputTokens,
      coerceProviderCount(usage.input_tokens, 'input_tokens'),
      'inputTokens',
    );
    this.#outputTokens = this.#add(
      this.#outputTokens,
      coerceProviderCount(usage.output_tokens, 'output_tokens'),
      'outputTokens',
    );
    this.#cacheReadInputTokens = this.#add(
      this.#cacheReadInputTokens,
      coerceProviderCount(usage.cache_read_input_tokens, 'cache_read_input_tokens'),
      'cacheReadInputTokens',
    );
    this.#cacheCreationInputTokens = this.#add(
      this.#cacheCreationInputTokens,
      coerceProviderCount(usage.cache_creation_input_tokens, 'cache_creation_input_tokens'),
      'cacheCreationInputTokens',
    );
    this.#modelCalls = this.#add(this.#modelCalls, 1, 'modelCalls');
  }

  /** Record that the model asked for a tool, before the host acts on it. */
  recordToolRequested(): void {
    this.#toolCallsRequested = this.#add(this.#toolCallsRequested, 1, 'toolCallsRequested');
  }

  /**
   * Record the outcome of a tool request.
   *
   * Requested, dispatched and refused are tracked separately because the
   * evidence layer distinguishes them, and collapsing them would hide how often
   * the model asked for something it was not allowed to have.
   */
  recordToolOutcome(outcome: 'dispatched' | 'refused'): void {
    if (outcome === 'dispatched') {
      this.#toolCallsDispatched = this.#add(this.#toolCallsDispatched, 1, 'toolCallsDispatched');
      return;
    }
    this.#toolCallsRefused = this.#add(this.#toolCallsRefused, 1, 'toolCallsRefused');
  }

  /** Immutable snapshot of the current totals. */
  totals(): UsageTotals {
    return Object.freeze({
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      cacheReadInputTokens: this.#cacheReadInputTokens,
      cacheCreationInputTokens: this.#cacheCreationInputTokens,
      modelCalls: this.#modelCalls,
      toolCallsRequested: this.#toolCallsRequested,
      toolCallsDispatched: this.#toolCallsDispatched,
      toolCallsRefused: this.#toolCallsRefused,
    });
  }
}
