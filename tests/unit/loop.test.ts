// Phase 7 tests: model client boundary, tool plumbing, budgets, usage,
// phase machine, and artifact validation.
//
// No live provider request is made anywhere in this file. Every model response
// comes from a deterministic fake `ModelClient`, and the process boundary is
// exercised only through the real evidence-backed dispatch against this
// repository, which is read-only.
//
// No real credential appears below. Where a credential is needed the value is
// an obviously fake sentinel, and the tests assert it does not escape.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import type { ContentBlock, Message, Usage } from '@anthropic-ai/sdk/resources/messages';

import { runBoundedLoop, type LoopResult } from '../../src/agent/loop.js';
import {
  FINAL_PHASE,
  FIRST_PHASE,
  isHostOnlyPhase,
  isModelPhase,
  legalSuccessor,
  PhaseMachine,
  PhaseTransitionError,
} from '../../src/agent/phases.js';
import { validateArtifact, validateWithRetry } from '../../src/agent/validate.js';
import {
  ConfigError,
  hasProviderCredential,
  MODEL_LOOP_DEFAULTS,
  ProviderCredential,
  resolveProviderCredential,
} from '../../src/config.js';
import {
  assertCustomToolsOnly,
  type ModelClient,
  type ModelRequest,
} from '../../src/model/client.js';
import { buildProviderTools, runToolUse } from '../../src/model/tools.js';
import { UsageAccumulator, UsageError } from '../../src/model/usage.js';
import { EvidenceStore } from '../../src/evidence/store.js';
import { MODEL_PHASE_SEQUENCE } from '../../src/schemas/phases.js';
import { createWorkspace } from '../../src/security/paths.js';
import type { ToolContext } from '../../src/tools/dispatch.js';
import { TOOL_NAMES } from '../../src/tools/registry.js';

const FAKE_KEY = 'sk-ant-TEST_SECRET_DO_NOT_PERSIST-not-a-real-key';

const workspace = createWorkspace(path.resolve(import.meta.dirname, '..', '..'));
const tempRoots: string[] = [];

function makeContext(): ToolContext {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-loop-'));
  tempRoots.push(runsRoot);
  return { workspace, store: new EvidenceStore({ runId: 'run-loop', runsRoot }) };
}

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

// --- deterministic fake provider -------------------------------------------

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    inference_geo: null,
    ...overrides,
  } as Usage;
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text, citations: null };
}

function toolUseBlock(id: string, name: string, input: unknown): ContentBlock {
  return { type: 'tool_use', id, name, input, caller: { type: 'direct' } };
}

interface FakeTurn {
  readonly content: ContentBlock[];
  readonly stopReason?: Message['stop_reason'];
  readonly usage?: Usage;
}

class FakeModelClient implements ModelClient {
  calls = 0;
  lastRequest?: ModelRequest;
  readonly seenRequests: ModelRequest[] = [];

  constructor(private readonly turns: readonly FakeTurn[]) {}

  createMessage(request: ModelRequest): Promise<ReturnType<typeof this.build>> {
    this.lastRequest = request;
    this.seenRequests.push(request);
    // Repeat the final scripted turn, so a "model that never stops asking for
    // tools" is representable without writing an infinite array.
    const turn = this.turns[Math.min(this.calls, this.turns.length - 1)];
    this.calls += 1;
    assert.ok(turn);
    return Promise.resolve(this.build(turn));
  }

  private build(turn: FakeTurn) {
    return {
      id: `msg_${String(this.calls)}`,
      model: 'fake-model',
      stopReason: turn.stopReason ?? 'end_turn',
      content: turn.content,
      usage: turn.usage ?? usage(),
    };
  }
}

function runWith(
  turns: readonly FakeTurn[],
  overrides: Partial<Parameters<typeof runBoundedLoop>[0]> = {},
) {
  const client = new FakeModelClient(turns);
  const context = overrides.context ?? makeContext();
  const promise = runBoundedLoop({
    client,
    context,
    request: { system: 'host system prompt', messages: [], tools: buildProviderTools() },
    ...overrides,
  });
  return { client, context, promise };
}

// --- model client boundary --------------------------------------------------

