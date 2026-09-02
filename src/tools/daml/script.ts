/**
 * `dpm script` wrapper.
 *
 * Runs against the in-memory IDE ledger only. No `--ledger-host`,
 * `--ledger-port`, `--participant-config`, `--tls` or credential flag is
 * allowlisted, so this wrapper cannot reach a Canton participant or any other
 * network endpoint.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execute, type ExecResult } from '../../security/exec.js';
import { relativeToWorkspace, resolveWithin, type Workspace } from '../../security/paths.js';
import { dpmCommand } from './commands.js';

export class DamlScriptError extends Error {
  override readonly name = 'DamlScriptError';
}

/** Script identifiers take the documented `Module.Name:Entity.Name` form. */
const SCRIPT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,127}:[A-Za-z][A-Za-z0-9_.']{0,127}$/;

function resolveDar(workspace: Workspace, candidate: string): string {
  const absolute = resolveWithin(workspace, candidate);
  if (!absolute.endsWith('.dar')) {
    throw new DamlScriptError(`Not a DAR file: ${relativeToWorkspace(workspace, absolute)}`);
  }
  return absolute;
}

export interface ListScriptsResult {
  readonly operation: 'list_scripts';
  readonly darPath: string;
  readonly exitCode: number | null;
  /** Parsed `--list-scripts-json` document, shape owned by the CLI. */
  readonly scripts: unknown;
  readonly exec: ExecResult;
}

/** Enumerate the scripts in a DAR using the CLI's JSON listing. */
export async function listScripts(
  workspace: Workspace,
  candidateDarPath: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<ListScriptsResult> {
  const darAbsolute = resolveDar(workspace, candidateDarPath);
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-scripts-'));
  const listingPath = path.join(scratchDir, 'scripts.json');

  try {
    const exec = await execute({
      definition: dpmCommand('dpm_script'),
      argv: ['script', '--dar', darAbsolute, '--list-scripts-json', listingPath],
      cwd: workspace.root,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });

    if (exec.exitCode !== 0) {
      throw new DamlScriptError(
        `Script listing failed with exit code ${String(exec.exitCode)}: ${exec.stderr.slice(0, 1_000)}`,
      );
    }

    let scripts: unknown;
    try {
      scripts = JSON.parse(fs.readFileSync(listingPath, 'utf8'));
    } catch {
      throw new DamlScriptError('--list-scripts-json did not produce parsable JSON.');
    }

    return {
      operation: 'list_scripts',
      darPath: relativeToWorkspace(workspace, darAbsolute),
      exitCode: exec.exitCode,
      scripts,
      exec,
    };
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

export interface RunScriptOptions {
  readonly scriptName: string;
  readonly timeoutMs?: number;
}

export interface RunScriptResult {
  readonly operation: 'run_script';
  readonly darPath: string;
  readonly scriptName: string;
  readonly succeeded: boolean;
  readonly exitCode: number | null;
  readonly diagnostics: string;
  readonly exec: ExecResult;
}

/** Run a single script on the simulated IDE ledger. */
export async function runScript(
  workspace: Workspace,
  candidateDarPath: string,
  options: RunScriptOptions,
): Promise<RunScriptResult> {
  const darAbsolute = resolveDar(workspace, candidateDarPath);
  if (!SCRIPT_NAME_PATTERN.test(options.scriptName)) {
    throw new DamlScriptError(`Rejected script name: ${options.scriptName}`);
  }

  const exec = await execute({
    definition: dpmCommand('dpm_script'),
    argv: ['script', '--dar', darAbsolute, '--script-name', options.scriptName, '--ide-ledger'],
    cwd: workspace.root,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  return {
    operation: 'run_script',
    darPath: relativeToWorkspace(workspace, darAbsolute),
    scriptName: options.scriptName,
    succeeded: exec.exitCode === 0,
    exitCode: exec.exitCode,
    diagnostics: [exec.stdout, exec.stderr].filter((part) => part.length > 0).join('\n'),
    exec,
  };
}
