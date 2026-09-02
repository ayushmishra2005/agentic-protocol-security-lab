/**
 * The structured report is the source of truth; Markdown is a rendering of it
 * (Constitution Article I). Article VI requires the capability boundary to
 * travel with every published output, so it is a required literal here rather
 * than a template string someone can forget.
 */
import { z } from 'zod';

import { FindingSchema, InvariantSchema } from './findings.js';

export const BOUNDARY_STATEMENT = 'AI review and research prototype, not a formal security audit.';

export const ToolchainSchema = z.strictObject({
  damlSdkVersion: z.string().min(1).max(32),
  dpmVersion: z.string().min(1).max(32),
});

export const ModelIdentitySchema = z.strictObject({
  id: z.string().min(1).max(128),
});

export const UsageSchema = z.strictObject({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheCreationInputTokens: z.number().int().min(0),
  cacheReadInputTokens: z.number().int().min(0),
  toolInvocations: z.number().int().min(0),
});

export const GeneratedTestResultSchema = z.strictObject({
  id: z.string().min(1).max(64),
  relativePath: z.string().min(1).max(512),
  compiled: z.boolean(),
  passed: z.boolean().optional(),
  evidenceId: z.string().min(1).max(64),
});

export const ReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().min(1).max(64),
  target: z.strictObject({
    /** Path relative to the workspace root; absolute host paths are not published. */
    relativePath: z.string().min(1).max(512),
  }),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  toolchain: ToolchainSchema,
  model: ModelIdentitySchema,
  usage: UsageSchema,
  findings: z.array(FindingSchema).max(200),
  invariants: z.array(InvariantSchema).max(100),
  generatedTests: z.array(GeneratedTestResultSchema).max(100),
  /** Phases that exhausted their validation budget and were not completed. */
  degradedPhases: z.array(z.string().max(64)).max(20),
  summary: z.string().min(1).max(8_000),
  boundaryStatement: z.literal(BOUNDARY_STATEMENT),
});

export type Report = z.infer<typeof ReportSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type Toolchain = z.infer<typeof ToolchainSchema>;
