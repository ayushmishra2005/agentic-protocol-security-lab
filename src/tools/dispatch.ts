/**
 * The single execution path for model-requested tools (Constitution Article I).
 *
 * Every tool in `src/tools/` is reachable from a model only through
 * `dispatchTool`, and `dispatchTool` writes an evidence record on every
 * outcome. There is no branch through this function that runs a tool and
 * returns without appending, and no branch that refuses one silently: a
 * refusal is recorded as a refusal rather than omitted, so the log distinguishes
 * "was not attempted" from "was attempted and denied".
 *
 * This layer adds evidence. It does not re-implement or relax the boundaries
 * underneath it — path confinement, the argv allowlist, fixed executable
 * resolution, timeouts, output caps and redaction all still happen inside the
 * wrappers and inside `security/exec.ts`, and they still run before anything is
 * recorded. A tool that refuses therefore refuses first and is logged second.
 *
 * The evidence store itself is deliberately not a tool. Nothing here lets a
 * caller read, search, or write the evidence log through the model-facing
 * surface.
 */
import type { EvidenceStore, JsonValue } from '../evidence/store.js';
import type { ExecResult } from '../security/exec.js';
import type { Workspace } from '../security/paths.js';
import { redact } from '../security/redact.js';
import { damlBuild } from './daml/build.js';
import { inspectDar } from './daml/inspect.js';
import { listScripts, runScript } from './daml/script.js';
import { damlTest } from './daml/test.js';
import { gitDiff, gitLog, gitStatus } from './git/inspect.js';
import { findTool, TOOL_NAMES } from './registry.js';
import { listFiles, searchText } from './repo/list.js';
import { readFileBounded } from './repo/read.js';

/**
 * Raised when a tool request is refused or the tool itself fails.
 *
 * Carries the evidence identifier of the refusal, so a caller reporting the
 * failure can cite the record rather than describe it from memory.
 */
export class ToolDispatchError extends Error {
  override readonly name = 'ToolDispatchError';
  readonly evidenceId: string;
  readonly toolName: string;

  constructor(message: string, options: { evidenceId: string; toolName: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.evidenceId = options.evidenceId;
    this.toolName = options.toolName;
  }
}

export interface ToolContext {
  readonly workspace: Workspace;
  readonly store: EvidenceStore;
}

export interface ToolInvocation {
  readonly toolName: string;
  /** Identifier of the record this invocation produced. Always resolvable. */
  readonly evidenceId: string;
  readonly result: unknown;
}

/** A handler returns its wrapper's result, plus the exec detail when it spawned. */
interface HandlerOutcome {
  readonly value: unknown;
  readonly exec?: ExecResult;
}

type Handler = (context: ToolContext, params: never) => Promise<HandlerOutcome>;

/** Strip `exec` from a wrapper result: it is recorded as `process` instead. */
function withoutExec(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const rest: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete rest['exec'];
  return rest;
}

/** Project a wrapper result into plain JSON for the evidence record. */
function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

/**
 * Bound and redact a caller-supplied tool name before it is recorded.
 *
 * An unknown tool name is model-controlled text, so it is treated as data.
 */
function safeToolName(name: unknown): string {
  if (typeof name !== 'string') return '<non-string tool name>';
  return redact(name.slice(0, 64));
}

const HANDLERS: Readonly<Record<string, Handler>> = {
  repo_read_file: (context, params: { path: string; maxBytes?: number }) =>
    Promise.resolve({
      value: readFileBounded(
        context.workspace,
        params.path,
        params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes },
      ),
    }),

  repo_list_files: (
    context,
    params: { directory?: string; extensions?: string[]; maxEntries?: number },
  ) => Promise.resolve({ value: listFiles(context.workspace, params) }),

  repo_search_text: (
    context,
    params: {
      query: string;
      directory?: string;
      extensions?: string[];
      caseSensitive?: boolean;
      maxMatches?: number;
    },
  ) => {
    const { query, ...options } = params;
    return Promise.resolve({ value: searchText(context.workspace, query, options) });
  },

  git_status: async (context) => {
    const value = await gitStatus(context.workspace);
    return { value, exec: value.exec };
  },

  git_diff: async (context, params: { ref?: string; paths?: string[]; nameOnly?: boolean }) => {
    const value = await gitDiff(context.workspace, params);
    return { value, exec: value.exec };
  },

  git_log: async (context, params: { maxCount?: number }) => {
    const value = await gitLog(context.workspace, params);
    return { value, exec: value.exec };
  },

