/**
 * Host-owned report assembly (T067).
 *
 * The model is never asked to write the report. It is not asked for a summary,
 * a finding state, an evidence list, a token count, or a sentence about what
 * the run proved. Everything below is assembled by the host from three sources
 * it already holds: artifacts that passed Zod validation, results the host
 * observed while running the toolchain itself, and the evidence store.
 *
 * That is the whole point of the phase. By the time a run reaches here, the
 * interesting claims have already been tested; letting a model narrate the
 * outcome would reintroduce, at the last step, exactly the unchecked assertion
 * the rest of the system exists to prevent.
 *
 * The builder does no security reasoning. Candidate findings are not invented
 * here — they are scenarios that the analysis phases produced and that
 * execution evidence supports, mapped across mechanically:
 *
 *   invariant   → class, template, choice, statement
 *   scenario    → title, severity, description, and the invariant it targets
 *   generated   → the Script that tried it, and what it declared beforehand
 *   execution   → what the toolchain actually reported
 *
 * The only judgement the builder makes is the one it is allowed to make: given
 * a declared meaning and an observed outcome, does the evidence support the
 * claim? That comparison is mechanical, which is why it is trustworthy.
 */
import path from 'node:path';

import type { EvidenceStore } from '../evidence/store.js';
import type { UsageTotals } from '../model/usage.js';
import type { EvidenceRef, Finding, Invariant } from '../schemas/findings.js';
import type {
  ExecuteArtifact,
  ExpectedRunOutcome,
  GeneratedTest,
  PhaseArtifact,
} from '../schemas/phases.js';
import {
  BOUNDARY_STATEMENT,
  ReportSchema,
  SCOPE_LIMITATIONS,
  VERIFICATION_NOTE,
  type GeneratedTestResult,
  type Report,
  type RevisionSummary,
  type Toolchain,
} from '../schemas/report.js';
import { hasConfirmingExecution } from '../agent/confirmation.js';

export class ReportBuildError extends Error {
  override readonly name = 'ReportBuildError';
}

/** A validated artifact, as produced by the analysis and test phases. */
export interface ValidatedPhaseArtifact {
  readonly phase: string;
  readonly artifact: unknown;
}

export interface BuildReportInput {
  readonly runId: string;
  /** Target path, already made safe for publication by the caller. */
  readonly targetRelativePath: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly toolchain: Toolchain;
  readonly modelId: string;
  readonly usage: UsageTotals;
  /** Validated Phase 8 artifacts, in order. */
  readonly artifacts: readonly ValidatedPhaseArtifact[];
  /** The tests as last submitted, matching the final execution. */
  readonly generatedTests: readonly GeneratedTest[];
  /** The host-observed final execution, if the run got that far. */
  readonly execution?: ExecuteArtifact;
  readonly revision?: RevisionSummary;
  /** Where generated Scripts were written, relative to the run directory. */
  readonly generatedDirRelativePath?: string;
  readonly degradedPhases: readonly string[];
  readonly store: EvidenceStore;
}

interface ScenarioEntry {
  readonly id: string;
  readonly invariantId: string;
  readonly title: string;
  readonly severity: Finding['severity'];
  readonly description: string;
}

/** A finding paired with the tests offered in support of it. */
interface Candidate {
  readonly finding: Finding;
  readonly supportingTestIds: readonly string[];
}

export interface BuildReportResult {
  readonly report: Report;
  /**
   * Findings that were downgraded during assembly, and why. Surfaced for the
   * caller's logs; the reasons are also written into the finding detail, so the
   * report is self-contained.
   */
  readonly downgrades: readonly { readonly findingId: string; readonly reason: string }[];
}

function artifactFor(artifacts: readonly ValidatedPhaseArtifact[], phase: string): unknown {
  return artifacts.find((entry) => entry.phase === phase)?.artifact;
}

