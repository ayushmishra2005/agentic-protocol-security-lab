/**
 * Phase artifacts for the host-owned state machine.
 *
 * The phase sequence is a host constant, not a model-supplied string. Each
 * artifact carries a `phase` discriminant, so an artifact produced for one
 * phase cannot satisfy another phase's schema.
 */
import { z } from 'zod';

import { EvidenceRefSchema, FindingSchema, InvariantSchema } from './findings.js';

/** Model-facing phases, in the only order the host will run them. */
export const MODEL_PHASE_SEQUENCE = [
  'understand',
  'inspect',
  'threat_model',
  'invariants',
  'auth_semantics',
  'scenarios',
  'generate_tests',
  'execute',
  'revise',
  'report',
] as const;

export type ModelPhase = (typeof MODEL_PHASE_SEQUENCE)[number];

/** Host-only stage. Deliberately outside the model phase union. */
export const HOST_ONLY_PHASE = 'evaluate' as const;

export const ModelPhaseSchema = z.enum(MODEL_PHASE_SEQUENCE);

const withEvidence = { evidence: z.array(EvidenceRefSchema) };

export const UnderstandArtifactSchema = z.strictObject({
  phase: z.literal('understand'),
  summary: z.string().min(1).max(4_000),
  damlPackages: z.array(z.string().max(512)).max(200),
  ...withEvidence,
});

export const InspectArtifactSchema = z.strictObject({
  phase: z.literal('inspect'),
  inspectedFiles: z.array(z.string().max(512)).max(500),
  changeSummary: z.string().max(4_000).optional(),
  ...withEvidence,
});

export const ThreatModelArtifactSchema = z.strictObject({
  phase: z.literal('threat_model'),
  threats: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(64),
        actor: z.string().min(1).max(200),
        capability: z.string().min(1).max(1_000),
        impact: z.string().min(1).max(1_000),
        template: z.string().max(128).optional(),
      }),
    )
    .max(100),
  ...withEvidence,
});

export const InvariantsArtifactSchema = z.strictObject({
  phase: z.literal('invariants'),
  invariants: z.array(InvariantSchema).max(100),
  ...withEvidence,
});

export const AuthSemanticsArtifactSchema = z.strictObject({
  phase: z.literal('auth_semantics'),
  templates: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(128),
        signatories: z.array(z.string().max(128)).max(50),
        observers: z.array(z.string().max(128)).max(50),
        choices: z
          .array(
            z.strictObject({
              name: z.string().min(1).max(128),
              controllers: z.array(z.string().max(128)).max(50),
              consuming: z.boolean(),
              choiceObservers: z.array(z.string().max(128)).max(50).optional(),
            }),
          )
          .max(100),
        /** True when derived from the labelled heuristic extractor rather than tooling. */
        heuristic: z.boolean(),
      }),
    )
    .max(200),
  ...withEvidence,
});

export const ScenariosArtifactSchema = z.strictObject({
  phase: z.literal('scenarios'),
  scenarios: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(64),
        invariantId: z.string().min(1).max(64),
        description: z.string().min(1).max(2_000),
      }),
    )
    .max(100),
  ...withEvidence,
});

/**
 * What the host expects to observe when it runs the script, declared before it
 * runs. Deliberately coarse: these are the two outcomes the host can read off a
 * JUnit result without interpreting Daml, so the comparison that decides
 * whether revision is required stays mechanical.
 *
 * The richer, ledger-level claim lives in `expectedBehavior` as prose. It is
 * for the report, not for the comparison, because prose cannot be compared.
 */
export const ExpectedRunOutcomeSchema = z.enum(['script_passes', 'script_fails']);

/**
 * One generated adversarial Script.
 *
 * `scriptName` is a Daml module name, not a path. The host builds the filename
 * from it; see `src/agent/writeBoundary.ts`. There is deliberately no
 * destination field: a model that could name its own output path would have a
 * filesystem write primitive in all but name.
 */
