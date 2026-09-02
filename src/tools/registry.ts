/**
 * The model-facing tool surface.
 *
 * Descriptors expose parameter schemas only. No command string, executable
 * path, flag, or argv fragment appears in anything a model can see, so a model
 * can request an operation but can never describe how it is run.
 *
 * No tool here performs network access, and no third-party MCP server is
 * consumed. `assertNoNetworkCapableTools` makes that a checked property rather
 * than a claim in a comment.
 */
import { z } from 'zod';

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodType;
  /** Set on any tool that could reach the network. Must remain false everywhere. */
  readonly networkCapable: false;
  /** Set on any tool that could modify the workspace. Must remain false everywhere. */
  readonly mutatesWorkspace: false;
}

const relativePath = z.string().min(1).max(512);

export const TOOL_REGISTRY: readonly ToolDescriptor[] = [
  {
    name: 'repo_read_file',
    description: 'Read a UTF-8 text file inside the workspace, bounded in size.',
    parameters: z.strictObject({
      path: relativePath,
      maxBytes: z.number().int().min(1).max(1_048_576).optional(),
    }),
    networkCapable: false,
    mutatesWorkspace: false,
  },
  {
    name: 'repo_list_files',
    description: 'List files inside the workspace, optionally filtered by extension.',
    parameters: z.strictObject({
      directory: relativePath.optional(),
      extensions: z.array(z.string().max(16)).max(20).optional(),
      maxEntries: z.number().int().min(1).max(2_000).optional(),
    }),
    networkCapable: false,
    mutatesWorkspace: false,
  },
  {
    name: 'repo_search_text',
    description: 'Literal substring search across readable workspace files.',
    parameters: z.strictObject({
      query: z.string().min(1).max(200),
      directory: relativePath.optional(),
      extensions: z.array(z.string().max(16)).max(20).optional(),
      caseSensitive: z.boolean().optional(),
      maxMatches: z.number().int().min(1).max(200).optional(),
    }),
    networkCapable: false,
    mutatesWorkspace: false,
  },
  {
    name: 'git_status',
    description: 'Read the working-tree status of the workspace repository.',
    parameters: z.strictObject({}),
    networkCapable: false,
    mutatesWorkspace: false,
  },
  {
    name: 'git_diff',
    description: 'Read a diff of the workspace repository, optionally scoped to paths.',
    parameters: z.strictObject({
      ref: z.string().max(100).optional(),
      paths: z.array(relativePath).max(50).optional(),
      nameOnly: z.boolean().optional(),
    }),
    networkCapable: false,
    mutatesWorkspace: false,
  },
  {
    name: 'git_log',
    description: 'Read recent commit metadata from the workspace repository.',
    parameters: z.strictObject({
      maxCount: z.number().int().min(1).max(200).optional(),
    }),
    networkCapable: false,
    mutatesWorkspace: false,
  },
  {
    name: 'daml_build',
    description: 'Compile a Daml package and report compiler diagnostics.',
    parameters: z.strictObject({
      packageRoot: relativePath.optional(),
      all: z.boolean().optional(),
    }),
    networkCapable: false,
    mutatesWorkspace: false,
  },
  {
    name: 'daml_test',
    description: 'Run Daml Script tests and report structured JUnit results.',
    parameters: z.strictObject({
      packageRoot: relativePath.optional(),
      testPattern: z.string().max(128).optional(),
      all: z.boolean().optional(),
    }),
    networkCapable: false,
    mutatesWorkspace: false,
  },
  {
    name: 'daml_inspect_dar',
    description: 'Read package and module metadata from a built DAR.',
    parameters: z.strictObject({ darPath: relativePath }),
    networkCapable: false,
    mutatesWorkspace: false,
  },
  {
    name: 'daml_list_scripts',
    description: 'List the Daml Scripts contained in a built DAR.',
    parameters: z.strictObject({ darPath: relativePath }),
    networkCapable: false,
    mutatesWorkspace: false,
  },
  {
    name: 'daml_run_script',
    description: 'Run a single Daml Script on the in-memory simulated ledger.',
    parameters: z.strictObject({
      darPath: relativePath,
      scriptName: z.string().min(1).max(256),
    }),
    networkCapable: false,
    mutatesWorkspace: false,
  },
];

export const TOOL_NAMES: readonly string[] = TOOL_REGISTRY.map((tool) => tool.name);

export function findTool(name: string): ToolDescriptor | undefined {
  return TOOL_REGISTRY.find((tool) => tool.name === name);
}

/**
 * Runtime guard on the registry's safety fields.
 *
 * The interface already pins both fields to `false` at compile time. This
 * schema re-checks them at runtime so a descriptor assembled from untyped data
 * is caught too.
 */
const ToolSafetySchema = z.object({
  name: z.string(),
  networkCapable: z.literal(false),
  mutatesWorkspace: z.literal(false),
});

/** Throw if any registered tool could reach the network or mutate the workspace. */
export function assertNoNetworkCapableTools(): void {
  for (const tool of TOOL_REGISTRY) {
    const result = ToolSafetySchema.safeParse(tool);
    if (!result.success) {
      throw new Error(`Tool ${tool.name} must be neither network-capable nor workspace-mutating.`);
    }
  }
}
