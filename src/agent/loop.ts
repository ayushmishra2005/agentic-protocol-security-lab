/**
 * The bounded model/tool loop.
 *
 * This is a manual host loop. The provider's managed tool-runner helper is not
 * used, because it hides the iterations that Article I requires to be
 * reviewable, and because a helper that dispatches tools on our behalf would
 * own the control flow that must stay with the host.
 *
 * Control never passes to the model. The model may emit text and may request
 * tools; every other decision — whether to continue, how many tools to run,
 * when to stop, what counts as an answer — is made here against budgets fixed
 * before the loop starts. The budgets are captured at construction and are not
 * read from anything a response can influence, so no amount of model output can
 * raise them.
 *
 * How iterations are recorded, and why it is not tool evidence:
 *
 * Every tool call runs through the Phase 6 evidence store and therefore
 * produces a real evidence record with argv, working directory, exit code and
 * output digests. Model turns are different in kind: nothing was executed, so
 * there is no argv, no exit code and no output to digest. The evidence schema
 * is shaped for executed tool invocations, and writing turns into it would mean
 * filling those fields with placeholders — a record that looks like proof of
 * execution while proving nothing. The current specification defines no turn
 * schema, so rather than invent an event-sourcing layer, the loop returns a
 * plain in-memory `LoopTranscript`: one entry per turn, carrying the stop
 * reason, the tool calls attempted and the evidence identifier each produced.
 * Turns are reviewable through the transcript, tool executions are provable
 * through evidence, and neither claims to be the other.
 */
import type { ContentBlock, MessageParam } from '@anthropic-ai/sdk/resources/messages';

import { MODEL_LOOP_DEFAULTS } from '../config.js';
import type { ModelClient, ModelRequest, ModelResponse } from '../model/client.js';
import { runToolUse } from '../model/tools.js';
import { UsageAccumulator, type UsageTotals } from '../model/usage.js';
import type { ToolContext } from '../tools/dispatch.js';

export class LoopError extends Error {
  override readonly name = 'LoopError';
}

/** Why the loop stopped. Every exit is one of these; none is silent. */
export type LoopStopReason =
  | 'answered'
  | 'max_turns_exhausted'
  | 'max_tool_calls_exhausted'
  | 'provider_stopped'
  | 'unsupported_response';

export interface LoopToolCall {
  readonly toolName: string;
  readonly evidenceId?: string;
  readonly isError: boolean;
}

export interface LoopTurn {
  readonly turn: number;
  readonly responseId: string;
  readonly stopReason: ModelResponse['stopReason'];
  readonly textLength: number;
  readonly toolCalls: readonly LoopToolCall[];
  /** Content block types seen, including any the host does not act on. */
  readonly blockTypes: readonly string[];
}

export type LoopTranscript = readonly LoopTurn[];

export interface LoopResult {
  readonly stopReason: LoopStopReason;
  /** Assistant text from the final turn. Not validated here. */
  readonly text: string;
  readonly transcript: LoopTranscript;
  readonly usage: UsageTotals;
  readonly turnsUsed: number;
  readonly toolCallsUsed: number;
}

export interface LoopBudgets {
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxToolCallsPerTurn?: number;
}

export interface LoopOptions {
  readonly client: ModelClient;
  readonly context: ToolContext;
  readonly request: ModelRequest;
  readonly budgets?: LoopBudgets;
  readonly usage?: UsageAccumulator;
  /** Host cancellation. Checked before each provider call and each tool call. */
  readonly signal?: AbortSignal;
}

function assertBudget(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new LoopError(`${label} must be a positive integer, received ${String(value)}.`);
  }
  return value;
}

/** Concatenate the text blocks of a response. */
function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Run the loop until it answers or a budget stops it.
 *
 * The loop returns rather than throws on budget exhaustion: the caller needs
 * the transcript and usage to report what happened, and an exception would
 * discard both. Every terminal state is explicit in `stopReason`.
 */
