/**
 * `dpm inspect-dar --json` wrapper.
 *
 * DAR metadata is read as JSON, which is what makes package and module names
 * usable as evidence rather than as prose.
 */
import { execute, type ExecResult } from '../../security/exec.js';
import { relativeToWorkspace, resolveWithin, type Workspace } from '../../security/paths.js';
import { dpmCommand } from './commands.js';

export class InspectDarError extends Error {
  override readonly name = 'InspectDarError';
}

export interface InspectDarResult {
  readonly operation: 'inspect_dar';
  readonly darPath: string;
  readonly exitCode: number | null;
  /** Parsed `inspect-dar --json` document, shape owned by the CLI. */
  readonly metadata: unknown;
  readonly exec: ExecResult;
}

export async function inspectDar(
  workspace: Workspace,
  candidateDarPath: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<InspectDarResult> {
  const darAbsolute = resolveWithin(workspace, candidateDarPath);
  if (!darAbsolute.endsWith('.dar')) {
    throw new InspectDarError(`Not a DAR file: ${relativeToWorkspace(workspace, darAbsolute)}`);
  }

  const exec = await execute({
    definition: dpmCommand('dpm_inspect_dar'),
    argv: ['inspect-dar', darAbsolute, '--json'],
    cwd: workspace.root,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  if (exec.exitCode !== 0) {
    throw new InspectDarError(
      `inspect-dar failed with exit code ${String(exec.exitCode)}: ${exec.stderr.slice(0, 1_000)}`,
    );
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(exec.stdout);
  } catch {
    throw new InspectDarError('inspect-dar --json did not produce parsable JSON.');
  }

  return {
    operation: 'inspect_dar',
    darPath: relativeToWorkspace(workspace, darAbsolute),
    exitCode: exec.exitCode,
    metadata,
    exec,
  };
}
