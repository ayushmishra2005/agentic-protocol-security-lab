/**
 * `analyze <path>` (T071).
 *
 * This file wires together components that already exist. It contains no
 * analysis loop of its own: the phase order lives in `runAnalysis`, the
 * generate/execute/revise branch lives in `runTestCycle` and `PhaseMachine`,
 * the confirmation rules live in `buildReport`, and the document lives in
 * `renderReport`. What is decided here is the run's identity, where its files
 * go, and which failures stop it.
 *
 * Two distinctions carry most of the weight.
 *
 * Fatal versus degraded. A run that cannot be set up honestly — a missing
 * target, a project with no Daml package, a toolchain that is not the pinned
 * one — refuses to start, because everything downstream would be about
 * something other than what the user asked for. A run whose *analysis* falls
 * short — a phase that could not produce a valid artifact, a generated test
 * that never compiled, a revision budget spent — still produces a report. That
 * report is the honest outcome, and turning it into a crash would discard
 * evidence the host paid to collect.
 *
 * Generic target versus benchmark fixture. Analysing a user's project hides
 * nothing: no filename is treated as secret, and a file called `expected.json`
 * in someone's repository is just a file. Withholding the benchmark's own
 * answers is a property of evaluating our fixtures, requested explicitly
 * through `hostOnlyEntries`, not a global rule about names.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createExecutionWorkspace } from '../agent/execWorkspace.js';
import { runAnalysis } from '../agent/steps/index.js';
import { runTestCycle, type TestCycleResult } from '../agent/steps/testCycle.js';
import { PhaseMachine } from '../agent/phases.js';
import { WriteBoundary } from '../agent/writeBoundary.js';
import { MODEL_LOOP_DEFAULTS } from '../config.js';
import { EvidenceStore } from '../evidence/store.js';
import { AnthropicModelClient, type ModelClient } from '../model/client.js';
import { UsageAccumulator } from '../model/usage.js';
import { buildReport, type BuildReportResult } from '../report/build.js';
import { writeReportOutputs } from '../report/write.js';
import type { Report } from '../schemas/report.js';
import { createWorkspace } from '../security/paths.js';
import type { ToolContext } from '../tools/dispatch.js';
import { assertPinnedToolchain } from '../tools/daml/version.js';

/** A condition that makes the requested analysis impossible. Never a finding. */
export class AnalyzeSetupError extends Error {
  override readonly name = 'AnalyzeSetupError';
}