export async function runBoundedLoop(options: LoopOptions): Promise<LoopResult> {
  const maxTurns = assertBudget(
    options.budgets?.maxTurns ?? MODEL_LOOP_DEFAULTS.maxTurns,
    'maxTurns',
  );
  const maxToolCalls = assertBudget(
    options.budgets?.maxToolCalls ?? MODEL_LOOP_DEFAULTS.maxToolCalls,
    'maxToolCalls',
  );
  const maxToolCallsPerTurn = assertBudget(
    options.budgets?.maxToolCallsPerTurn ?? MODEL_LOOP_DEFAULTS.maxToolCallsPerTurn,
    'maxToolCallsPerTurn',
  );

  const usage = options.usage ?? new UsageAccumulator();
  const transcript: LoopTurn[] = [];
  const messages: MessageParam[] = [...options.request.messages];

  let toolCallsUsed = 0;
  let lastText = '';

  const finish = (stopReason: LoopStopReason, turnsUsed: number): LoopResult => ({
    stopReason,
    text: lastText,
    transcript,
    usage: usage.totals(),
    turnsUsed,
    toolCallsUsed,
  });

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    options.signal?.throwIfAborted();

    const response = await options.client.createMessage({
      ...options.request,
      messages,
    });
    usage.recordModelCall(response.usage);
    lastText = textOf(response.content);

    const toolUses = response.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
    );
    const blockTypes = response.content.map((block) => block.type);

    // No tools requested: the model has said what it is going to say. Whether
    // that text is an acceptable artifact is the validator's decision, not the
    // loop's.
    if (toolUses.length === 0) {
      transcript.push({
        turn,
        responseId: response.id,
        stopReason: response.stopReason,
        textLength: lastText.length,
        toolCalls: [],
        blockTypes,
      });

      // `refusal` and `model_context_window_exceeded` are terminal provider
      // states in this SDK version: continuing would send another request that
      // cannot succeed.
      if (response.stopReason === 'refusal') return finish('provider_stopped', turn);
      if (response.stopReason === 'model_context_window_exceeded') {
        return finish('provider_stopped', turn);
      }
      if (lastText.length === 0) return finish('unsupported_response', turn);
      return finish('answered', turn);
    }

    // The per-turn cap bounds a single response that asks for a large number of
    // tools at once; the run-wide cap bounds the total. Both are enforced
    // before any of the requested tools run.
    if (toolUses.length > maxToolCallsPerTurn) {
      transcript.push({
        turn,
        responseId: response.id,
        stopReason: response.stopReason,
        textLength: lastText.length,
        toolCalls: [],
        blockTypes,
      });
      return finish('max_tool_calls_exhausted', turn);
    }

    if (toolCallsUsed + toolUses.length > maxToolCalls) {
      transcript.push({
        turn,
        responseId: response.id,
        stopReason: response.stopReason,
        textLength: lastText.length,
        toolCalls: [],
        blockTypes,
      });
      return finish('max_tool_calls_exhausted', turn);
    }

    const results: MessageParam['content'] = [];
    const calls: LoopToolCall[] = [];

    for (const toolUse of toolUses) {
      options.signal?.throwIfAborted();
      usage.recordToolRequested();

      const outcome = await runToolUse(options.context, toolUse);
      toolCallsUsed += 1;
      usage.recordToolOutcome(outcome.isError ? 'refused' : 'dispatched');

      results.push(outcome.block);
      calls.push({
        toolName: outcome.toolName,
        ...(outcome.evidenceId === undefined ? {} : { evidenceId: outcome.evidenceId }),
        isError: outcome.isError,
      });
    }

    transcript.push({
      turn,
      responseId: response.id,
      stopReason: response.stopReason,
      textLength: lastText.length,
      toolCalls: calls,
      blockTypes,
    });

    // The assistant turn is echoed back verbatim, then the tool results. A
    // `tool_use` without a matching `tool_result` would make the next request
    // invalid, and every tool call above produced exactly one result block.
    messages.push({ role: 'assistant', content: [...response.content] });
    messages.push({ role: 'user', content: results });
  }

  // Falling out of the loop means the turn budget ran out. This is returned
  // explicitly and is never mistaken for an answer.
  return finish('max_turns_exhausted', maxTurns);
}
