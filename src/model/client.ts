/**
 * The model client (Constitution Article V, FR-029).
 *
 * This is the only module in the system that performs network I/O, and the only
 * outbound path it can take is a Messages API request to the configured
 * provider. The destination, method, headers and credential are fixed by host
 * code here; nothing derived from a target repository or a model response
 * contributes to any of them, which is what FR-029 requires.
 *
 * The Messages API is used directly. The Agent SDK is deliberately not used:
 * its value is its built-in Bash and file-editor tools, which is exactly the
 * capability Article II denies an agent that reads untrusted repositories.
 * Server-side provider tools — web search, web fetch, code execution, computer
 * use, memory, text editor — are equally excluded, and `assertCustomToolsOnly`
 * makes that a checked property rather than a convention.
 *
 * Findings from the installed SDK (@anthropic-ai/sdk 0.123.0), verified against
 * `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts` rather than
 * recalled, because several of these are version-dependent:
 *
 *   - `messages.create` returns `Message` for a non-streaming request.
 *   - `Usage.cache_creation_input_tokens` and `Usage.cache_read_input_tokens`
 *     are `number | null`, not optional numbers.
 *   - `StopReason` includes `refusal`, `pause_turn` and
 *     `model_context_window_exceeded` alongside the familiar values.
 *   - Strict tool schemas exist as `Tool.strict?: boolean`, but they are part of
 *     the structured-outputs capability: `ModelInfo.structured_outputs` covers
 *     "structured output / JSON mode / strict tool schemas", and the matching
 *     beta is `structured-outputs-2025-11-13`. Sending `strict` on the
 *     non-beta endpoint is rejected, so it is not sent.
 *   - Structured output is `output_config.format`, a `JSONOutputFormat` with
 *     `{ type: 'json_schema', schema }`. It is not requested here: host-side Zod
 *     validation is the authoritative gate, and a provider-side guarantee must
 *     not become a reason to trust an artifact the host has not checked.
 *   - `ClientOptions.apiKey` is typed `string | ApiKeySetter`, but the
 *     constructor keeps it only when it is a string and silently drops the
 *     accessor form, so the credential must be supplied as a string.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Message, MessageParam, Tool, ToolUnion } from '@anthropic-ai/sdk/resources/messages';

import {
  MODEL_LOOP_DEFAULTS,
  resolveModelId,
  resolveProviderCredential,
  type ProviderCredential,
} from '../config.js';

export class ModelClientError extends Error {
  override readonly name: string = 'ModelClientError';
}

/**
 * Diagnostics copied off a provider error, restricted to fields that cannot
 * carry request or credential material.
 *
 * Three fields, chosen individually rather than by spreading the SDK error.
 * `status` and `requestID` are transport facts; `providerErrorType` is the
 * `error.type` discriminant, which is a fixed enum the SDK parses out for us.
 * Headers are excluded because they carry the authorization header, and the
 * response body is excluded because it is provider-controlled text that would
 * end up in host logs unread.
 */
export interface ProviderErrorDetail {
  readonly status?: number;
  readonly requestId?: string;
  readonly providerErrorType?: string;
}

/**
 * Read safe diagnostics off an SDK error.
 *
 * Returns nothing for a non-API error, so a transport or programming fault
 * cannot smuggle arbitrary properties in under these names.
 */
export function providerErrorDetail(error: unknown): ProviderErrorDetail {
  if (!(error instanceof Anthropic.APIError)) return {};

  return {
    ...(typeof error.status === 'number' ? { status: error.status } : {}),
    ...(typeof error.requestID === 'string' ? { requestId: error.requestID } : {}),
    ...(typeof error.type === 'string' ? { providerErrorType: error.type } : {}),
  };
}

/** Raised when the provider fails in a way retrying cannot fix. */
export class ModelRequestError extends ModelClientError {
  override readonly name = 'ModelRequestError';
  /** Requests actually issued, not the budget that was available. */
  readonly attempts: number;
  readonly status?: number;
  readonly requestId?: string;
  readonly providerErrorType?: string;

  constructor(
    message: string,
    options: { attempts: number; cause?: unknown; detail?: ProviderErrorDetail },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.attempts = options.attempts;

    const detail = options.detail ?? {};
    if (detail.status !== undefined) this.status = detail.status;
    if (detail.requestId !== undefined) this.requestId = detail.requestId;
    if (detail.providerErrorType !== undefined) this.providerErrorType = detail.providerErrorType;
  }
}

/**
 * A request, in host terms.
 *
 * There is no field here for a credential, a base URL, a header, or any other
 * transport property, so no caller — and therefore no model response routed
 * into a caller — can influence where the request goes.
 */
export interface ModelRequest {
  readonly system: string;
  readonly messages: readonly MessageParam[];
  readonly tools: readonly Tool[];
  readonly maxOutputTokens?: number;
}

/** A response, normalised to the fields the host loop actually uses. */
export interface ModelResponse {
  readonly id: string;
  readonly model: string;
  readonly stopReason: Message['stop_reason'];
  readonly content: readonly Message['content'][number][];
  readonly usage: Message['usage'];
}

