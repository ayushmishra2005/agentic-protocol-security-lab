/**
 * `dpm test` wrapper.
 *
 * Outcomes come from the JUnit XML file, never from human-readable stdout. The
 * JUnit path is chosen by the host in a private temporary directory, so a
 * caller cannot direct the CLI to write over a workspace file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execute, type ExecResult } from '../../security/exec.js';
import { relativeToWorkspace, resolveWithin, type Workspace } from '../../security/paths.js';
import { dpmCommand } from './commands.js';
import { parseJUnitXml, type JUnitReport } from './junit.js';

export interface DamlTestOptions {
  /** Workspace-relative package root. Defaults to the workspace root. */
  readonly packageRoot?: string;
  /** Restrict execution to scripts matching this pattern. */
  readonly testPattern?: string;
  readonly all?: boolean;
  readonly timeoutMs?: number;
}

export interface DamlTestResult {
  readonly operation: 'test';
  readonly packageRoot: string;
  readonly exitCode: number | null;
  /** Present when the CLI produced parsable JUnit output. */
  readonly junit?: JUnitReport;
  readonly junitParseError?: string;
  /** Redacted, size-bounded console output, kept for diagnostics only. */
  readonly diagnostics: string;
  readonly exec: ExecResult;
}

/** Conservative pattern syntax; the value reaches damlc as a single argv token. */
const TEST_PATTERN = /^[A-Za-z0-9_.:\-*]{1,128}$/;

export async function damlTest(
  workspace: Workspace,
  options: DamlTestOptions = {},
): Promise<DamlTestResult> {
  const packageRootAbsolute = resolveWithin(workspace, options.packageRoot ?? '.');

  if (options.testPattern !== undefined && !TEST_PATTERN.test(options.testPattern)) {
    throw new Error(`Rejected test pattern: ${options.testPattern}`);
  }

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apsl-junit-'));
  const junitPath = path.join(scratchDir, 'results.xml');

  try {
    const argv: string[] = ['test', '--junit', junitPath];
    if (options.all === true) argv.push('--all');
    if (options.testPattern !== undefined) argv.push('--test-pattern', options.testPattern);

    const exec = await execute({
      definition: dpmCommand('dpm_test'),
      argv,
      cwd: packageRootAbsolute,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });

    const base = {
      operation: 'test' as const,
      packageRoot: relativeToWorkspace(workspace, packageRootAbsolute),
      exitCode: exec.exitCode,
      diagnostics: [exec.stdout, exec.stderr].filter((part) => part.length > 0).join('\n'),
      exec,
    };

    let xml: string;
    try {
      xml = fs.readFileSync(junitPath, 'utf8');
    } catch {
      return { ...base, junitParseError: 'dpm test produced no JUnit output file.' };
    }

    try {
      return { ...base, junit: parseJUnitXml(xml) };
    } catch (error) {
      return {
        ...base,
        junitParseError: error instanceof Error ? error.message : 'Unknown JUnit parse failure.',
      };
    }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}
