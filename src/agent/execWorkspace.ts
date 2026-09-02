/**
 * The run-scoped execution workspace.
 *
 * Generated code never runs where the target lives. Before anything is
 * compiled, the model-visible portion of the target is copied into a scratch
 * directory the host owns, and the whole generate/compile/execute/revise cycle
 * happens there. The checked-in fixture is opened read-only and is never a
 * working directory, never a build root, and never a write destination, so a
 * run cannot leave a `.daml` build tree or a modified source file behind in the
 * repository.
 *
 * The copy is made by `createAnalysisView`, which is also what excludes
 * host-owned benchmark material. That reuse is deliberate: the execution
 * workspace and the model's view of the target are then the same set of files
 * by construction, so a generated test cannot compile against an oracle the
 * analysis was never allowed to read.
 *
 * Layout:
 *
 *   <run>/exec/
 *     target/          copy of the model-visible target, built here
 *     generated/
 *       daml.yaml      host-written scaffold, depends on the target's DAR
 *       daml/          the write boundary's root; generated Scripts land here
 *
 * The scaffold is a host write, not a model-influenced one: its contents are
 * built from the host's own values and the DAR path the host observed after
 * building the target.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createAnalysisView } from '../eval/analysisView.js';
import { createWorkspace, type Workspace } from '../security/paths.js';

export class ExecutionWorkspaceError extends Error {
  override readonly name = 'ExecutionWorkspaceError';
}

export interface ExecutionWorkspace {
  readonly root: string;
  /** Confinement root for the Daml tools. Everything runs inside it. */
  readonly workspace: Workspace;
  /** Workspace-relative root of the copied target package. */
  readonly targetPackageRoot: string;
  /** Workspace-relative root of the generated test package. */
  readonly generatedPackageRoot: string;
  /** Absolute directory the write boundary owns. */
  readonly generatedSourceRoot: string;
  /** Target files copied in, relative to the target copy. */
  readonly includedTargetFiles: readonly string[];
  /** Fixture entries deliberately withheld from the copy. */
  readonly excludedEntries: readonly string[];
}

export interface CreateExecutionWorkspaceOptions {
  /** Target being analysed. Read-only; never written to. */
  readonly sourceRoot: string;
  /** Host-owned scratch directory for this run. */
  readonly destination: string;
  /**
   * Package inside the copied target to build, relative to the target copy.
   * Auto-detected from `daml.yaml` when omitted.
   */
  readonly targetPackageRoot?: string;
  readonly additionalHostOnly?: readonly string[];
}

/** Find the package to build: the root itself, or its first `daml.yaml` child. */
function detectPackageRoot(targetRoot: string): string {
  if (fs.existsSync(path.join(targetRoot, 'daml.yaml'))) return '.';

  const children = fs
    .readdirSync(targetRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const child of children) {
    if (fs.existsSync(path.join(targetRoot, child, 'daml.yaml'))) return child;
  }

  throw new ExecutionWorkspaceError(
    `No daml.yaml found in the target copy at ${targetRoot}; nothing to build against.`,
  );
}

export function createExecutionWorkspace(
  options: CreateExecutionWorkspaceOptions,
): ExecutionWorkspace {
  if (!path.isAbsolute(options.destination)) {
    throw new ExecutionWorkspaceError('Execution workspace destination must be absolute.');
  }

  fs.mkdirSync(options.destination, { recursive: true });
  // Canonical from here on. Mixing a symlinked path with the workspace's
  // resolved one would produce relative paths that climb out and back in.
  const root = fs.realpathSync(options.destination);
  const targetRoot = path.join(root, 'target');
  const generatedRoot = path.join(root, 'generated');
  const generatedSourceRoot = path.join(generatedRoot, 'daml');

  fs.mkdirSync(targetRoot, { recursive: true });
  fs.mkdirSync(generatedSourceRoot, { recursive: true });

  const view = createAnalysisView({
    fixtureRoot: options.sourceRoot,
    destination: targetRoot,
    ...(options.additionalHostOnly === undefined
      ? {}
      : { additionalHostOnly: options.additionalHostOnly }),
  });

  const detected = options.targetPackageRoot ?? detectPackageRoot(targetRoot);
  const targetPackageRoot = path.join('target', detected);

  return {
    root,
    workspace: createWorkspace(root),
    targetPackageRoot,
    generatedPackageRoot: 'generated',
    generatedSourceRoot: fs.realpathSync(generatedSourceRoot),
    includedTargetFiles: view.includedFiles,
    excludedEntries: view.excludedEntries,
  };
}

/**
 * Write the generated package's manifest.
 *
 * A host write with host-authored content. The only variable in it is the DAR
 * path, which the host read off the filesystem after building the target, and
 * the SDK version, which is the pinned one.
 */
export function writeGeneratedPackageManifest(
  execWorkspace: ExecutionWorkspace,
  options: { readonly sdkVersion: string; readonly targetDarAbsolutePath: string },
): string {
  const generatedPackageAbsolute = path.join(execWorkspace.root, 'generated');
  const relativeDar = path.relative(generatedPackageAbsolute, options.targetDarAbsolutePath);

  const manifest = [
    `sdk-version: ${options.sdkVersion}`,
    'name: generated-security-tests',
    'source: daml',
    'version: 1.0.0',
    'dependencies:',
    '  - daml-prim',
    '  - daml-stdlib',
    '  - daml-script',
    'data-dependencies:',
    `  - ${relativeDar.split(path.sep).join('/')}`,
    '',
  ].join('\n');

  const manifestPath = path.join(generatedPackageAbsolute, 'daml.yaml');
  fs.writeFileSync(manifestPath, manifest, 'utf8');
  return manifestPath;
}
