/**
 * The `execute` phase (T062) and the failure taxonomy (T063).
 *
 * This phase has no model turn. The host builds the target, writes the
 * generated Scripts through the write boundary, compiles them, runs them, and
 * assembles the artifact itself from what the toolchain actually reported. The
 * `execute` artifact is therefore not a claim the model makes about its own
 * results — it is the record of what happened, produced by the party that
 * watched it happen. Asking a model to report its own test outcomes and then
 * deciding whether to trust the report would be a strange way to build an
 * evidence system.
 *
 * Every Daml invocation goes through `dispatchTool`, so each one appends an
 * evidence record with the argv, working directory and exit code. Nothing here
 * spawns a process itself.
 *
 * The four outcomes are kept apart because they answer different questions:
 *
 *   compile_failed          the script never built. The run learned nothing
 *                           about the target, only about the script.
 *   execution_failed        it built, but no result could be observed for it.
 *                           A gap in observation, not a finding.
 *   executed_expected       it ran and did what it said it would.
 *   executed_contradiction  it ran and did something else. The analysis behind
 *                           it was wrong about the target.
 *
 * Note what is deliberately absent: there is no outcome meaning "vulnerability
 * found". A failing test is not a vulnerability and a passing one is not
 * safety; which of those a result implies depends entirely on what the script
 * was written to assert, which is why the expectation is declared in advance
 * and compared mechanically here.
 */
import path from 'node:path';

import type { ExecuteArtifact, GeneratedTest, TestOutcome } from '../../schemas/phases.js';
import type { DamlBuildResult } from '../../tools/daml/build.js';
import type { DamlTestResult } from '../../tools/daml/test.js';
import type { JUnitTestCase } from '../../tools/daml/junit.js';
import { dispatchTool, type ToolContext } from '../../tools/dispatch.js';
import { writeGeneratedPackageManifest, type ExecutionWorkspace } from '../execWorkspace.js';
import type { WriteBoundary } from '../writeBoundary.js';

/**
 * A failure of the host's own setup: the target would not build, or the
 * toolchain is misconfigured. Raised rather than folded into a test outcome,
 * because blaming a generated test for the harness being broken would send the
 * run into a revision cycle it can never get out of.
 */
export class ExecutionSetupError extends Error {
  override readonly name = 'ExecutionSetupError';
  readonly evidenceId: string | undefined;

  constructor(message: string, evidenceId?: string) {
    super(message);
    this.evidenceId = evidenceId;
  }
}

export interface ExecutionContext {
  readonly execWorkspace: ExecutionWorkspace;
  readonly boundary: WriteBoundary;
  /** Tool context confined to the execution workspace. Host-side only. */
  readonly toolContext: ToolContext;
  readonly sdkVersion: string;
}

export interface ExecutionOutcome {
  readonly artifact: ExecuteArtifact;
  /**
   * The host's decision on whether `revise` is entered. Computed here from the
   * outcomes above; there is no artifact field behind it and no way for a model
   * response to influence it.
   */
  readonly revisionRequired: boolean;
  readonly compileEvidenceId: string;
  readonly runEvidenceId?: string;
  /** Redacted compiler output, for the revision prompt. */
  readonly compileDiagnostics: string;
  /** Redacted per-test failure detail observed in JUnit. */
  readonly failureDetail: ReadonlyMap<string, string>;
}

/** Match a JUnit case to a generated test by module and binding name. */
function findCase(result: DamlTestResult, test: GeneratedTest): JUnitTestCase | undefined {
  const cases = (result.junit?.suites ?? []).flatMap((suite) => suite.cases);
  return cases.find((entry) => {
    const haystack = `${entry.classname}:${entry.name}`;
    return haystack.includes(test.scriptName) && haystack.includes(test.entryPoint);
  });
}

export interface ExecuteOptions {
  readonly context: ExecutionContext;
  readonly tests: readonly GeneratedTest[];
  /** 1 for the first run; incremented by each host-ordered revision. */
  readonly attempt: number;
}

/**
 * Build, write, compile and run the generated tests.
 *
 * The target is built first so its DAR can be depended on. If that fails the
 * problem is the harness or the target, not the generated code, and the run
 * stops rather than blaming a test.
 */