export interface AnalyzeOptions {
  /** Target path as given on the command line. */
  readonly targetPath: string;
  /** Absolute directory holding per-run output. */
  readonly runsRoot: string;
  readonly runId?: string;
  /**
   * Supplies the model client. Injected so tests can drive the pipeline with a
   * fake and never touch a credential; the default constructs the real client.
   */
  readonly createClient?: () => ModelClient;
  /** Root-relative entries to withhold. Empty for an ordinary project. */
  readonly hostOnlyEntries?: readonly string[];
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface AnalyzeResult {
  readonly runId: string;
  readonly runDirectory: string;
  readonly report: Report;
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly downgrades: BuildReportResult['downgrades'];
  /** Present when the run produced a report despite falling short. */
  readonly degradedAt?: string;
}

/** `run_<utc timestamp>` — sortable, and a legal single path segment. */
function defaultRunId(now: Date): string {
  return `run_${now.toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Locate the Daml package to analyse.
 *
 * A directory with no `daml.yaml` anywhere near the top is not a Daml project,
 * and refusing here is more useful than producing a report about nothing.
 */
function assertDamlProject(root: string): void {
  if (fs.existsSync(path.join(root, 'daml.yaml'))) return;

  const hasChildPackage = fs
    .readdirSync(root, { withFileTypes: true })
    .some(
      (entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'daml.yaml')),
    );

  if (!hasChildPackage) {
    throw new AnalyzeSetupError(
      `${root} does not contain a daml.yaml at its root or in an immediate subdirectory, so it is not a Daml project.`,
    );
  }
}

function resolveTarget(targetPath: string): string {
  const absolute = path.resolve(targetPath);
  let real: string;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    throw new AnalyzeSetupError(`Target ${absolute} does not exist.`);
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new AnalyzeSetupError(`Target ${real} is not a directory.`);
  }
  assertDamlProject(real);
  return real;
}

/**
 * Run the full pipeline and write the report.
 *
 * Setup failures throw. Analysis shortfalls do not: they travel into the report
 * as degraded phases, uncompiled tests, revision exhaustion, and findings that
 * did not earn confirmation.
 */
export async function analyze(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();

  // Fatal, and checked before anything is created: a wrong toolchain would
  // silently change what every later result means.
  const target = resolveTarget(options.targetPath);
  const toolchain = await assertPinnedToolchain();

  const runId = options.runId ?? defaultRunId(startedAt);
  const runDirectory = path.join(options.runsRoot, runId);
  const store = new EvidenceStore({ runId, runsRoot: options.runsRoot });

  const execRoot = path.join(runDirectory, 'exec');
  fs.mkdirSync(execRoot, { recursive: true });

  // The target is copied. Nothing in the run writes to the path the user named.
  const execWorkspace = createExecutionWorkspace({
    sourceRoot: target,
    destination: execRoot,
    ...(options.hostOnlyEntries === undefined ? {} : { hostOnlyEntries: options.hostOnlyEntries }),
  });

  const boundary = new WriteBoundary({ generatedRoot: execWorkspace.generatedSourceRoot, store });

  // The model reads the copy, not the original, and not the workspace the host
  // builds in: its read surface and the compiled sources are the same files.
  const modelContext: ToolContext = {
    workspace: createWorkspace(path.join(execRoot, 'target')),
    store,
  };
  const hostToolContext: ToolContext = { workspace: execWorkspace.workspace, store };

  const client = (options.createClient ?? (() => new AnthropicModelClient()))();
  const usage = new UsageAccumulator();
  const machine = new PhaseMachine();

  const analysis = await runAnalysis({
    client,
    context: modelContext,
    targetPath: '.',
    machine,
    usage,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  let cycle: TestCycleResult | undefined;
  if (analysis.degradedAt === undefined) {
    cycle = await runTestCycle({
      client,
      context: modelContext,
      execution: {
        execWorkspace,
        boundary,
        toolContext: hostToolContext,
        sdkVersion: toolchain.damlSdkVersion,
      },
      machine,
      targetPath: '.',
      priorArtifacts: analysis.artifacts,
      usage,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  const degradedAt = analysis.degradedAt ?? cycle?.degradedAt;
  const lastAttempt = cycle?.attempts.at(-1);

  const { report, downgrades } = buildReport({
    runId,
    // Only the basename is published. An absolute host path in a report says
    // more about the machine that ran it than about the code reviewed.
    targetRelativePath: path.basename(target),
    startedAt,
    completedAt: now(),
    toolchain: {
      damlSdkVersion: toolchain.damlSdkVersion,
      dpmVersion: toolchain.dpmCliVersion,
    },
    modelId: client.modelId,
    usage: usage.totals(),
    artifacts: analysis.artifacts.map((entry) => ({
      phase: entry.phase,
      artifact: entry.artifact,
    })),
    generatedTests: lastAttempt?.tests ?? [],
    ...(cycle === undefined ? {} : { execution: cycle.finalExecution }),
    ...(cycle === undefined
      ? {}
      : {
          revision: {
            attempts: cycle.attempts.length,
            revisions: cycle.revisions,
            maxRevisions: MODEL_LOOP_DEFAULTS.maxRevisions,
            exhausted: cycle.revisionExhausted,
          },
        }),
    generatedDirRelativePath: path.posix.join(execWorkspace.generatedPackageRoot, 'daml'),
    degradedPhases: degradedAt === undefined ? [] : [degradedAt],
    store,
  });

  const written = writeReportOutputs(runDirectory, report);

  return {
    runId,
    runDirectory,
    report,
    jsonPath: written.jsonPath,
    markdownPath: written.markdownPath,
    downgrades,
    ...(degradedAt === undefined ? {} : { degradedAt }),
  };
}
