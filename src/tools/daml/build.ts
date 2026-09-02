/**
 * `dpm build` wrapper.
 *
 * The package root is confined to the workspace and used as the process cwd.
 * The produced DAR is located on the filesystem rather than scraped from
 * console output.
 */
import fs from 'node:fs';
import path from 'node:path';

import { execute, type ExecResult } from '../../security/exec.js';
import { relativeToWorkspace, resolveWithin, type Workspace } from '../../security/paths.js';
import { dpmCommand } from './commands.js';

export interface DamlBuildOptions {
  /** Workspace-relative package root. Defaults to the workspace root. */
  readonly packageRoot?: string;
  /** Build every package in a multi-package project. */
  readonly all?: boolean;
  readonly timeoutMs?: number;
}

export interface DamlBuildResult {
  readonly operation: 'build';
  readonly packageRoot: string;
  readonly succeeded: boolean;
  readonly exitCode: number | null;
  /** Redacted, size-bounded compiler diagnostics. */
  readonly diagnostics: string;
  /** Workspace-relative DAR paths found under `.daml/dist` after the build. */
  readonly darPaths: readonly string[];
  readonly exec: ExecResult;
}

function findDars(workspace: Workspace, packageRootAbsolute: string): string[] {
  const distDir = path.join(packageRootAbsolute, '.daml', 'dist');
  let entries: string[];
  try {
    entries = fs.readdirSync(distDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.dar'))
    .sort()
    .map((name) => relativeToWorkspace(workspace, path.join(distDir, name)));
}

export async function damlBuild(
  workspace: Workspace,
  options: DamlBuildOptions = {},
): Promise<DamlBuildResult> {
  const packageRootAbsolute = resolveWithin(workspace, options.packageRoot ?? '.');

  const argv: string[] = ['build'];
  if (options.all === true) argv.push('--all');

  const exec = await execute({
    definition: dpmCommand('dpm_build'),
    argv,
    cwd: packageRootAbsolute,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  return {
    operation: 'build',
    packageRoot: relativeToWorkspace(workspace, packageRootAbsolute),
    succeeded: exec.exitCode === 0,
    exitCode: exec.exitCode,
    diagnostics: [exec.stdout, exec.stderr].filter((part) => part.length > 0).join('\n'),
    darPaths: findDars(workspace, packageRootAbsolute),
    exec,
  };
}
