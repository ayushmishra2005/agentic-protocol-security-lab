/**
 * Read-only version-control inspection.
 *
 * Only three operations exist, each with a host-constructed argv. There is no
 * pass-through for caller-supplied git arguments, and no mutating subcommand is
 * reachable: add, commit, push, checkout, branch, reset, clean, stash, rebase,
 * merge, cherry-pick and config are all simply absent from this module.
 */
import { execute, type CommandDefinition, type ExecResult } from '../../security/exec.js';
import { resolveGitExecutable } from '../../config.js';
import type { Workspace } from '../../security/paths.js';
import { resolveWithin, relativeToWorkspace } from '../../security/paths.js';

export class GitToolError extends Error {
  override readonly name = 'GitToolError';
}

/** Conservative ref syntax. Anything leading with `-` would be option injection. */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

const ALLOWED_GIT_FLAGS: ReadonlySet<string> = new Set([
  // The bare `--` option terminator, which is what makes a pathspec un-flaggable.
  '--',
  '--porcelain',
  '--untracked-files',
  '--no-color',
  '--stat',
  '--max-count',
  '--pretty',
  '--name-only',
]);

function gitCommand(id: string): CommandDefinition {
  return {
    id,
    executable: resolveGitExecutable(),
    allowedFlags: ALLOWED_GIT_FLAGS,
  };
}

function assertRef(ref: string): void {
  if (!REF_PATTERN.test(ref)) {
    throw new GitToolError(`Rejected git ref: ${ref}`);
  }
}

/** Convert caller paths to workspace-relative pathspecs, after confinement. */
function toPathspecs(workspace: Workspace, paths: readonly string[] | undefined): string[] {
  if (!paths || paths.length === 0) return [];
  return paths.map((candidate) =>
    relativeToWorkspace(workspace, resolveWithin(workspace, candidate)),
  );
}

export interface GitStatusResult {
  readonly operation: 'status';
  readonly entries: readonly { readonly status: string; readonly path: string }[];
  readonly exec: ExecResult;
}

export async function gitStatus(workspace: Workspace): Promise<GitStatusResult> {
  const exec = await execute({
    definition: gitCommand('git_status'),
    argv: ['status', '--porcelain=v1', '--untracked-files=all'],
    cwd: workspace.root,
  });

  const entries = exec.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));

  return { operation: 'status', entries, exec };
}

export interface GitDiffOptions {
  readonly ref?: string;
  readonly paths?: readonly string[];
  readonly nameOnly?: boolean;
}

export interface GitDiffResult {
  readonly operation: 'diff';
  readonly patch: string;
  readonly exec: ExecResult;
}

export async function gitDiff(
  workspace: Workspace,
  options: GitDiffOptions = {},
): Promise<GitDiffResult> {
  const argv: string[] = ['diff', '--no-color'];
  if (options.nameOnly === true) argv.push('--name-only');
  if (options.ref !== undefined) {
    assertRef(options.ref);
    argv.push(options.ref);
  }

  const pathspecs = toPathspecs(workspace, options.paths);
  if (pathspecs.length > 0) {
    // `--` terminates option parsing, so a pathspec can never be read as a flag.
    argv.push('--', ...pathspecs);
  }

  const exec = await execute({ definition: gitCommand('git_diff'), argv, cwd: workspace.root });
  return { operation: 'diff', patch: exec.stdout, exec };
}

export interface GitLogOptions {
  readonly maxCount?: number;
}

export interface GitLogEntry {
  readonly commit: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
}

export interface GitLogResult {
  readonly operation: 'log';
  readonly entries: readonly GitLogEntry[];
  readonly exec: ExecResult;
}

const LOG_SEPARATOR = '\u001f';

export async function gitLog(
  workspace: Workspace,
  options: GitLogOptions = {},
): Promise<GitLogResult> {
  const requested = options.maxCount ?? 20;
  if (!Number.isInteger(requested) || requested < 1 || requested > 200) {
    throw new GitToolError(`git log maxCount out of range: ${requested}`);
  }

  const exec = await execute({
    definition: gitCommand('git_log'),
    argv: [
      'log',
      '--no-color',
      `--max-count=${requested}`,
      `--pretty=format:%H${LOG_SEPARATOR}%an${LOG_SEPARATOR}%aI${LOG_SEPARATOR}%s`,
    ],
    cwd: workspace.root,
  });

  const entries = exec.stdout
    .split('\n')
    .filter((line) => line.includes(LOG_SEPARATOR))
    .map((line) => {
      const [commit = '', author = '', date = '', subject = ''] = line.split(LOG_SEPARATOR);
      return { commit, author, date, subject };
    });

  return { operation: 'log', entries, exec };
}