describe('provider credential boundary', () => {
  it('never exposes the key through string, JSON, or inspect', () => {
    const credential = new ProviderCredential(FAKE_KEY);

    assert.equal(String(credential), '[REDACTED]');
    // `join` goes through `toString`, exercising template-literal interpolation
    // without tripping the lint rule that forbids interpolating an object.
    assert.equal([credential].join(''), '[REDACTED]');
    assert.equal(JSON.stringify({ credential }), '{"credential":"[REDACTED]"}');
    assert.equal(JSON.stringify(credential), '"[REDACTED]"');
    assert.equal(String(credential).includes('sk-ant-'), false);
  });

  it('yields the key only through the SDK-shaped lazy accessor', async () => {
    const credential = new ProviderCredential(FAKE_KEY);
    assert.equal(await credential.asApiKeySetter()(), FAKE_KEY);
  });

  it('exposes no own enumerable property holding the key', () => {
    const credential = new ProviderCredential(FAKE_KEY);
    assert.deepEqual(Object.keys(credential), []);
    assert.equal(JSON.stringify(Object.entries(credential)).includes('sk-ant-'), false);
  });

  it('reads the credential only from the named variable, and reports absence', () => {
    assert.equal(hasProviderCredential({}), false);
    assert.equal(hasProviderCredential({ ANTHROPIC_API_KEY: FAKE_KEY }), true);
    assert.throws(() => resolveProviderCredential({}), ConfigError);
    assert.throws(() => resolveProviderCredential({ ANTHROPIC_API_KEY: '   ' }), ConfigError);
  });

  it('does not name the credential in the error raised when it is missing', () => {
    try {
      resolveProviderCredential({});
      assert.fail('expected a ConfigError');
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.message.includes('sk-ant-'), false);
    }
  });
});

describe('provider tool descriptors', () => {
  it('exposes every registered tool and nothing else', () => {
    const tools = buildProviderTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
  });

  it('describes tools with a JSON Schema and never with a command', () => {
    for (const tool of buildProviderTools()) {
      assert.equal(tool.input_schema.type, 'object');
      assert.equal(tool.strict, true);
      assert.equal(tool.type, 'custom');
      const serialised = JSON.stringify(tool);
      for (const forbidden of ['argv', 'executable', 'command', 'shell', '/usr/bin', 'dpm ']) {
        assert.equal(serialised.includes(forbidden), false, `${tool.name} leaked ${forbidden}`);
      }
    }
  });

  it('refuses provider-side tools such as bash, web search, or code execution', () => {
    for (const type of [
      'bash_20250124',
      'web_search_20250305',
      'code_execution_20250522',
      'text_editor_20250124',
      'memory_20250818',
    ]) {
      assert.throws(
        () => {
          assertCustomToolsOnly([{ name: 'x', type } as never]);
        },
        (error: unknown) => error instanceof Error && /provider-side tool/.test(error.message),
      );
    }
  });

  it('accepts the custom tools the host itself builds', () => {
    assert.doesNotThrow(() => {
      assertCustomToolsOnly(buildProviderTools());
    });
  });
});

describe('requests carry no environment or credential material', () => {
  it('sends only the host system prompt, messages, and tool schemas', async () => {
    process.env['APSL_LOOP_TEST_MARKER'] = 'MARKER_MUST_NOT_APPEAR';
    try {
      const { client, promise } = runWith([{ content: [textBlock('done')] }]);
      await promise;

      const request = client.lastRequest;
      assert.ok(request);
      const serialised = JSON.stringify(request);
      assert.equal(serialised.includes('MARKER_MUST_NOT_APPEAR'), false);
      assert.equal(serialised.includes('sk-ant-'), false);
      assert.equal(serialised.includes('ANTHROPIC_API_KEY'), false);
      assert.deepEqual(Object.keys(request).sort(), ['messages', 'system', 'tools']);
    } finally {
      delete process.env['APSL_LOOP_TEST_MARKER'];
    }
  });
});

// --- tool plumbing ----------------------------------------------------------

