/**
 * The evaluation scorecard (Constitution Article IV).
 *
 * Host-owned in the strongest sense: no model-facing code path can reach the
 * scorer, the model never sees a fixture's `expected.json`, and nothing here is
 * derived from model prose. Every field is either copied from a host-owned
 * expectation, computed from a host-assembled report, or recorded by the CLI.
 *
 * `provenance` exists because a scorecard is exactly the artifact someone will
 * quote out of context. A run driven by a scripted fake client exercises the
 * harness and says nothing about any model's ability, so the distinction is a
 * required field rather than a footnote someone can drop.
 */
import { z } from 'zod';

import { ToolchainSchema, ModelIdentitySchema } from './report.js';

/**
 * Fixed dimension order. Scoring output is compared across runs, so the order
 * is part of the contract rather than whatever the iteration happened to be.
 */
export const SCORE_DIMENSIONS = [
  'expected_finding_detected',
  'expected_finding_confirmed',
  'expected_invariant_generated',
  'test_generated',
  'test_compiled',
  'expected_behavior_exposed',
] as const;

export const ScoreDimensionSchema = z.enum(SCORE_DIMENSIONS);

/**
 * `not_applicable` is not a quiet pass. It is used only where the fixture's own
 * expectation says a dimension is not required, and it is counted separately so
 * a fixture cannot appear to score well by opting out of dimensions.
 */
export const DimensionStatusSchema = z.enum(['pass', 'fail', 'not_applicable']);

export const DimensionResultSchema = z.strictObject({
  dimension: ScoreDimensionSchema,
  status: DimensionStatusSchema,
  /** Host-written, mechanical. Never model text. */
  detail: z.string().min(1).max(500),
  /** Evidence records supporting a pass, when the dimension has any. */
  evidenceIds: z.array(z.string().min(1).max(64)).max(50),
});

export const FixtureScoreSchema = z.strictObject({
  fixtureId: z.string().min(1).max(64),
  runId: z.string().min(1).max(64),
  dimensions: z.array(DimensionResultSchema).length(SCORE_DIMENSIONS.length),
  /** Findings with no evidence reference at all. */
  unsupportedClaims: z.number().int().min(0),
  /**
   * Findings whose class is neither expected nor listed in the fixture's
   * `allowedExtraClasses`. A defensible alternate classification is not a false
   * positive, which is what that list is for.
   */
  falsePositives: z.number().int().min(0),
  /** Phases that exhausted their validation budget during the run. */
  degradedPhases: z.array(z.string().max(64)).max(20),
});

export const AggregateSchema = z.strictObject({
  fixtures: z.number().int().min(0),
  passed: z.record(ScoreDimensionSchema, z.number().int().min(0)),
  failed: z.record(ScoreDimensionSchema, z.number().int().min(0)),
  notApplicable: z.record(ScoreDimensionSchema, z.number().int().min(0)),
  unsupportedClaims: z.number().int().min(0),
  falsePositives: z.number().int().min(0),
});

/**
 * How the reports being scored were produced.
 *
 * `harness_validation` means a deterministic scripted client drove the pipeline:
 * the scorer and the plumbing are under test, not a model. `model_run` is
 * reserved for reports produced by a real provider request.
 */
export const ProvenanceSchema = z.enum(['harness_validation', 'model_run']);

export const SCORECARD_NOTE =
  'Scores are mechanical matches against host-owned expectations: class and identifier equality, ' +
  'never similarity or model judgement. A scorecard with provenance "harness_validation" was ' +
  'produced by a scripted fake client and measures the harness, not any model.';

export const ScorecardSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Allowed to differ between otherwise identical runs. */
  generatedAt: z.iso.datetime(),
  toolchain: ToolchainSchema,
  model: ModelIdentitySchema,
  provenance: ProvenanceSchema,
  note: z.literal(SCORECARD_NOTE),
  results: z.array(FixtureScoreSchema).max(50),
  aggregate: AggregateSchema,
});

export type ScoreDimension = z.infer<typeof ScoreDimensionSchema>;
export type DimensionStatus = z.infer<typeof DimensionStatusSchema>;
export type DimensionResult = z.infer<typeof DimensionResultSchema>;
export type FixtureScore = z.infer<typeof FixtureScoreSchema>;
export type Aggregate = z.infer<typeof AggregateSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type Scorecard = z.infer<typeof ScorecardSchema>;
