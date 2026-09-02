// Deterministic fake provider, shared by the tests that exercise the model
// loop. No test in this repository contacts Anthropic; every response comes
// from a script written by the test itself.
import type {
  ContentBlock,
  Message,
  MessageParam,
  Usage,
} from '@anthropic-ai/sdk/resources/messages';

import type { ModelClient, ModelRequest } from '../../src/model/client.js';

export function fakeUsage(): Usage {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    inference_geo: null,
  } as Usage;
}

export function textBlock(text: string): ContentBlock {
  return { type: 'text', text, citations: null };
}

export function toolUseBlock(id: string, name: string, input: unknown): ContentBlock {
  return { type: 'tool_use', id, name, input, caller: { type: 'direct' } };
}

export interface FakeTurn {
  readonly content: ContentBlock[];
  readonly stopReason?: Message['stop_reason'];
}

/** A turn computed from the request, so a reply can use IDs it was just given. */
export type TurnScript = (request: ModelRequest, call: number) => FakeTurn;

export function promptText(request: { system?: string; messages: unknown }): string {
  return `${request.system ?? ''}\n${JSON.stringify(request.messages)}`;
}

export class ScriptedClient implements ModelClient {
  calls = 0;
  /**
   * Prompts are snapshotted as text at call time. The loop grows one message
   * array across turns, so holding the request object would show a later turn's
   * contents when asserting about an earlier one.
   */
  readonly seenPrompts: string[] = [];

  constructor(private readonly script: TurnScript) {}

  createMessage(request: ModelRequest) {
    this.seenPrompts.push(promptText(request));
    const turn = this.script(request, this.calls);
    this.calls += 1;
    return Promise.resolve({
      id: `msg_${String(this.calls)}`,
      model: 'fake-model',
      stopReason: turn.stopReason ?? 'end_turn',
      content: turn.content,
      usage: fakeUsage(),
    });
  }
}

/**
 * Evidence identifiers the model was actually handed, read back out of the
 * tool results in the request. Taking them from here rather than from the store
 * keeps the fake honest: it can only cite what it was told.
 */
export function evidenceIdsFrom(request: { messages: readonly MessageParam[] }): string[] {
  const matches = JSON.stringify(request.messages).match(/ev_[0-9a-f]{16}/g);
  return [...new Set(matches ?? [])];
}