/** Keep only references that resolve. Article I: an unresolvable citation is not evidence. */
function resolvableEvidence(
  store: EvidenceStore,
  refs: readonly EvidenceRef[],
): { readonly kept: EvidenceRef[]; readonly dropped: string[] } {
  const kept: EvidenceRef[] = [];
  const dropped: string[] = [];

  for (const ref of refs) {
    if (store.has(ref.evidenceId)) kept.push(ref);
    else dropped.push(ref.evidenceId);
  }
  return { kept, dropped };
}

/**
 * Turn scenarios into candidate findings.
 *
 * A scenario becomes a candidate only when a generated test targeted it. A
 * scenario nobody tested is an untested idea, and the report says so through
 * the invariants section rather than by promoting it to a finding.
 */
function collectCandidates(input: BuildReportInput): Candidate[] {
  // The artifacts passed their own schemas before reaching here, so these
  // casts describe validated shapes rather than assumed ones.
  const scenarios =
    (
      artifactFor(input.artifacts, 'scenarios') as
        { scenarios: readonly ScenarioEntry[] } | undefined
    )?.scenarios ?? [];

  const invariants = new Map(
    (
      (
        artifactFor(input.artifacts, 'invariants') as
          { invariants: readonly Invariant[] } | undefined
      )?.invariants ?? []
    ).map((invariant) => [invariant.id, invariant]),
  );

  const candidates: Candidate[] = [];

  for (const scenario of scenarios) {
    const invariant = invariants.get(scenario.invariantId);
    if (invariant === undefined) {
      // Should not happen: the scenarios phase cross-checks this. If it does,
      // the scenario is dropped rather than reported against a class the host
      // would have to guess.
      continue;
    }

    const tests = input.generatedTests.filter((test) => test.scenarioId === scenario.id);
    if (tests.length === 0) continue;

    const supported = tests.some((test) => indicatesViolation(test, input.execution));
    const evidence = collectCandidateEvidence(input, invariant, tests);

    candidates.push({
      finding: {
        id: `finding-${scenario.id}`,
        class: invariant.class,
        title: scenario.title,
        detail: describeCandidate(
          scenario.description,
          invariant.statement,
          tests,
          input.execution,
        ),
        ...(invariant.template === undefined ? {} : { template: invariant.template }),
        ...(invariant.choice === undefined ? {} : { choice: invariant.choice }),
        severity: scenario.severity,
        // Provisional. The gate below decides what survives.
        state: supported ? 'confirmed' : 'unconfirmed',
        evidence,
      },
      supportingTestIds: tests.map((test) => test.id),
    });
  }

  return candidates;
}

/**
 * Did the run observe the outcome the test declared would mean a violation?
 *
 * Both halves are required. The outcome has to be the one flagged in advance,
 * and the test has to have actually reached that outcome by running: a script
 * that never compiled has an `outcome` of `compile_failed`, which is neither.
 */
function indicatesViolation(test: GeneratedTest, execution: ExecuteArtifact | undefined): boolean {
  const result = execution?.results.find((entry) => entry.testId === test.id);
  if (result === undefined || !result.compiled || result.passed === undefined) return false;
  if (result.outcome !== 'executed_expected' && result.outcome !== 'executed_contradiction') {
    return false;
  }

  const observed: ExpectedRunOutcome = result.passed ? 'script_passes' : 'script_fails';
  return observed === test.violationIndicatedBy;
}

function collectCandidateEvidence(
  input: BuildReportInput,
  invariant: Invariant,
  tests: readonly GeneratedTest[],
): EvidenceRef[] {
  const refs: EvidenceRef[] = [...invariant.evidence];

  for (const test of tests) {
    refs.push(...test.evidence);
    const result = input.execution?.results.find((entry) => entry.testId === test.id);
    if (result === undefined) continue;
    refs.push({ evidenceId: result.compileEvidenceId, note: `compile of ${test.scriptName}` });
    if (result.evidenceId !== undefined) {
      refs.push({ evidenceId: result.evidenceId, note: `execution of ${test.scriptName}` });
    }
  }

  // Deduplicate on the identifier, keeping the first note.
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.evidenceId)) return false;
    seen.add(ref.evidenceId);
    return true;
  });
}