export const GeneratedTestSchema = z.strictObject({
  id: z.string().min(1).max(64),
  scenarioId: z.string().min(1).max(64),
  scriptName: z
    .string()
    .regex(/^[A-Z][A-Za-z0-9_]{0,63}$/, 'Script name must be a Daml module name'),
  entryPoint: z
    .string()
    .regex(/^[a-z][A-Za-z0-9_']{0,63}$/, 'Entry point must be a Daml binding name'),
  source: z.string().min(1).max(20_000),
  /** The invariant or property this Script is trying to violate. */
  property: z.string().min(1).max(1_000),
  expectedOutcome: ExpectedRunOutcomeSchema,
  /** Ledger-level statement of what should happen, for the report. */
  expectedBehavior: z.string().min(1).max(1_000),
  ...withEvidence,
});

export const GenerateTestsArtifactSchema = z.strictObject({
  phase: z.literal('generate_tests'),
  tests: z.array(GeneratedTestSchema).min(1).max(20),
  ...withEvidence,
});

/**
 * The four states a generated test can end in (T063).
 *
 * `compile_failed` and `execution_failed` are about the test; the run learned
 * nothing about the target from either. `executed_expected` and
 * `executed_contradiction` are about the target: the script ran, and what it
 * did either matched what it declared beforehand or did not.
 *
 * Kept apart on purpose. Collapsing "it never built" into "it failed" would let
 * a broken test read as a security result.
 */
export const TestOutcomeSchema = z.enum([
  'compile_failed',
  'execution_failed',
  'executed_expected',
  'executed_contradiction',
]);

export const ExecuteArtifactSchema = z.strictObject({
  phase: z.literal('execute'),
  results: z
    .array(
      z.strictObject({
        testId: z.string().min(1).max(64),
        /** 1 on the first run, incremented by each host-ordered revision. */
        attempt: z.number().int().min(1).max(10),
        outcome: TestOutcomeSchema,
        compiled: z.boolean(),
        /** Absent when the script never compiled, so it never ran. */
        passed: z.boolean().optional(),
        /** Evidence for the compile step. Always present. */
        compileEvidenceId: z.string().min(1).max(64),
        /** Evidence for the run. Absent when compilation failed. */
        evidenceId: z.string().min(1).max(64).optional(),
      }),
    )
    .max(100),
  ...withEvidence,
});

/** The only two conditions under which the host orders a revision. */
export const RevisionReasonSchema = z.enum(['compilation_failure', 'contradicted_expectation']);

export const ReviseArtifactSchema = z.strictObject({
  phase: z.literal('revise'),
  attempt: z.number().int().min(1).max(10),
  /**
   * Echoes the reason the host supplied. The host does not read this back as a
   * decision — it already made the decision — but a revision that misstates why
   * it was asked for is a sign the diagnostics were misread.
   */
  reason: RevisionReasonSchema,
  changes: z.array(z.string().max(1_000)).max(100),
  /** Corrected versions of the tests. Rewritten in full, not patched. */
  tests: z.array(GeneratedTestSchema).min(1).max(20),
  ...withEvidence,
});

export const ReportArtifactSchema = z.strictObject({
  phase: z.literal('report'),
  findings: z.array(FindingSchema).max(200),
  invariants: z.array(InvariantSchema).max(100),
  summary: z.string().min(1).max(8_000),
  ...withEvidence,
});

export const PhaseArtifactSchema = z.discriminatedUnion('phase', [
  UnderstandArtifactSchema,
  InspectArtifactSchema,
  ThreatModelArtifactSchema,
  InvariantsArtifactSchema,
  AuthSemanticsArtifactSchema,
  ScenariosArtifactSchema,
  GenerateTestsArtifactSchema,
  ExecuteArtifactSchema,
  ReviseArtifactSchema,
  ReportArtifactSchema,
]);

export type PhaseArtifact = z.infer<typeof PhaseArtifactSchema>;
export type GeneratedTest = z.infer<typeof GeneratedTestSchema>;
export type TestOutcome = z.infer<typeof TestOutcomeSchema>;
export type ExpectedRunOutcome = z.infer<typeof ExpectedRunOutcomeSchema>;
export type RevisionReason = z.infer<typeof RevisionReasonSchema>;
export type ExecuteArtifact = z.infer<typeof ExecuteArtifactSchema>;
export type GenerateTestsArtifact = z.infer<typeof GenerateTestsArtifactSchema>;
export type ReviseArtifact = z.infer<typeof ReviseArtifactSchema>;

const PHASE_SCHEMAS = {
  understand: UnderstandArtifactSchema,
  inspect: InspectArtifactSchema,
  threat_model: ThreatModelArtifactSchema,
  invariants: InvariantsArtifactSchema,
  auth_semantics: AuthSemanticsArtifactSchema,
  scenarios: ScenariosArtifactSchema,
  generate_tests: GenerateTestsArtifactSchema,
  execute: ExecuteArtifactSchema,
  revise: ReviseArtifactSchema,
  report: ReportArtifactSchema,
} as const satisfies Record<ModelPhase, z.ZodType>;

/** Schema for exactly one phase. Parsing with the wrong phase's schema fails. */
export function schemaForPhase<P extends ModelPhase>(phase: P): (typeof PHASE_SCHEMAS)[P] {
  return PHASE_SCHEMAS[phase];
}

/** The phase that follows `phase`, or undefined at the end of the sequence. */
export function nextPhase(phase: ModelPhase): ModelPhase | undefined {
  const index = MODEL_PHASE_SEQUENCE.indexOf(phase);
  return MODEL_PHASE_SEQUENCE[index + 1];
}
