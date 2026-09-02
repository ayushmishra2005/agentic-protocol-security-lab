/**
 * The evaluation analysis view.
 *
 * A checked-in fixture holds three kinds of material: the vulnerable Daml
 * source, the host-owned oracle that proves the defect, and the host-owned
 * expectation the scorer grades against. Only the first is the model's to see.
 * If the evaluated model could read the other two, a passing score would
 * measure how well it copied an answer it was handed.
 *
 * The mechanism is deliberately dull: copy the model-visible material into a
 * scratch directory and point the workspace at that. The model then cannot read
 * the expectation because it is not there — not because a filename was
 * blacklisted. That distinction matters in both directions. A user analysing
 * their own project may have a perfectly ordinary `expected.json`, and denying
 * the basename globally would break them for no security benefit; conversely, a
 * benchmark answer stored under some other name would have slipped straight
 * through a name-based rule.
 *
 * This lives under `src/eval/`, which the repository read policy makes
 * unreadable to model-facing tools, so the view builder cannot be read through
 * the surface it exists to constrain.
 *
 * Scope: this is the isolation primitive only. The fixture runner, the scorer,
 * and the run-scoped write boundary are separate, later tasks and are not
 * implemented here.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Fixture entries that belong to the host and never to the evaluated model.
 * Relative to the fixture root, matched exactly.
 *
 * `test` is the oracle package: it demonstrates the defect and asserts the
 * expected authorization outcome, which is the answer in executable form.
 */
export const HOST_ONLY_FIXTURE_ENTRIES: readonly string[] = ['expected.json', 'test'];

/** Directories excluded as build output rather than for secrecy. */
const BUILD_DIRECTORIES: ReadonlySet<string> = new Set(['.daml', '.git', 'node_modules']);

export interface AnalysisView {
  /** Directory to open as the workspace for the evaluated model. */
  readonly root: string;
  /** Workspace-relative paths copied in, for host-side assertions. */
  readonly includedFiles: readonly string[];
  /** Fixture-relative entries deliberately withheld. */
  readonly excludedEntries: readonly string[];
}

export interface CreateAnalysisViewOptions {
  readonly fixtureRoot: string;
  /** Existing empty directory the view is materialised into. */
  readonly destination: string;
  /** Additional fixture-relative entries to withhold. */
  readonly additionalHostOnly?: readonly string[];
}

/**
 * Materialise the model-visible portion of a fixture.
 *
 * Host-only entries are excluded at the fixture root, where they live, so the
 * exclusion is an explicit list a reviewer can check against the fixture layout
 * rather than a pattern applied at every depth.
 */
export function createAnalysisView(options: CreateAnalysisViewOptions): AnalysisView {
  const excluded = new Set([...HOST_ONLY_FIXTURE_ENTRIES, ...(options.additionalHostOnly ?? [])]);
  const included: string[] = [];

  const copyDirectory = (from: string, to: string, relative: string): void => {
    fs.mkdirSync(to, { recursive: true });

    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (relative === '' && excluded.has(entry.name)) continue;
      if (entry.isDirectory() && BUILD_DIRECTORIES.has(entry.name)) continue;

      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);

      if (entry.isDirectory()) {
        copyDirectory(source, target, childRelative);
        continue;
      }
      // Symbolic links are not followed: a link could otherwise point at an
      // excluded entry, or out of the fixture entirely.
      if (!entry.isFile()) continue;

      fs.copyFileSync(source, target);
      included.push(childRelative);
    }
  };

  copyDirectory(options.fixtureRoot, options.destination, '');

  return {
    root: options.destination,
    includedFiles: included,
    excludedEntries: [...excluded],
  };
}