export async function executeGeneratedTests(options: ExecuteOptions): Promise<ExecutionOutcome> {
  const { context, tests, attempt } = options;
  const { execWorkspace, toolContext } = context;

  if (tests.length === 0) {
    throw new ExecutionSetupError('No generated tests to execute.');
  }

  // 1. Build the copied target, inside the run workspace.
  const targetBuild = await dispatchTool(toolContext, 'daml_build', {
    packageRoot: execWorkspace.targetPackageRoot,
  });
  const targetResult = targetBuild.result as DamlBuildResult;
  if (!targetResult.succeeded) {
    throw new ExecutionSetupError(
      `The target package failed to build, so no generated test could be compiled against it. ${targetResult.diagnostics}`,
      targetBuild.evidenceId,
    );
  }

  const darRelative = targetResult.darPaths[0];
  if (darRelative === undefined) {
    throw new ExecutionSetupError(
      'The target package built but produced no DAR to depend on.',
      targetBuild.evidenceId,
    );
  }

  // 2. Host-authored scaffold, then model-authored sources through the boundary.
  writeGeneratedPackageManifest(execWorkspace, {
    sdkVersion: context.sdkVersion,
    targetDarAbsolutePath: path.join(execWorkspace.workspace.root, darRelative),
  });

  for (const test of tests) {
    context.boundary.writeGeneratedScript({
      scriptName: test.scriptName,
      source: test.source,
    });
  }

  // 3. Compile the generated package.
  const compile = await dispatchTool(toolContext, 'daml_build', {
    packageRoot: execWorkspace.generatedPackageRoot,
  });
  const compileResult = compile.result as DamlBuildResult;

  if (!compileResult.succeeded) {
    // One package holds every generated script, so a compile failure is not
    // attributable to one of them. Each is reported as compile_failed against
    // the same evidence rather than guessing which one broke the build.
    return {
      artifact: {
        phase: 'execute',
        results: tests.map((test) => ({
          testId: test.id,
          attempt,
          outcome: 'compile_failed' as const,
          compiled: false,
          compileEvidenceId: compile.evidenceId,
        })),
        evidence: [{ evidenceId: compile.evidenceId }],
      },
      revisionRequired: true,
      compileEvidenceId: compile.evidenceId,
      compileDiagnostics: compileResult.diagnostics,
      failureDetail: new Map(),
    };
  }

  // 4. Run them.
  const run = await dispatchTool(toolContext, 'daml_test', {
    packageRoot: execWorkspace.generatedPackageRoot,
  });
  const runResult = run.result as DamlTestResult;

  const failureDetail = new Map<string, string>();
  const results = tests.map((test) => {
    const junitCase = findCase(runResult, test);

    if (junitCase === undefined) {
      // Compiled, but the run reported nothing for it: a wrong entry point, or
      // no JUnit output at all. Not a statement about the target either way.
      return {
        testId: test.id,
        attempt,
        outcome: 'execution_failed' as const,
        compiled: true,
        compileEvidenceId: compile.evidenceId,
        evidenceId: run.evidenceId,
      };
    }

    const passed = junitCase.status === 'passed';
    const observed = passed ? 'script_passes' : 'script_fails';
    const outcome: TestOutcome =
      observed === test.expectedOutcome ? 'executed_expected' : 'executed_contradiction';

    if (!passed) {
      const detail = [junitCase.message, junitCase.detail].filter(Boolean).join('\n');
      if (detail.length > 0) failureDetail.set(test.id, detail);
    }

    return {
      testId: test.id,
      attempt,
      outcome,
      compiled: true,
      passed,
      compileEvidenceId: compile.evidenceId,
      evidenceId: run.evidenceId,
    };
  });

  return {
    artifact: {
      phase: 'execute',
      results,
      evidence: [{ evidenceId: compile.evidenceId }, { evidenceId: run.evidenceId }],
    },
    // The two documented triggers, and only those. `execution_failed` is not
    // among them: the test may be perfectly correct and the observation the
    // thing that failed, so revising it would be guessing.
    revisionRequired: results.some((result) => result.outcome === 'executed_contradiction'),
    compileEvidenceId: compile.evidenceId,
    runEvidenceId: run.evidenceId,
    compileDiagnostics: compileResult.diagnostics,
    failureDetail,
  };
}
