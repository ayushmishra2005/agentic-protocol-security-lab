/**
 * The fixture runner (Constitution Article IV).
 *
 * Two separations make an evaluation result mean anything, and both live here.
 *
 * The first is spatial: every fixture is copied into a scratch directory and the
 * copy is analysed, so a run can never mutate a committed fixture source. The
 * integration tests digest the fixture files before and after to prove it.
 *
 * The second is informational: the copy is materialised through the same
 * host-only-entry mechanism the benchmark uses everywhere else, so the fixture's
 * `expected.json` and its oracle package are absent from the tree the model can
 * read. The host reads the expectation from the original fixture, after the run,
 * on its own side of that boundary — never through the workspace the model saw.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HOST_ONLY_FIXTURE_ENTRIES } from './analysisView.js';
import { materializeTargetView } from '../agent/targetView.js';
import { analyze, type AnalyzeResult } from '../cli/analyze.js';
import { ExpectedSchema, type Expected } from '../schemas/expected.js';
import type { ModelClient } from '../model/client.js';
import type { ScoreInput } from './scorer.js';

export class EvalRunError extends Error {
  override readonly name = 'EvalRunError';
}

export interface FixtureRun {
  readonly fixtureId: string;
  readonly expected: Expected;
  readonly result: AnalyzeResult;
  /** Scratch copy analysed for this fixture. Never the committed fixture. */
  readonly scratchRoot: string;
}

export interface RunFixturesOptions {
  /** Directory holding the fixture directories, one per fixture id. */
  readonly fixturesRoot: string;
  readonly fixtureIds: readonly string[];
  readonly runsRoot: string;
  /** Injected so the harness can be exercised without a provider. */
  readonly createClient?: () => ModelClient;
  /** Scratch parent. Defaults to a fresh temporary directory. */
  readonly scratchRoot?: string;
  readonly runIdFor?: (fixtureId: string) => string;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

/**
 * Read a fixture's expectation.
 *
 * Host side only. This is called with the path of the committed fixture, never
 * the scratch copy, because the scratch copy deliberately does not contain it.
 */
export function readExpectation(fixturesRoot: string, fixtureId: string): Expected {
  const expectationPath = path.join(fixturesRoot, fixtureId, 'expected.json');
  let raw: string;
  try {
    raw = fs.readFileSync(expectationPath, 'utf8');
  } catch {
    throw new EvalRunError(`Fixture ${fixtureId} has no expected.json at ${expectationPath}.`);
  }

  const parsed = ExpectedSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new EvalRunError(
      `Fixture ${fixtureId} has an invalid expected.json: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  if (parsed.data.fixtureId !== fixtureId) {
    throw new EvalRunError(
      `Fixture ${fixtureId} declares fixtureId ${parsed.data.fixtureId}, which would misattribute its score.`,
    );
  }
  return parsed.data;
}

/**
 * Copy one fixture into scratch, withholding everything host-owned.
 *
 * Exported because the isolation tests assert on the copy directly: the claim
 * that the model cannot read the answer is worth testing against the same
 * function the runner uses, not a reimplementation of it.
 */
export function materializeFixtureView(
  fixturesRoot: string,
  fixtureId: string,
  destination: string,
): string {
  fs.mkdirSync(destination, { recursive: true });
  materializeTargetView({
    sourceRoot: path.join(fixturesRoot, fixtureId),
    destination,
    hostOnlyEntries: HOST_ONLY_FIXTURE_ENTRIES,
  });
  return destination;
}

/** Analyse every fixture and pair each report with its host-owned expectation. */
export async function runFixtures(options: RunFixturesOptions): Promise<FixtureRun[]> {
  if (options.fixtureIds.length === 0) {
    throw new EvalRunError('No fixtures were selected, so there is nothing to evaluate.');
  }

  const scratchParent = options.scratchRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-eval-'));
  fs.mkdirSync(scratchParent, { recursive: true });

  const runs: FixtureRun[] = [];

  for (const fixtureId of options.fixtureIds) {
    const expected = readExpectation(options.fixturesRoot, fixtureId);
    const scratchRoot = materializeFixtureView(
      options.fixturesRoot,
      fixtureId,
      path.join(scratchParent, fixtureId),
    );

    const result = await analyze({
      targetPath: scratchRoot,
      runsRoot: options.runsRoot,
      // Redundant by construction — the copy has no expectation or oracle to
      // withhold — and passed anyway, so the boundary does not depend on the
      // copy having been made correctly.
      hostOnlyEntries: HOST_ONLY_FIXTURE_ENTRIES,
      ...(options.createClient === undefined ? {} : { createClient: options.createClient }),
      ...(options.runIdFor === undefined ? {} : { runId: options.runIdFor(fixtureId) }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    runs.push({ fixtureId, expected, result, scratchRoot });
  }

  return runs;
}

/** Project runs into scorer input, dropping everything the scorer must not see. */
export function toScoreInputs(runs: readonly FixtureRun[]): ScoreInput[] {
  return runs.map((run) => ({ expected: run.expected, report: run.result.report }));
}