describe('tool plumbing routes through evidence-backed dispatch', () => {
  it('runs a known tool and returns its evidence id to the model', async () => {
    const context = makeContext();
    const outcome = await runToolUse(
      context,
      toolUseBlock('tu_1', 'repo_read_file', { path: 'package.json' }) as never,
    );

    assert.equal(outcome.isError, false);
    assert.ok(outcome.evidenceId);
    assert.equal(context.store.get(outcome.evidenceId).outcome, 'ok');
    assert.equal(outcome.block.type, 'tool_result');
    assert.equal(outcome.block.tool_use_id, 'tu_1');
    assert.ok(JSON.stringify(outcome.block.content).includes(outcome.evidenceId));
  });

  it('rejects an unknown tool and records the refusal', async () => {
    const context = makeContext();
    const outcome = await runToolUse(
      context,
      toolUseBlock('tu_2', 'shell_exec', { cmd: 'rm -rf /' }) as never,
    );

    assert.equal(outcome.isError, true);
    assert.equal(outcome.block.is_error, true);
    assert.ok(outcome.evidenceId);
    assert.equal(context.store.get(outcome.evidenceId).error?.name, 'UnknownToolError');
  });

  it('rejects malformed input before the tool runs', async () => {
    const context = makeContext();
    const outcome = await runToolUse(
      context,
      toolUseBlock('tu_3', 'git_log', { maxCount: 99_999 }) as never,
    );

    assert.equal(outcome.isError, true);
    assert.ok(outcome.evidenceId);
    const record = context.store.get(outcome.evidenceId);
    assert.equal(record.error?.name, 'ParameterValidationError');
    assert.equal(record.process, undefined);
  });

  it('refuses model-supplied argv, executables, and unknown parameters', async () => {
    const context = makeContext();
    for (const input of [
      { path: 'package.json', executable: '/bin/sh' },
      { path: 'package.json', argv: ['-c', 'id'] },
      { path: '../../etc/passwd' },
      { path: 'package.json', env: { PATH: '/tmp' } },
    ]) {
      const outcome = await runToolUse(
        context,
        toolUseBlock('tu_x', 'repo_read_file', input) as never,
      );
      assert.equal(outcome.isError, true, `${JSON.stringify(input)} should be refused`);
      assert.ok(outcome.evidenceId);
      assert.equal(context.store.get(outcome.evidenceId).process, undefined);
    }
  });

  it('cannot select an evidence id for its own record', async () => {
    const context = makeContext();
    const outcome = await runToolUse(
      context,
      toolUseBlock('tu_4', 'repo_read_file', {
        path: 'package.json',
        evidenceId: 'ev_0000000000000000',
      }) as never,
    );

    assert.equal(outcome.isError, true);
    assert.notEqual(outcome.evidenceId, 'ev_0000000000000000');
  });

  it('reports a tool error without fabricating a successful execution', async () => {
    const context = makeContext();
    const outcome = await runToolUse(
      context,
      toolUseBlock('tu_5', 'daml_inspect_dar', { darPath: 'nope.dar' }) as never,
    );

    assert.equal(outcome.isError, true);
    assert.equal(outcome.block.is_error, true);
    assert.equal(JSON.stringify(outcome.block.content).includes('"result"'), false);
  });
});

// --- loop budgets -----------------------------------------------------------

