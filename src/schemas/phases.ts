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

export const GenerateTestsArtifactSchema = z.strictObject({
  phase: z.literal('generate_tests'),
  tests: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(64),
        scenarioId: z.string().min(1).max(64),
        /** Path relative to the run's generated-output directory. */
        relativePath: z.string().min(1).max(512),
        scriptName: z.string().min(1).max(256),
      }),
    )
    .max(100),
  ...withEvidence,
});

export const ExecuteArtifactSchema = z.strictObject({
  phase: z.literal('execute'),
  results: z
    .array(
      z.strictObject({
        testId: z.string().min(1).max(64),
        compiled: z.boolean(),
        passed: z.boolean().optional(),
        evidenceId: z.string().min(1).max(64),
      }),
    )
    .max(100),
  ...withEvidence,
});

export const ReviseArtifactSchema = z.strictObject({
  phase: z.literal('revise'),
  attempt: z.number().int().min(1).max(10),
  reason: z.enum(['compilation_failure', 'contradicted_expectation']),
  changes: z.array(z.string().max(1_000)).max(100),
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
