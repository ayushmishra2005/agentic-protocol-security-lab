/**
 * The `eval` command (Constitution Article IV).
 *
 * Runs the fixture set, scores the reports against host-owned expectations, and
 * writes `scorecard.json`. The scorecard is written here by host code from
 * host-computed values; no part of it passes through a model, and the model has
 * no tool that could reach this path.
 *
 * The command refuses to guess its own provenance. A caller that supplies a
 * client factory is running the harness, and the scorecard says so, because a
 * number produced by a scripted fake is not a benchmark result and the file is
 * exactly what someone would later quote as if it were.
 */
import fs from 'node:fs';
import path from 'node:path';

import { runFixtures, toScoreInputs, type FixtureRun } from '../eval/runner.js';
import { buildScorecard } from '../eval/scorer.js';
import { ScorecardSchema, type Provenance, type Scorecard } from '../schemas/scorecard.js';
import type { ModelClient } from '../model/client.js';

/** The verified fixture set, in a fixed order. */
export const DEFAULT_FIXTURE_IDS: readonly string[] = [
  'f01-wrong-controller',
  'f02-observer-exposure',
  'f03-missing-multiparty',
  'f04-propose-accept-bypass',
];

export class EvalError extends Error {
  override readonly name = 'EvalError';
}

export interface EvalOptions {
  readonly fixturesRoot: string;
  readonly runsRoot: string;
  /** Directory the scorecard is written into. */
  readonly outputRoot: string;
  readonly fixtureIds?: readonly string[];
  /**
   * Supplying a client makes this a harness run rather than a model run, and
   * that is recorded in the scorecard.
   */
  readonly createClient?: () => ModelClient;
  readonly scratchRoot?: string;
  readonly runIdFor?: (fixtureId: string) => string;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface EvalResult {
  readonly scorecard: Scorecard;
  readonly scorecardPath: string;
  readonly runs: readonly FixtureRun[];
}

function writeScorecard(outputRoot: string, scorecard: Scorecard): string {
  // Re-validated on the way out: the file is the published artifact, and a
  // schema check here costs nothing against the cost of publishing a malformed
  // scorecard that a reader would take at face value.
  const validated = ScorecardSchema.parse(scorecard);
  fs.mkdirSync(outputRoot, { recursive: true });

  const scorecardPath = path.join(outputRoot, 'scorecard.json');
  fs.writeFileSync(scorecardPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  return scorecardPath;
}

export async function evaluate(options: EvalOptions): Promise<EvalResult> {
  const fixtureIds = options.fixtureIds ?? DEFAULT_FIXTURE_IDS;
  const now = options.now ?? (() => new Date());

  const runs = await runFixtures({
    fixturesRoot: options.fixturesRoot,
    fixtureIds,
    runsRoot: options.runsRoot,
    ...(options.createClient === undefined ? {} : { createClient: options.createClient }),
    ...(options.scratchRoot === undefined ? {} : { scratchRoot: options.scratchRoot }),
    ...(options.runIdFor === undefined ? {} : { runIdFor: options.runIdFor }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const first = runs[0];
  if (first === undefined) throw new EvalError('No fixture produced a report.');

  const modelIds = new Set(runs.map((run) => run.result.report.model.id));
  if (modelIds.size > 1) {
    throw new EvalError(
      `Fixtures were analysed by different models (${[...modelIds].sort().join(', ')}), so one scorecard cannot describe them.`,
    );
  }

  const provenance: Provenance =
    options.createClient === undefined ? 'model_run' : 'harness_validation';

  const scorecard = buildScorecard({
    inputs: toScoreInputs(runs),
    toolchain: first.result.report.toolchain,
    modelId: first.result.report.model.id,
    provenance,
    generatedAt: now(),
  });

  return { scorecard, scorecardPath: writeScorecard(options.outputRoot, scorecard), runs };
}