  daml_build: async (context, params: { packageRoot?: string; all?: boolean }) => {
    const value = await damlBuild(context.workspace, params);
    return { value, exec: value.exec };
  },

  daml_test: async (
    context,
    params: { packageRoot?: string; testPattern?: string; all?: boolean },
  ) => {
    const value = await damlTest(context.workspace, params);
    return { value, exec: value.exec };
  },

  daml_inspect_dar: async (context, params: { darPath: string }) => {
    const value = await inspectDar(context.workspace, params.darPath);
    return { value, exec: value.exec };
  },

  daml_list_scripts: async (context, params: { darPath: string }) => {
    const value = await listScripts(context.workspace, params.darPath);
    return { value, exec: value.exec };
  },

  daml_run_script: async (context, params: { darPath: string; scriptName: string }) => {
    const value = await runScript(context.workspace, params.darPath, {
      scriptName: params.scriptName,
    });
    return { value, exec: value.exec };
  },
};

/**
 * Every registered tool must have a handler and every handler a registration.
 *
 * A handler with no registration would be an execution path the registry does
 * not describe; a registration with no handler would fail only when a model
 * happened to call it.
 */
export function assertHandlerCoverage(): void {
  for (const name of TOOL_NAMES) {
    if (!Object.hasOwn(HANDLERS, name)) {
      throw new Error(`Registered tool ${name} has no dispatch handler.`);
    }
  }
  for (const name of Object.keys(HANDLERS)) {
    if (!TOOL_NAMES.includes(name)) {
      throw new Error(`Dispatch handler ${name} is not a registered tool.`);
    }
  }
}

/**
 * Validate, execute, record, return.
 *
 * Order matters and is fixed: the request is validated against the registry
 * schema, the wrapper enforces its own security boundaries and executes,
 * captured output is redacted on capture and again on the way into the store,
 * evidence is appended, and only then does a result reach the caller.
 */
export async function dispatchTool(
  context: ToolContext,
  toolName: string,
  rawParams: unknown,
): Promise<ToolInvocation> {
  const name = safeToolName(toolName);
  const descriptor = findTool(toolName);

  if (descriptor === undefined) {
    const record = context.store.append({
      toolName: name,
      outcome: 'error',
      parameters: toJson(rawParams),
      error: { name: 'UnknownToolError', message: `No registered tool named ${name}.` },
    });
    throw new ToolDispatchError(`No registered tool named ${name}.`, {
      evidenceId: record.evidenceId,
      toolName: name,
    });
  }

  const parsed = descriptor.parameters.safeParse(rawParams);
  if (!parsed.success) {
    const message = `Rejected parameters for ${name}: ${parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')}`;
    const record = context.store.append({
      toolName: name,
      outcome: 'error',
      parameters: toJson(rawParams),
      error: { name: 'ParameterValidationError', message },
    });
    throw new ToolDispatchError(message, { evidenceId: record.evidenceId, toolName: name });
  }

  // Only the validated parameters continue. The raw request is not reused.
  const params = parsed.data;
  const handler = HANDLERS[toolName];
  if (handler === undefined) {
    const record = context.store.append({
      toolName: name,
      outcome: 'error',
      parameters: toJson(params),
      error: { name: 'MissingHandlerError', message: `No dispatch handler for ${name}.` },
    });
    throw new ToolDispatchError(`No dispatch handler for ${name}.`, {
      evidenceId: record.evidenceId,
      toolName: name,
    });
  }

  let outcome: HandlerOutcome;
  try {
    outcome = await handler(context, params as never);
  } catch (error) {
    // A wrapper refused or failed. Record the attempt as an error; do not
    // fabricate an exit code or a result for a tool that produced neither.
    const cause = error instanceof Error ? error : new Error(String(error));
    const record = context.store.append({
      toolName: name,
      outcome: 'error',
      parameters: toJson(params),
      error: { name: cause.name, message: cause.message },
    });
    throw new ToolDispatchError(`Tool ${name} failed: ${cause.message}`, {
      evidenceId: record.evidenceId,
      toolName: name,
      cause,
    });
  }

  const record = context.store.append({
    toolName: name,
    outcome: 'ok',
    parameters: toJson(params),
    result: toJson(withoutExec(outcome.value)),
    ...(outcome.exec === undefined ? {} : { exec: outcome.exec }),
  });

  return { toolName: name, evidenceId: record.evidenceId, result: outcome.value };
}