describe('loop budgets are host-owned and terminate the loop', () => {
  it('returns the answer when the model stops requesting tools', async () => {
    const { promise, client } = runWith([{ content: [textBlock('final answer')] }]);
    const result = await promise;

    assert.equal(result.stopReason, 'answered');
    assert.equal(result.text, 'final answer');
    assert.equal(result.turnsUsed, 1);
    assert.equal(client.calls, 1);
  });

  it('terminates on the turn budget when the model never answers', async () => {
    const { promise, client } = runWith(
      [
        {
          content: [toolUseBlock('t', 'repo_list_files', { extensions: ['.json'] })],
          stopReason: 'tool_use',
        },
      ],
      { budgets: { maxTurns: 3, maxToolCalls: 100 } },
    );
    const result = await promise;

    assert.equal(result.stopReason, 'max_turns_exhausted');
    assert.equal(result.turnsUsed, 3);
    assert.equal(client.calls, 3, 'the loop must not call the provider beyond its turn budget');
  });

  it('terminates on the run-wide tool budget', async () => {
    const { promise } = runWith(
      [
        {
          content: [toolUseBlock('t', 'repo_list_files', { extensions: ['.json'] })],
          stopReason: 'tool_use',
        },
      ],
      { budgets: { maxTurns: 50, maxToolCalls: 2 } },
    );
    const result = await promise;

    assert.equal(result.stopReason, 'max_tool_calls_exhausted');
    assert.ok(result.toolCallsUsed <= 2);
  });

  it('bounds the number of tools honoured within a single response', async () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      toolUseBlock(`t${String(index)}`, 'repo_list_files', {}),
    );
    const { promise } = runWith([{ content: many, stopReason: 'tool_use' }], {
      budgets: { maxTurns: 5, maxToolCalls: 100, maxToolCallsPerTurn: 4 },
    });
    const result = await promise;

    assert.equal(result.stopReason, 'max_tool_calls_exhausted');
    assert.equal(result.toolCallsUsed, 0, 'no tool runs once the per-turn cap is exceeded');
  });

  it('executes multiple tool calls from one response and pairs every result', async () => {
    const { promise } = runWith(
      [
        {
          content: [
            textBlock('looking'),
            toolUseBlock('a', 'repo_list_files', { extensions: ['.json'] }),
            toolUseBlock('b', 'git_status', {}),
          ],
          stopReason: 'tool_use',
        },
        { content: [textBlock('done')] },
      ],
      { budgets: { maxTurns: 5, maxToolCalls: 10 } },
    );
    const result = await promise;

    assert.equal(result.stopReason, 'answered');
    assert.equal(result.toolCallsUsed, 2);
    const first = result.transcript[0];
    assert.ok(first);
    assert.equal(first.toolCalls.length, 2);
    for (const call of first.toolCalls) {
      assert.ok(call.evidenceId, 'every executed tool call must cite evidence');
    }
  });

  it('rejects a non-positive budget rather than looping forever', async () => {
    for (const budgets of [{ maxTurns: 0 }, { maxToolCalls: -1 }, { maxTurns: 1.5 }]) {
      await assert.rejects(runWith([{ content: [textBlock('x')] }], { budgets }).promise);
    }
  });

  it('stops on a provider refusal instead of retrying it', async () => {
    const { promise } = runWith([{ content: [textBlock('')], stopReason: 'refusal' }]);
    assert.equal((await promise).stopReason, 'provider_stopped');
  });

  it('stops when the provider reports the context window was exceeded', async () => {
    const { promise } = runWith([
      { content: [textBlock('')], stopReason: 'model_context_window_exceeded' },
    ]);
    assert.equal((await promise).stopReason, 'provider_stopped');
  });

  it('treats a response with no usable content as unsupported, not as an answer', async () => {
    const { promise } = runWith([
      { content: [{ type: 'thinking', thinking: 'hmm', signature: '' }] },
    ]);
    const result = await promise;

    assert.equal(result.stopReason, 'unsupported_response');
    assert.deepEqual(result.transcript[0]?.blockTypes, ['thinking']);
  });

  it('propagates host cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runWith([{ content: [textBlock('x')] }], { signal: controller.signal }).promise,
    );
  });

  it('records one transcript entry per turn, with evidence ids for tool calls', async () => {
    const { promise } = runWith(
      [
        { content: [toolUseBlock('a', 'git_status', {})], stopReason: 'tool_use' },
        { content: [textBlock('done')] },
      ],
      { budgets: { maxTurns: 5, maxToolCalls: 5 } },
    );
    const result: LoopResult = await promise;

    assert.equal(result.transcript.length, 2);
    const [first, second] = result.transcript;
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.turn, 1);
    assert.ok(first.toolCalls[0]?.evidenceId);
    assert.deepEqual(second.toolCalls, []);
  });
});

// --- usage ------------------------------------------------------------------

