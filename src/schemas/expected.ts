/**
 * Fixture expectations (Constitution Article IV).
 *
 * These files are host-owned and human-reviewed. They are the sole scoring
 * source of truth, they are never readable by the model during a run, and the
 * model may never write them. Matching is mechanical: class and identifier
 * equality, never similarity.
 */
import { z } from 'zod';

import { FindingClassSchema } from './findings.js';

export const ExpectedFindingSchema = z.strictObject({
  id: z.string().min(1).max(64),
  class: FindingClassSchema,
  /** When present, the finding must name this Daml construct to count as detected. */
  mustCiteTemplate: z.string().max(128).optional(),
  mustCiteChoice: z.string().max(128).optional(),
});

export const ExpectedInvariantSchema = z.strictObject({
  id: z.string().min(1).max(64),
  class: FindingClassSchema,
});

export const GeneratedTestExpectationsSchema = z.strictObject({
  mustCompile: z.boolean(),
  /**
   * Best-effort signal. A compiling, passing generated test shows a property
   * was exercised; it is not proof the intended property was proven.
   */
  mustExposeExpectedBehavior: z.boolean(),
});

export const ExpectedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  fixtureId: z.string().min(1).max(64),
  damlSdkVersion: z.string().min(1).max(32),
  description: z.string().min(1).max(2_000),
  expectedFindings: z.array(ExpectedFindingSchema).min(1).max(50),
  expectedInvariants: z.array(ExpectedInvariantSchema).max(50),
  /** Classes that are acceptable but not required, and so never false positives. */
  allowedExtraClasses: z.array(FindingClassSchema).max(50),
  generatedTestExpectations: GeneratedTestExpectationsSchema,
  /** Human-written oracle Script, as `Module:script`. */
  oracleScript: z.string().min(1).max(256),
});

export type Expected = z.infer<typeof ExpectedSchema>;
export type ExpectedFinding = z.infer<typeof ExpectedFindingSchema>;
