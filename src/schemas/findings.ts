/**
 * Findings, invariants and evidence references (Constitution Article I).
 *
 * The central guarantee is structural rather than procedural: `state` is a
 * discriminant, and the `confirmed` member requires a non-empty evidence list.
 * A confirmed finding with no evidence is therefore not representable, so it
 * cannot be constructed, parsed, or serialised — no runtime check to forget.
 */
import { z } from 'zod';

/** Evidence identifiers are allocated by the host evidence store. */
export const EvidenceIdSchema = z
  .string()
  .regex(/^ev_[0-9a-f]{16}$/, 'Evidence id must look like ev_<16 hex chars>');

export const EvidenceRefSchema = z.strictObject({
  evidenceId: EvidenceIdSchema,
  note: z.string().max(500).optional(),
});

/**
 * Finding classes are lower_snake_case strings rather than a closed enum: the
 * scorer must be able to represent a class the model invented, because that is
 * exactly what a false positive is.
 */
export const FindingClassSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Finding class must be lower_snake_case');

/** Classes the MVP fixture set expects. Used by the scorer, not as a constraint. */
export const KNOWN_FINDING_CLASSES = [
  'incorrect_controller',
  'observer_exposure',
  'missing_multi_party_authorization',
  'propose_accept_bypass',
] as const;

export const SeveritySchema = z.enum(['info', 'low', 'medium', 'high']);

const findingCore = {
  id: z.string().min(1).max(64),
  class: FindingClassSchema,
  title: z.string().min(1).max(200),
  detail: z.string().min(1).max(4_000),
  /** Daml construct the finding concerns, when applicable. */
  template: z.string().max(128).optional(),
  choice: z.string().max(128).optional(),
  severity: SeveritySchema,
};

/**
 * Supported by executed tooling. Requires at least one evidence reference.
 * Additionally gated at runtime: a conclusion whose supporting test never
 * compiled must not be promoted to this state.
 */
export const ConfirmedFindingSchema = z.strictObject({
  ...findingCore,
  state: z.literal('confirmed'),
  evidence: z.array(EvidenceRefSchema).min(1),
});

/** Suspected but not established. May carry partial evidence. */
export const UnconfirmedFindingSchema = z.strictObject({
  ...findingCore,
  state: z.literal('unconfirmed'),
  evidence: z.array(EvidenceRefSchema),
});

/** Contradicted by an executed tool result. Must cite the contradicting evidence. */
export const RefutedFindingSchema = z.strictObject({
  ...findingCore,
  state: z.literal('refuted'),
  evidence: z.array(EvidenceRefSchema).min(1),
});

export const FindingSchema = z.discriminatedUnion('state', [
  ConfirmedFindingSchema,
  UnconfirmedFindingSchema,
  RefutedFindingSchema,
]);

export const InvariantSchema = z.strictObject({
  id: z.string().min(1).max(64),
  class: FindingClassSchema,
  /** Stated so that a generated Daml Script can target it. */
  statement: z.string().min(1).max(1_000),
  template: z.string().max(128).optional(),
  choice: z.string().max(128).optional(),
  /**
   * Required, unlike a finding's.
   *
   * Article I obliges every finding *and every invariant* to carry a resolvable
   * evidence reference. Findings have an explicit carve-out — one with no
   * evidence is emitted as unsupported and counted as a scored defect — and
   * invariants have none, so the obligation is enforced here in the schema
   * rather than left to whoever assembles the report.
   *
   * An invariant is a claim about what the target guarantees. Stated with
   * nothing behind it, it is the exact shape of assertion this pipeline exists
   * to refuse: it reads as a property of the code while being a property of the
   * model's prose. References are checked for resolution at the report
   * boundary; one that cannot be resolved is not evidence.
   */
  evidence: z.array(EvidenceRefSchema).min(1),
});

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type ConfirmedFinding = z.infer<typeof ConfirmedFindingSchema>;
export type Invariant = z.infer<typeof InvariantSchema>;
export type Severity = z.infer<typeof SeveritySchema>;

/** A conclusion with no evidence references is an unsupported claim. */
export function isUnsupportedClaim(item: { evidence: readonly EvidenceRef[] }): boolean {
  return item.evidence.length === 0;
}