describe('usage accounting', () => {
  it('accumulates provider-reported tokens across turns', () => {
    const accumulator = new UsageAccumulator();
    accumulator.recordModelCall(usage({ input_tokens: 10, output_tokens: 3 }));
    accumulator.recordModelCall(usage({ input_tokens: 7, output_tokens: 5 }));

    const totals = accumulator.totals();
    assert.equal(totals.inputTokens, 17);
    assert.equal(totals.outputTokens, 8);
    assert.equal(totals.modelCalls, 2);
  });

  it('treats null cache fields as zero rather than NaN', () => {
    const accumulator = new UsageAccumulator();
    accumulator.recordModelCall(usage());
    accumulator.recordModelCall(
      usage({ cache_read_input_tokens: 4, cache_creation_input_tokens: 9 }),
    );

    const totals = accumulator.totals();
    assert.equal(totals.cacheReadInputTokens, 4);
    assert.equal(totals.cacheCreationInputTokens, 9);
    assert.ok(Number.isSafeInteger(totals.cacheReadInputTokens));
  });

  it('counts requested, dispatched, and refused tool calls separately', () => {
    const accumulator = new UsageAccumulator();
    accumulator.recordToolRequested();
    accumulator.recordToolOutcome('dispatched');
    accumulator.recordToolRequested();
    accumulator.recordToolOutcome('refused');

    const totals = accumulator.totals();
    assert.equal(totals.toolCallsRequested, 2);
    assert.equal(totals.toolCallsDispatched, 1);
    assert.equal(totals.toolCallsRefused, 1);
  });

  it('rejects an unusable provider count instead of estimating one', () => {
    const accumulator = new UsageAccumulator();
    assert.throws(() => {
      accumulator.recordModelCall(usage({ input_tokens: Number.NaN }));
    }, UsageError);
    assert.throws(() => {
      accumulator.recordModelCall(usage({ output_tokens: -1 }));
    }, UsageError);
  });

  it('returns a frozen snapshot that cannot be edited after the fact', () => {
    const accumulator = new UsageAccumulator();
    accumulator.recordModelCall(usage());
    const totals = accumulator.totals();
    assert.throws(() => {
      (totals as { inputTokens: number }).inputTokens = 9_999;
    }, TypeError);
  });

  it('accumulates through the loop over multiple turns', async () => {
    const { promise } = runWith(
      [
        {
          content: [toolUseBlock('a', 'git_status', {})],
          stopReason: 'tool_use',
          usage: usage({ input_tokens: 100, output_tokens: 20 }),
        },
        { content: [textBlock('done')], usage: usage({ input_tokens: 50, output_tokens: 10 }) },
      ],
      { budgets: { maxTurns: 5, maxToolCalls: 5 } },
    );
    const result = await promise;

    assert.equal(result.usage.inputTokens, 150);
    assert.equal(result.usage.outputTokens, 30);
    assert.equal(result.usage.modelCalls, 2);
    assert.equal(result.usage.toolCallsRequested, 1);
    assert.equal(result.usage.toolCallsDispatched, 1);
  });
});

// --- phase state machine ----------------------------------------------------

describe('phase state machine is host-owned', () => {
  it('starts at the first documented phase and follows the documented order', () => {
    const machine = new PhaseMachine();
    assert.equal(machine.current, FIRST_PHASE);
    assert.equal(FIRST_PHASE, 'understand');
    assert.equal(FINAL_PHASE, 'report');

    for (let index = 1; index < MODEL_PHASE_SEQUENCE.length; index += 1) {
      assert.equal(machine.advance({ validArtifact: true }), MODEL_PHASE_SEQUENCE[index]);
    }
    assert.equal(machine.advance({ validArtifact: true }), undefined);
    assert.equal(machine.status, 'completed');
  });

  it('offers exactly one successor per phase, so there is no branch to influence', () => {
    for (let index = 0; index < MODEL_PHASE_SEQUENCE.length - 1; index += 1) {
      const phase = MODEL_PHASE_SEQUENCE[index];
      assert.ok(phase);
      assert.equal(legalSuccessor(phase), MODEL_PHASE_SEQUENCE[index + 1]);
    }
    assert.equal(legalSuccessor(FINAL_PHASE), undefined);
  });

  it('does not advance without a schema-valid artifact', () => {
    const machine = new PhaseMachine();
    assert.throws(() => machine.advance({ validArtifact: false }), PhaseTransitionError);
    assert.equal(machine.current, FIRST_PHASE);
  });

  it('rejects a model-declared phase that is not the one the host is running', () => {
    const machine = new PhaseMachine();
    assert.doesNotThrow(() => {
      machine.assertExpectedPhase('understand');
    });
    // Skipping ahead.
    assert.throws(() => {
      machine.assertExpectedPhase('report');
    }, PhaseTransitionError);
    // Unknown phase entirely.
    assert.throws(() => {
      machine.assertExpectedPhase('exfiltrate');
    }, PhaseTransitionError);
  });

  it('rejects a backward transition', () => {
    const machine = new PhaseMachine();
    machine.advance({ validArtifact: true });
    assert.equal(machine.current, 'inspect');
    assert.throws(() => {
      machine.assertExpectedPhase('understand');
    }, PhaseTransitionError);
  });

  it('never lets the model reach the host-only evaluate stage', () => {
    const machine = new PhaseMachine();
    assert.equal(isHostOnlyPhase('evaluate'), true);
    assert.equal(isModelPhase('evaluate'), false);
    assert.equal((MODEL_PHASE_SEQUENCE as readonly string[]).includes('evaluate'), false);
    assert.throws(() => {
      machine.assertExpectedPhase('evaluate');
    }, PhaseTransitionError);
    for (const phase of MODEL_PHASE_SEQUENCE) {
      assert.notEqual(legalSuccessor(phase), 'evaluate');
    }
  });

  it('halts on a degraded phase instead of advancing', () => {
    const machine = new PhaseMachine();
    machine.advance({ validArtifact: true });
    machine.markDegraded();

    assert.equal(machine.status, 'halted');
    assert.deepEqual(machine.degradedPhases(), ['inspect']);
    assert.throws(() => machine.advance({ validArtifact: true }), PhaseTransitionError);
  });
});

