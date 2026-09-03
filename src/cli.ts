#!/usr/bin/env node
/**
 * Host CLI.
 *
 * `doctor` checks the environment. `analyze` runs the pipeline end to end and
 * writes the run's report. Neither command takes an option that could redirect
 * output, and no credential is ever accepted as an argument: the model client
 * reads it from the environment through `config.ts` and nowhere else, so it
 * cannot end up in a shell history or a process listing.
 */
import path from 'node:path';

import { Command } from 'commander';

import { analyze } from './cli/analyze.js';
import { DEFAULT_FIXTURE_IDS, evaluate } from './cli/eval.js';
import { resolveDpmExecutable, resolveGitExecutable, resolveModelId } from './config.js';
import { assertPinnedToolchain } from './tools/daml/version.js';
import { assertNoNetworkCapableTools, TOOL_NAMES } from './tools/registry.js';

async function doctor(): Promise<void> {
  assertNoNetworkCapableTools();

  const dpm = resolveDpmExecutable();
  const git = resolveGitExecutable();
  const versions = await assertPinnedToolchain();

  process.stdout.write(
    [
      `dpm executable      ${dpm}`,
      `git executable      ${git}`,
      `Daml SDK            ${versions.damlSdkVersion}`,
      `dpm CLI             ${versions.dpmCliVersion}`,
      `pinned model        ${resolveModelId()} (not contacted)`,
      `registered tools    ${TOOL_NAMES.length} (${TOOL_NAMES.join(', ')})`,
      '',
    ].join('\n'),
  );
}

/** Runs live under the current working directory, in a host-fixed location. */
function runsRoot(): string {
  return path.join(process.cwd(), 'runs');
}

async function runAnalyze(targetPath: string): Promise<void> {
  const result = await analyze({ targetPath, runsRoot: runsRoot() });
  const { report } = result;
  const confirmed = report.findings.filter((finding) => finding.state === 'confirmed').length;

  process.stdout.write(
    [
      `run                 ${result.runId}`,
      `target              ${report.target.relativePath}`,
      `findings            ${String(report.findings.length)} (${String(confirmed)} confirmed)`,
      `generated tests     ${String(report.generatedTests.length)}`,
      ...(result.degradedAt === undefined ? [] : [`degraded at         ${result.degradedAt}`]),
      `report.json         ${result.jsonPath}`,
      `report.md           ${result.markdownPath}`,
      '',
      report.boundaryStatement,
      '',
    ].join('\n'),
  );
}

async function runEval(): Promise<void> {
  const { scorecard, scorecardPath } = await evaluate({
    fixturesRoot: path.join(process.cwd(), 'fixtures'),
    runsRoot: runsRoot(),
    outputRoot: runsRoot(),
  });

  const lines = scorecard.results.map((fixture) => {
    const passes = fixture.dimensions.filter((entry) => entry.status === 'pass').length;
    const scored = fixture.dimensions.filter((entry) => entry.status !== 'not_applicable').length;
    return `${fixture.fixtureId.padEnd(26)}${String(passes)}/${String(scored)} dimensions`;
  });

  process.stdout.write(
    [
      `model               ${scorecard.model.id}`,
      `provenance          ${scorecard.provenance}`,
      `fixtures            ${String(scorecard.aggregate.fixtures)}`,
      ...lines,
      `unsupported claims  ${String(scorecard.aggregate.unsupportedClaims)}`,
      `false positives     ${String(scorecard.aggregate.falsePositives)}`,
      `scorecard.json      ${scorecardPath}`,
      '',
      scorecard.note,
      '',
    ].join('\n'),
  );
}

const program = new Command();

program
  .name('apsl')
  .description('Agentic protocol security lab: deterministic host foundation')
  .version('0.1.0');

program
  .command('doctor')
  .description('Verify the pinned toolchain and the deterministic tool surface')
  .action(async () => {
    try {
      await doctor();
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('analyze')
  .argument('<path>', 'Daml project to analyse')
  .description('Analyse a Daml project and write an evidence-backed report for the run')
  .action(async (targetPath: string) => {
    try {
      await runAnalyze(targetPath);
    } catch (error) {
      // Setup failures reach here. An analysis that fell short does not: it
      // produced a report, and the report says what fell short.
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('eval')
  .description(
    `Analyse the fixture set (${DEFAULT_FIXTURE_IDS.join(', ')}) and write a host-owned scorecard`,
  )
  .action(async () => {
    try {
      await runEval();
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