/** Mechanical prose: scenario text plus what the toolchain reported. */
function describeCandidate(
  description: string,
  statement: string,
  tests: readonly GeneratedTest[],
  execution: ExecuteArtifact | undefined,
): string {
  const lines = [`Invariant under test: ${statement}`, `Attempted misuse: ${description}`];

  for (const test of tests) {
    const result = execution?.results.find((entry) => entry.testId === test.id);
    lines.push(
      result === undefined
        ? `Generated Script ${test.scriptName} was not executed.`
        : `Generated Script ${test.scriptName} (attempt ${String(result.attempt)}): ${result.outcome}. ` +
            `It declared ${test.expectedOutcome} before running, and a violation would be indicated by ` +
            `${test.violationIndicatedBy}.`,
    );
  }

  return lines.join('\n');
}

/**
 * Apply the confirmation and evidence rules.
 *
 * Three things must hold for a finding to keep `confirmed`:
 *   1. every evidence reference it carries resolves in the store;
 *   2. Phase 9's gate accepts it, which requires a supporting test that
 *      compiled, executed, and matched its pre-declared expectation;
 *   3. after dropping unresolvable references, at least one remains, since a
 *      confirmed finding without evidence is not representable anyway.
 *
 * Anything short of that is downgraded to `unconfirmed` with the reason
 * recorded in the finding itself. Nothing is deleted and no substitute evidence
 * identifier is ever synthesised.
 */
function gate(
  input: BuildReportInput,
  candidates: readonly Candidate[],
): { readonly findings: Finding[]; readonly downgrades: BuildReportResult['downgrades'] } {
  const findings: Finding[] = [];
  const downgrades: { findingId: string; reason: string }[] = [];

  for (const candidate of candidates) {
    const { kept, dropped } = resolvableEvidence(input.store, candidate.finding.evidence);
    const reasons: string[] = [];

    if (dropped.length > 0) {
      reasons.push(
        `${String(dropped.length)} cited evidence reference(s) did not resolve to a recorded tool invocation.`,
      );
    }

    if (candidate.finding.state === 'confirmed') {
      if (input.execution === undefined) {
        reasons.push('No execution was observed for this run.');
      } else if (!hasConfirmingExecution(input.execution, candidate.supportingTestIds)) {
        reasons.push(
          'No supporting generated test both compiled and executed to the outcome it declared beforehand.',
        );
      }
      if (kept.length === 0) reasons.push('No resolvable evidence remained.');
    }

    if (candidate.finding.state === 'confirmed' && reasons.length === 0) {
      findings.push({ ...candidate.finding, state: 'confirmed', evidence: kept });
      continue;
    }

    const reason = reasons.join(' ');
    if (candidate.finding.state === 'confirmed') {
      downgrades.push({ findingId: candidate.finding.id, reason });
    }

    findings.push({
      ...candidate.finding,
      state: 'unconfirmed',
      evidence: kept,
      detail:
        reasons.length === 0
          ? candidate.finding.detail
          : `${candidate.finding.detail}\nNot confirmed: ${reason}`,
    });
  }

  return { findings, downgrades };
}

/** Invariants, with unresolvable citations removed. */
function collectInvariants(input: BuildReportInput): Invariant[] {
  const invariants =
    (artifactFor(input.artifacts, 'invariants') as { invariants: readonly Invariant[] } | undefined)
      ?.invariants ?? [];

  return invariants.map((invariant) => ({
    ...invariant,
    evidence: resolvableEvidence(input.store, invariant.evidence).kept,
  }));
}

function collectGeneratedTests(input: BuildReportInput): GeneratedTestResult[] {
  const generatedDir = input.generatedDirRelativePath ?? 'generated';

  return input.generatedTests.flatMap((test) => {
    const result = input.execution?.results.find((entry) => entry.testId === test.id);
    if (result === undefined) return [];

    return [
      {
        id: test.id,
        scenarioId: test.scenarioId,
        // Host-derived, exactly as the write boundary constructed it.
        relativePath: path.posix.join(generatedDir, `${test.scriptName}.daml`),
        attempt: result.attempt,
        expectedOutcome: test.expectedOutcome,
        outcome: result.outcome,
        compiled: result.compiled,
        ...(result.passed === undefined ? {} : { passed: result.passed }),
        compileEvidenceId: result.compileEvidenceId,
        ...(result.evidenceId === undefined ? {} : { evidenceId: result.evidenceId }),
      },
    ];
  });
}

