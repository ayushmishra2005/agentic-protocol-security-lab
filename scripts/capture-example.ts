/**
 * Capture the checked-in example run (Constitution Article VI).
 *
 * The repository asks a reader to believe that conclusions are traceable to
 * executed tooling. A reader without an API key cannot run the pipeline, so the
 * repository owes them a complete run they can read instead: the tool
 * invocations with their exit codes, the Script that was generated, and the
 * report assembled from them.
 *
 * Two things make the published copy safe and useful.
 *
 * Redaction: absolute host paths are rewritten to placeholders. A run directory
 * under a temporary folder in someone's home directory says more about the
 * machine that ran it than about the code reviewed, and a public example should
 * not carry a username.
 *
 * Normalisation: wall-clock timestamps and durations are replaced with a fixed
 * synthetic clock, so re-capturing produces a byte-identical example and any
 * real change to the pipeline shows up as a diff instead of drowning in
 * timing noise. Everything a reviewer would actually check — argv, exit codes,
 * outcomes, evidence identifiers, artifact content — is exactly as recorded.
 *
 * The provider is a script. This captures the pipeline, not a model result, and
 * the example's own README says so.
 *
 * Usage: npx tsx scripts/capture-example.ts
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from '../src/cli/analyze.js';
import { evaluate } from '../src/cli/eval.js';
import { HOST_ONLY_FIXTURE_ENTRIES } from '../src/eval/analysisView.js';
import { createF01Client } from '../tests/helpers/f01ScriptedRun.js';
import { createFixtureClients } from '../tests/helpers/fixtureScriptedRuns.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesRoot = path.join(repoRoot, 'fixtures');

export const EXAMPLE_RUN_ID = 'example-f01';
export const EXAMPLE_ROOT = path.join(repoRoot, 'examples');
export const EXAMPLE_RUN_ROOT = path.join(EXAMPLE_ROOT, 'run-f01');

/** Synthetic clock. Fixed so the published example is byte-reproducible. */
const CLOCK_BASE = Date.parse('2026-01-01T00:00:00.000Z');
const CLOCK_STEP_MS = 1_000;

function syntheticClock(): () => Date {
  let tick = 0;
  return () => new Date(CLOCK_BASE + tick++ * CLOCK_STEP_MS);
}

/**
 * Rewrite host-specific absolute paths to placeholders.
 *
 * Ordered longest-first: the run directory sits inside the temporary root, which
 * may sit inside the home directory, and replacing the outer path first would
 * leave the inner ones half-rewritten.
 */