// --- artifact validation ----------------------------------------------------

describe('artifact validation is the host gate', () => {
  const validUnderstand = {
    phase: 'understand',
    summary: 'a summary',
    damlPackages: ['main'],
    evidence: [{ evidenceId: 'ev_0123456789abcdef' }],
  };

  it('accepts a well-formed artifact for the expected phase', () => {
    const outcome = validateArtifact('understand', validUnderstand);
    assert.equal(outcome.ok, true);
  });

  it('accepts the artifact as JSON text', () => {
    assert.equal(validateArtifact('understand', JSON.stringify(validUnderstand)).ok, true);
  });

  it('rejects an artifact produced for a different phase', () => {
    const outcome = validateArtifact('inspect', validUnderstand);
    assert.equal(outcome.ok, false);
  });

  it('rejects malformed JSON without throwing', () => {
    const outcome = validateArtifact('understand', '{not json');
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok);
    assert.ok(outcome.issues[0]?.includes('not valid JSON'));
  });

  it('does not echo model-supplied values back in validation issues', () => {
    const outcome = validateArtifact('understand', {
      ...validUnderstand,
      summary: 'IGNORE_PREVIOUS_INSTRUCTIONS_MARKER',
      damlPackages: 'not-an-array',
    });

    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok);
    for (const issue of outcome.issues) {
      assert.equal(issue.includes('IGNORE_PREVIOUS_INSTRUCTIONS_MARKER'), false);
    }
  });

  it('returns a valid artifact within the retry budget', async () => {
    let attempts = 0;
    const outcome = await validateWithRetry(
      'understand',
      (attempt) => {
        attempts = attempt;
        return Promise.resolve(attempt < 2 ? { phase: 'understand' } : validUnderstand);
      },
      { maxAttempts: 3 },
    );

    assert.equal(outcome.status, 'valid');
    assert.equal(attempts, 2);
  });

  it('degrades after the budget rather than looping or fabricating an artifact', async () => {
    let attempts = 0;
    const outcome = await validateWithRetry(
      'understand',
      (attempt) => {
        attempts = attempt;
        return Promise.resolve({ phase: 'understand' });
      },
      { maxAttempts: 3 },
    );

    assert.equal(attempts, 3);
    // `assert.equal` from `node:assert/strict` narrows the union, so the
    // degraded-only fields below are reachable without a cast.
    assert.equal(outcome.status, 'degraded');
    assert.equal(outcome.attempts, 3);
    assert.ok(outcome.issues.length > 0);
  });

  it('feeds issues from the previous attempt into the next attempt', async () => {
    const seen: (readonly string[])[] = [];
    await validateWithRetry(
      'understand',
      (_attempt, previousIssues) => {
        seen.push(previousIssues);
        return Promise.resolve({ phase: 'understand' });
      },
      { maxAttempts: 2 },
    );

    assert.deepEqual(seen[0], []);
    assert.ok((seen[1]?.length ?? 0) > 0);
  });

  it('uses a bounded default validation budget', () => {
    const budget: number = MODEL_LOOP_DEFAULTS.maxValidationAttempts;
    assert.ok(Number.isSafeInteger(budget));
    assert.ok(budget >= 1 && budget <= 10);
  });
});