/** Counts, not conclusions. */
function summarise(
  findings: readonly Finding[],
  tests: readonly GeneratedTestResult[],
  input: BuildReportInput,
): string {
  const confirmed = findings.filter((finding) => finding.state === 'confirmed').length;
  const unconfirmed = findings.filter((finding) => finding.state === 'unconfirmed').length;
  const executed = tests.filter((test) => test.evidenceId !== undefined).length;

  const lines = [
    `Analysed ${input.targetRelativePath} and produced ${String(findings.length)} finding(s): ` +
      `${String(confirmed)} confirmed, ${String(unconfirmed)} unconfirmed.`,
    `${String(tests.length)} adversarial Daml Script(s) were generated, of which ` +
      `${String(tests.filter((test) => test.compiled).length)} compiled and ${String(executed)} executed ` +
      `on Daml SDK ${input.toolchain.damlSdkVersion}.`,
  ];

  if (input.revision?.exhausted === true) {
    lines.push(
      `The revision budget of ${String(input.revision.maxRevisions)} was exhausted with a correction ` +
        'still outstanding, so the last observed state is reported as it stood.',
    );
  } else if (input.revision !== undefined && input.revision.revisions > 0) {
    lines.push(
      `${String(input.revision.revisions)} host-ordered revision(s) were required before the ` +
        'generated tests compiled and ran.',
    );
  }

  if (input.degradedPhases.length > 0) {
    lines.push(
      `The following phase(s) did not complete and their conclusions are absent: ${input.degradedPhases.join(', ')}.`,
    );
  }

  return lines.join(' ');
}

/** Assemble and validate the report. */
export function buildReport(input: BuildReportInput): BuildReportResult {
  if (input.completedAt.getTime() < input.startedAt.getTime()) {
    throw new ReportBuildError('Run completed before it started.');
  }

  const { findings, downgrades } = gate(input, collectCandidates(input));
  const generatedTests = collectGeneratedTests(input);

  const draft = {
    schemaVersion: 1 as const,
    runId: input.runId,
    target: { relativePath: input.targetRelativePath },
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    toolchain: input.toolchain,
    model: { id: input.modelId },
    usage: {
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cacheCreationInputTokens: input.usage.cacheCreationInputTokens,
      cacheReadInputTokens: input.usage.cacheReadInputTokens,
      modelCalls: input.usage.modelCalls,
      toolInvocations: input.usage.toolCallsDispatched,
      toolInvocationsRefused: input.usage.toolCallsRefused,
    },
    findings,
    invariants: collectInvariants(input),
    generatedTests,
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    degradedPhases: [...input.degradedPhases],
    summary: summarise(findings, generatedTests, input),
    verification: { note: VERIFICATION_NOTE, scopeLimitations: [...SCOPE_LIMITATIONS] },
    boundaryStatement: BOUNDARY_STATEMENT,
  };

  // The host validates its own output. A builder bug should fail here rather
  // than become a published report nobody checked.
  const parsed = ReportSchema.safeParse(draft);
  if (!parsed.success) {
    throw new ReportBuildError(
      `Assembled report failed its own schema: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  return { report: parsed.data, downgrades };
}

/**
 * The host's `report` phase artifact.
 *
 * The phase machine gates every transition on a schema-valid artifact. The
 * report phase satisfies that with a projection of the report the host just
 * built, so the gate is met by host-verified data rather than by asking a model
 * to write a tenth artifact whose contents would then need checking against the
 * evidence anyway.
 */
export function reportPhaseArtifact(report: Report): PhaseArtifact {
  return {
    phase: 'report',
    findings: report.findings,
    invariants: report.invariants,
    summary: report.summary,
    evidence: report.findings.flatMap((finding) => finding.evidence),
  };
}