export function redactPaths(text: string, replacements: readonly [string, string][]): string {
  const literal = [...replacements]
    .sort((left, right) => right[0].length - left[0].length)
    .reduce((current, [from, to]) => current.split(from).join(to), text);

  return (
    literal
      // Scratch directories the host tools create for themselves, which are not
      // under the run directory and carry a random suffix each time.
      .replace(/(\/private)?\/var\/folders\/[^"\s,]*/g, '<tmp>')
      .replace(/apsl-[a-z]+-[A-Za-z0-9]{6,}/g, 'apsl-<scratch>')
      // Wall-clock stamps the Daml build logger writes into its own output.
      .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+/g, '<timestamp>')
  );
}

interface EvidenceProcessLine {
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutSha256: string;
  stderrSha256: string;
  [key: string]: unknown;
}

interface EvidenceLine {
  recordedAt: string;
  sequence: number;
  process?: EvidenceProcessLine;
  result?: unknown;
  resultSha256?: string;
  [key: string]: unknown;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Normalise the volatile fields, and re-digest what is published.
 *
 * Timestamps and durations become a function of the sequence number, so the
 * example re-captures byte-identically.
 *
 * The digests are recomputed over the redacted text rather than carried over
 * from the original. A digest a reader cannot check against the bytes in front
 * of them is worse than no digest: it looks like verification and is not. These
 * ones can be checked, at the cost of no longer being the digests of the
 * unredacted output, which the example's README states plainly.
 */
function normalizeEvidence(line: EvidenceLine): EvidenceLine {
  const normalized: EvidenceLine = {
    ...line,
    recordedAt: new Date(CLOCK_BASE + line.sequence * CLOCK_STEP_MS).toISOString(),
  };

  if (normalized.process !== undefined) {
    const process = normalized.process;
    normalized.process = {
      ...process,
      durationMs: 0,
      stdoutSha256: sha256(process.stdout),
      stderrSha256: sha256(process.stderr),
    };
  }
  if (normalized.resultSha256 !== undefined) {
    normalized.resultSha256 = sha256(JSON.stringify(normalized.result));
  }
  return normalized;
}

const EXAMPLE_README = `# Example run: F01, wrong controller

A complete run of the pipeline against \`fixtures/f01-wrong-controller\`, checked in so that a
reviewer without an API key can judge whether the conclusion was earned.

## What this is not

**The provider was a script, not a model.** The fake was told which file to read, which template and
choice to name, and which exploit Script to write. This example therefore demonstrates the machinery
— six validated analysis phases, a real compile, a real execution, evidence records, and a report
assembled by the host — and demonstrates nothing at all about a model's ability to find F01. No live
provider request has ever been made in this repository.

## What is real

Everything except the model. The Daml SDK 3.5.5 toolchain compiled and ran the generated Script, the
exit codes are the exit codes the toolchain returned, and the report was assembled by host code from
those results under the confirmation gate.

## Files

| File | What it is |
|---|---|
| \`report.json\` | The report. The single source of truth, valid against \`ReportSchema\`. |
| \`report.md\` | A pure rendering of \`report.json\`. Regenerating it from the JSON reproduces it exactly. |
| \`evidence.jsonl\` | Every tool invocation, in order, with argv, exit code, and output digests. |
| \`generated/Exploit.daml\` | The adversarial Script the run generated, compiled, and executed. |

## Redaction and normalisation

Nothing was added or removed. Two classes of field were rewritten:

- **Absolute host paths** became \`<run>\`, \`<repo>\`, \`<home>\`, and \`<tmp>\`. A public example should
  not carry a username or a machine layout.
- **Wall-clock timestamps and durations** became a fixed synthetic clock, including the timestamps the
  Daml build logger writes into its own output. Re-capturing therefore yields a byte-identical
  result, and a real pipeline change shows up as a diff rather than drowning in timing noise.
- **Output digests were recomputed over the redacted text**, so a reader can check them against the
  bytes in this directory. They are consequently not the digests of the original unredacted output. A
  digest nobody can verify would look like verification without being it.

Everything a reviewer would check is as recorded: argv, exit codes, outcomes, evidence identifiers,
finding states, and artifact content.

## Reproducing it

\`\`\`bash
npx tsx scripts/capture-example.ts
\`\`\`

This needs the pinned toolchain but no API key, because the provider is a script.
`;

async function captureRun(): Promise<void> {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-example-'));

  try {
    const result = await analyze({
      targetPath: path.join(fixturesRoot, 'f01-wrong-controller'),
      runsRoot: path.join(temporaryRoot, 'runs'),
      runId: EXAMPLE_RUN_ID,
      createClient: createF01Client,
      // This fixture carries its own expectation and oracle, which the model
      // that analyses it must not read.
      hostOnlyEntries: HOST_ONLY_FIXTURE_ENTRIES,
      now: syntheticClock(),
    });

    const replacements: [string, string][] = [
      [fs.realpathSync(result.runDirectory), '<run>'],
      [result.runDirectory, '<run>'],
      [fs.realpathSync(temporaryRoot), '<tmp>'],
      [temporaryRoot, '<tmp>'],
      [repoRoot, '<repo>'],
      [os.homedir(), '<home>'],
    ];

    fs.rmSync(EXAMPLE_RUN_ROOT, { force: true, recursive: true });
    fs.mkdirSync(path.join(EXAMPLE_RUN_ROOT, 'generated'), { recursive: true });

    const write = (relative: string, contents: string): void => {
      fs.writeFileSync(
        path.join(EXAMPLE_RUN_ROOT, relative),
        redactPaths(contents, replacements),
        'utf8',
      );
    };

    write('report.json', fs.readFileSync(result.jsonPath, 'utf8'));
    write('report.md', fs.readFileSync(result.markdownPath, 'utf8'));
    write(
      path.join('generated', 'Exploit.daml'),
      fs.readFileSync(
        path.join(result.runDirectory, 'exec', 'generated', 'daml', 'Exploit.daml'),
        'utf8',
      ),
    );

    // Redacted first, then normalised, so the published digests are digests of
    // the published text.
    const evidence = fs
      .readFileSync(path.join(result.runDirectory, 'evidence.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => redactPaths(line, replacements))
      .map((line) => normalizeEvidence(JSON.parse(line) as EvidenceLine))
      .map((record) => JSON.stringify(record));
    fs.writeFileSync(
      path.join(EXAMPLE_RUN_ROOT, 'evidence.jsonl'),
      `${evidence.join('\n')}\n`,
      'utf8',
    );

    fs.writeFileSync(path.join(EXAMPLE_RUN_ROOT, 'README.md'), EXAMPLE_README, 'utf8');

    process.stdout.write(
      `captured ${String(evidence.length)} evidence records into ${path.relative(repoRoot, EXAMPLE_RUN_ROOT)}\n`,
    );
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

async function captureScorecard(): Promise<void> {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-example-eval-'));

  try {
    const { scorecard } = await evaluate({
      fixturesRoot,
      runsRoot: path.join(temporaryRoot, 'runs'),
      outputRoot: path.join(temporaryRoot, 'out'),
      scratchRoot: path.join(temporaryRoot, 'targets'),
      createClient: createFixtureClients().create,
      runIdFor: (fixtureId) => `example-${fixtureId}`,
      now: () => new Date(CLOCK_BASE),
    });

    fs.mkdirSync(EXAMPLE_ROOT, { recursive: true });
    fs.writeFileSync(
      path.join(EXAMPLE_ROOT, 'scorecard.json'),
      `${JSON.stringify(scorecard, null, 2)}\n`,
      'utf8',
    );

    process.stdout.write(
      `captured a ${scorecard.provenance} scorecard for ${String(scorecard.aggregate.fixtures)} fixtures\n`,
    );
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

await captureRun();
await captureScorecard();
