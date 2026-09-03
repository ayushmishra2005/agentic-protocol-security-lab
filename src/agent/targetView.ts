/**
 * Copying a target into a scratch directory.
 *
 * This is the shared mechanism behind two things that look different but are
 * not: analysing a user's project, and evaluating a benchmark fixture. Both copy
 * the target and analyse the copy, so the committed source can never be a build
 * root or a write target. The only difference is whether the caller asks for
 * anything to be withheld, which is one argument rather than a second code path
 * with its own rules.
 *
 * It lives here, outside `src/eval/`, on purpose. The benchmark policy — which
 * entries are host-owned, and what a fixture's answer key is — belongs to the
 * evaluation harness, which no model-facing module may reach. The act of copying
 * a directory does not, and the execution workspace needs it on every run,
 * including runs that have nothing to do with the benchmark.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface AnalysisView {
  /** Directory to open as the workspace for the evaluated model. */
  readonly root: string;
  /** Workspace-relative paths copied in, for host-side assertions. */
  readonly includedFiles: readonly string[];
  /** Fixture-relative entries deliberately withheld. */
  readonly excludedEntries: readonly string[];
}

export interface MaterializeTargetViewOptions {
  readonly sourceRoot: string;
  readonly destination: string;
  /**
   * Root-relative entries to withhold. Empty for an ordinary user project: a
   * generic analysis hides nothing, and the caller that wants benchmark
   * isolation asks for it explicitly.
   */
  readonly hostOnlyEntries?: readonly string[];
}

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

export interface MaterializeTargetViewOptions {
  readonly sourceRoot: string;
  readonly destination: string;
  /**
   * Root-relative entries to withhold. Empty for an ordinary user project: a
   * generic analysis hides nothing, and the caller that wants benchmark
   * isolation asks for it explicitly.
   */
  readonly hostOnlyEntries?: readonly string[];
}

/**
 * Rewrite a copied `multi-package.yaml` to match what the view contains.
 *
 * A benchmark fixture's manifest names every package including the oracle. Left
 * as copied it would both disclose that the oracle exists and break the build,
 * since the directory is not there. Deleting the manifest outright would change
 * how the project builds; rewriting it to list exactly the packages present
 * keeps the project's own structure while describing only what was copied.
 *
 * Line-based on purpose. The alternative is a YAML dependency for one file
 * whose shape is fixed and whose contents the host generates.
 */
function sanitizeMultiPackageManifest(destination: string): void {
  const manifestPath = path.join(destination, 'multi-package.yaml');
  let original: string;
  try {
    original = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    return;
  }

  const kept: string[] = [];
  let dropped = 0;

  for (const line of original.split('\n')) {
    const entry = /^\s*-\s*(\S+)\s*$/.exec(line);
    if (entry === null) {
      kept.push(line);
      continue;
    }
    const candidate = path.join(destination, entry[1] ?? '');
    if (fs.existsSync(candidate)) kept.push(line);
    else dropped += 1;
  }

  if (dropped === 0) return;
  fs.writeFileSync(manifestPath, kept.join('\n'), 'utf8');
}

/**
 * Copy a target into a scratch directory, optionally withholding entries.
 *
 * The generic path and the benchmark path share this so they cannot diverge:
 * the difference between analysing a user's project and evaluating a fixture is
 * one argument, not a separate code path with its own rules.
 */
export function materializeTargetView(options: MaterializeTargetViewOptions): AnalysisView {
  const excluded = new Set(options.hostOnlyEntries ?? []);
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
      // excluded entry, or out of the source tree entirely.
      if (!entry.isFile()) continue;

      fs.copyFileSync(source, target);
      included.push(childRelative);
    }
  };

  copyDirectory(options.sourceRoot, options.destination, '');
  sanitizeMultiPackageManifest(options.destination);

  return {
    root: options.destination,
    includedFiles: included,
    excludedEntries: [...excluded],
  };
}
