/**
 * The structured report is the source of truth; Markdown is a rendering of it
 * (Constitution Article I). Article VI requires the capability boundary to
 * travel with every published output, so it is a required literal here rather
 * than a template string someone can forget.
 */
import { z } from 'zod';

import { FindingSchema, InvariantSchema } from './findings.js';

export const BOUNDARY_STATEMENT = 'AI review and research prototype, not a formal security audit.';

/**
 * What `confirmed` means here, stated in the report rather than left to the
 * reader's assumptions about the word.
 *
 * A generated Script that compiled, ran, and did what it said it would do is
 * evidence that a specific scenario was exercised on the pinned toolchain. It
 * is not a proof that the Script encoded the invariant correctly, that other
 * executions are safe, or that the package is secure. Publishing the strong
 * word without the narrow meaning attached is how a prototype's output ends up
 * quoted as an audit result.
 */
export const VERIFICATION_NOTE =
  'A confirmed finding means a generated Daml Script compiled, executed on the pinned toolchain, ' +
  'and produced the outcome it declared before it ran. That is execution-backed evidence that the ' +
  'scenario was exercised, not a proof that the invariant was encoded correctly, that all ' +
  'executions are safe, or that the package is secure.';

/** Scope this prototype does and does not cover. Emitted with every report. */
export const SCOPE_LIMITATIONS: readonly string[] = [
  'Covers Daml language-level authorization and privacy semantics only: signatories, observers, ' +
    'controllers, and choice structure.',
  'Results hold for the pinned Daml toolchain recorded in this report, and were produced by ' +
    'compiling and running generated Scripts locally.',
  'Makes no claim about Canton network security: sequencers, mediators, participant nodes, ' +
    'topology, and operational deployment are all out of scope.',
  'Does not cover Daml Finance or any other library beyond the analysed package source.',
  'No formal verification is performed. Absence of a finding is not evidence of absence.',
  'Not a production security audit, and not a substitute for review by a qualified auditor.',
];

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
  /** Provider responses received. Host-counted, one per completed call. */
  modelCalls: z.number().int().min(0),
  /** Tool invocations the host dispatched. Counted from evidence, not reported. */
  toolInvocations: z.number().int().min(0),
  /** Tool requests the host refused. Kept separate so refusals stay visible. */
  toolInvocationsRefused: z.number().int().min(0),
});

export const GeneratedTestResultSchema = z.strictObject({
  id: z.string().min(1).max(64),
  scenarioId: z.string().min(1).max(64),
  /** Path inside the run's generated directory. Host-chosen. */
  relativePath: z.string().min(1).max(512),
  /** Which attempt produced this result: 1, plus one per host-ordered revision. */
  attempt: z.number().int().min(1).max(10),
  /** The outcome the test declared before it ran. */
  expectedOutcome: z.enum(['script_passes', 'script_fails']),
  outcome: z.enum([
    'compile_failed',
    'execution_failed',
    'executed_expected',
    'executed_contradiction',
  ]),
  compiled: z.boolean(),
  passed: z.boolean().optional(),
  compileEvidenceId: z.string().min(1).max(64),
  /** Absent when the test never compiled, because then it never ran. */
  evidenceId: z.string().min(1).max(64).optional(),
});

/**
 * The state of the bounded revision cycle.
 *
 * `exhausted` is reported rather than hidden: a run that never got its test to
 * compile within the budget has produced a result about itself, and the report
 * has to say so instead of presenting the last attempt as the answer.
 */
export const RevisionSummarySchema = z.strictObject({
  attempts: z.number().int().min(1).max(20),
  revisions: z.number().int().min(0).max(10),
  maxRevisions: z.number().int().min(0).max(10),
  exhausted: z.boolean(),
});

/** The meaning of `confirmed`, and the limits of the whole exercise. */
export const VerificationSchema = z.strictObject({
  note: z.literal(VERIFICATION_NOTE),
  scopeLimitations: z.array(z.string().min(1).max(500)).min(1).max(20),
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
  revision: RevisionSummarySchema.optional(),
  /** Phases that exhausted their validation budget and were not completed. */
  degradedPhases: z.array(z.string().max(64)).max(20),
  /**
   * Host-composed. Written from counts the host holds, not from model prose:
   * the model never sees this field and never writes any part of the report.
   */
  summary: z.string().min(1).max(8_000),
  verification: VerificationSchema,
  boundaryStatement: z.literal(BOUNDARY_STATEMENT),
});

export type Report = z.infer<typeof ReportSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type Toolchain = z.infer<typeof ToolchainSchema>;
export type GeneratedTestResult = z.infer<typeof GeneratedTestResultSchema>;
export type RevisionSummary = z.infer<typeof RevisionSummarySchema>;
