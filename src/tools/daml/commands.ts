/**
 * Command definitions for the pinned `dpm` executable.
 *
 * Each allowlist below was taken from the installed CLI's own `--help` output.
 * Flags are never invented, and a flag absent from these sets is rejected
 * before a process is created. Values are passed space-separated, the form the
 * CLI documents.
 */
import { resolveDpmExecutable } from '../../config.js';
import type { CommandDefinition } from '../../security/exec.js';

const BUILD_FLAGS: ReadonlySet<string> = new Set([
  '--package-root',
  '--all',
  '--enable-multi-package',
  '--multi-package-path',
  '--no-cache',
  '--output',
  '-o',
  '--log-level',
]);

const TEST_FLAGS: ReadonlySet<string> = new Set([
  '--package-root',
  '--junit',
  '--all',
  '--files',
  '--test-pattern',
  '-p',
  '--log-level',
]);

const INSPECT_DAR_FLAGS: ReadonlySet<string> = new Set(['--json']);

const SCRIPT_FLAGS: ReadonlySet<string> = new Set([
  '--dar',
  '--script-name',
  '--skip-script-name',
  '--all',
  '--ide-ledger',
  '--list-scripts-json',
  '--input-file',
  '--output-file',
  '--json-test-summary',
  '--static-time',
  '--wall-clock-time',
]);

const VERSION_FLAGS: ReadonlySet<string> = new Set(['--version']);

export type DpmCommandId =
  'dpm_build' | 'dpm_test' | 'dpm_inspect_dar' | 'dpm_script' | 'dpm_version';

const FLAGS_BY_COMMAND: Record<DpmCommandId, ReadonlySet<string>> = {
  dpm_build: BUILD_FLAGS,
  dpm_test: TEST_FLAGS,
  dpm_inspect_dar: INSPECT_DAR_FLAGS,
  dpm_script: SCRIPT_FLAGS,
  dpm_version: VERSION_FLAGS,
};

/** Resolve the dpm executable and pair it with one command's flag allowlist. */
export function dpmCommand(id: DpmCommandId): CommandDefinition {
  return {
    id,
    executable: resolveDpmExecutable(),
    allowedFlags: FLAGS_BY_COMMAND[id],
  };
}