/**
 * The seam the loop depends on.
 *
 * Kept to one method so unit tests can supply a deterministic fake and never
 * contact a provider. It is not a multi-provider abstraction: the MVP has one
 * provider, and a generic layer would be untested surface area.
 */
export interface ModelClient {
  /**
   * The identifier the report records for this run.
   *
   * Part of the interface so the report takes the model's identity from the
   * client that actually made the calls, rather than from configuration that
   * may have been read at a different moment. A fake declares a fake identifier,
   * and a report produced by a fake therefore says so.
   */
  readonly modelId: string;
  createMessage(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * Reject any tool that is not a plain custom tool.
 *
 * `ToolUnion` in this SDK version also admits Bash, code execution, browser,
 * computer use, memory, text editor, web search and web fetch tools. Those are
 * server-side capabilities that would sidestep the entire deterministic tool
 * boundary, so the request builder accepts only `Tool` and this check refuses
 * anything carrying a non-custom `type` discriminant at runtime.
 */
export function assertCustomToolsOnly(tools: readonly ToolUnion[]): void {
  for (const tool of tools) {
    const type = (tool as { type?: unknown }).type;
    if (type !== undefined && type !== null && type !== 'custom') {
      const label = typeof type === 'string' ? type : JSON.stringify(type);
      throw new ModelClientError(
        `Refusing provider-side tool of type ${label}. Only custom host tools are permitted.`,
      );
    }
    if (!('input_schema' in tool)) {
      // Server-side toolsets have no `input_schema`, and some have no `name`
      // either, so the label is read defensively rather than off the union.
      const label = (tool as { name?: unknown }).name;
      throw new ModelClientError(
        `Refusing tool ${typeof label === 'string' ? label : '<unnamed>'}: no host-owned input schema.`,
      );
    }
  }
}

/** Provider failures worth retrying: transport faults and transient statuses. */
function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.APIUserAbortError) return false;
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.InternalServerError) return true;
  // Authentication, permission, bad request and unprocessable entity are host
  // configuration or host request errors. Retrying them only wastes budget and
  // hides the real fault.
  return false;
}

export interface AnthropicModelClientOptions {
  readonly credential?: ProviderCredential;
  readonly modelId?: string;
  readonly maxRetries?: number;
  readonly requestTimeoutMs?: number;
  /** Injectable delay, so tests never wait on real backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class AnthropicModelClient implements ModelClient {
  readonly modelId: string;

  readonly #client: Anthropic;
  readonly #maxRetries: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: AnthropicModelClientOptions = {}) {
    const credential = options.credential ?? resolveProviderCredential();
    this.modelId = options.modelId ?? resolveModelId();
    this.#maxRetries = options.maxRetries ?? MODEL_LOOP_DEFAULTS.maxProviderRetries;
    this.#sleep = options.sleep ?? defaultSleep;

    this.#client = new Anthropic({
      // The only place the credential leaves its wrapper. It must be a string:
      // this SDK version discards a function-valued `apiKey` and then fails
      // auth resolution before it ever reaches the transport. The value is
      // handed straight to the constructor and never bound to a local.
      apiKey: credential.revealForProviderClient(),
      timeout: options.requestTimeoutMs ?? MODEL_LOOP_DEFAULTS.requestTimeoutMs,
      // Retries are host-owned and bounded below. Leaving the SDK's own retry
      // enabled would multiply the two budgets together.
      maxRetries: 0,
    });
  }

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    assertCustomToolsOnly(request.tools);

    let lastError: unknown;
    // The budget, and separately the requests actually issued. Reporting the
    // budget as though it were the count made a terminal first failure look
    // like an exhausted retry sequence, which points diagnosis at the network
    // when the fault is in the host's own configuration.
    const attempts = this.#maxRetries + 1;
    let made = 0;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      made = attempt;

      try {
        const message = await this.#client.messages.create({
          model: this.modelId,
          max_tokens: request.maxOutputTokens ?? MODEL_LOOP_DEFAULTS.maxOutputTokens,
          system: request.system,
          messages: [...request.messages],
          tools: [...request.tools],
        });

        return {
          id: message.id,
          model: message.model,
          stopReason: message.stop_reason,
          content: message.content,
          usage: message.usage,
        };
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === attempts) break;
        // Fixed exponential backoff. The delay function is injectable so tests
        // exercise the retry path without waiting on wall time.
        await this.#sleep(250 * 2 ** (attempt - 1));
      }
    }

    // The final failure is reported, never swallowed. The provider error is
    // attached as `cause` rather than interpolated, and request headers are
    // never read, so no credential can travel out through this path. The safe
    // diagnostics are structured fields; the provider's own message and body
    // stay out of the public message for the same reason.
    throw new ModelRequestError(`Provider request failed after ${String(made)} attempt(s).`, {
      attempts: made,
      cause: lastError,
      detail: providerErrorDetail(lastError),
    });
  }
}
