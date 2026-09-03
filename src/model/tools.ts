/**
 * Translation between provider tool calls and the deterministic host tools.
 *
 * This module is a translator, not a dispatcher. It converts a `tool_use` block
 * into a call to the Phase 6 `dispatchTool`, and converts the outcome back into
 * a `tool_result` block. It contains no second execution path: there is exactly
 * one place a tool can run, and it is the evidence-backed one, so a tool cannot
 * execute without producing a record.
 *
 * What the model may supply is the tool name and a parameter object, both of
 * which are checked before anything runs. What the model may not supply appears
 * nowhere in the descriptors it receives: no executable path, no argv, no
 * command string, no flag, no evidence identifier, no environment variable.
 * Those are constructed by host code from validated parameters, which is what
 * keeps Article II intact once an untrusted model is in the loop.
 */
import { z } from 'zod';
import type {
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';

import { dispatchTool, ToolDispatchError, type ToolContext } from '../tools/dispatch.js';
import { TOOL_REGISTRY } from '../tools/registry.js';

/** Cap on the JSON handed back to the model for one tool call. */
const MAX_TOOL_RESULT_CHARS = 24_000;

/**
 * Build the provider tool descriptors from the host registry.
 *
 * The JSON Schema is generated from the same Zod schema the host validates
 * against, so the contract shown to the model and the contract enforced by the
 * host cannot drift apart.
 *
 * `strict` is deliberately not sent. It belongs to the structured-outputs
 * capability, which the non-beta Messages endpoint rejects, and asking for it
 * bought nothing anyway: host-side Zod validation is the gate, and it runs on
 * every tool call whether or not the provider also checked the shape.
 */
export function buildProviderTools(): Tool[] {
  return TOOL_REGISTRY.map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    input_schema: z.toJSONSchema(descriptor.parameters) as Tool.InputSchema,
    type: 'custom' as const,
  }));
}

export interface ToolCallOutcome {
  readonly toolUseId: string;
  readonly toolName: string;
  /** Present whenever dispatch recorded the attempt, including refusals. */
  readonly evidenceId?: string;
  readonly isError: boolean;
  readonly block: ToolResultBlockParam;
}

/** Serialise a tool result for the model, bounded in size. */
function encodeResult(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ error: 'Result could not be serialised.' });
  }
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\u2026[truncated]`;
}

/**
 * Execute one `tool_use` block.
 *
 * Every outcome — success, refusal, unexpected failure — comes back as a
 * `tool_result` block, so the conversation stays well-formed and the model is
 * told plainly that a call failed. A refusal is never dressed up as a success:
 * `is_error` is set and the payload says what was refused.
 */
export async function runToolUse(
  context: ToolContext,
  block: ToolUseBlock,
): Promise<ToolCallOutcome> {
  const toolName = block.name;

  try {
    // `block.input` is `unknown` in the SDK types and is model-controlled. It is
    // passed to dispatch as-is, where the registry schema is the gate.
    const invocation = await dispatchTool(context, toolName, block.input);

    return {
      toolUseId: block.id,
      toolName: invocation.toolName,
      evidenceId: invocation.evidenceId,
      isError: false,
      block: {
        type: 'tool_result',
        tool_use_id: block.id,
        content: encodeResult({
          evidenceId: invocation.evidenceId,
          result: invocation.result,
        }),
      },
    };
  } catch (error) {
    if (error instanceof ToolDispatchError) {
      // Dispatch already recorded the refusal. The model is told the call was
      // refused and why, and is given the identifier of that refusal record.
      return {
        toolUseId: block.id,
        toolName: error.toolName,
        evidenceId: error.evidenceId,
        isError: true,
        block: {
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content: encodeResult({
            evidenceId: error.evidenceId,
            error: error.message,
          }),
        },
      };
    }

    // Dispatch failed before it could record anything, for example because the
    // evidence file could not be written. There is no evidence identifier to
    // cite, and inventing one would be a lie, so none is returned.
    const message = error instanceof Error ? error.message : String(error);
    return {
      toolUseId: block.id,
      toolName,
      isError: true,
      block: {
        type: 'tool_result',
        tool_use_id: block.id,
        is_error: true,
        content: encodeResult({ error: `Tool call could not be recorded: ${message}` }),
      },
    };
  }
}
