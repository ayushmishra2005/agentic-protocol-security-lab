/**
 * Toolchain identification and the startup pin assertion.
 *
 * The pinned versions are asserted before any Daml work runs, because a
 * report's evidence is only meaningful if the toolchain that produced it is
 * the one the report names.
 */
import os from 'node:os';

import { REQUIRED_DAML_SDK_VERSION, REQUIRED_DPM_CLI_VERSION } from '../../config.js';
import { execute } from '../../security/exec.js';
import { dpmCommand } from './commands.js';

export class ToolchainError extends Error {
  override readonly name = 'ToolchainError';
}

export interface ToolchainVersions {
  readonly damlSdkVersion: string;
  readonly dpmCliVersion: string;
  readonly dpmExecutable: string;
}

const SEMVER = /\b(\d+\.\d+\.\d+)\b/;

/** `dpm version` lists installed SDKs and marks the active one with `*`. */
function parseActiveSdkVersion(stdout: string): string | undefined {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  const marked = lines.find((line) => line.includes('*'));
  const source = marked ?? lines[0];
  return source === undefined ? undefined : (SEMVER.exec(source)?.[1] ?? undefined);
}

export async function readToolchainVersions(): Promise<ToolchainVersions> {
  const definition = dpmCommand('dpm_version');
  const cwd = os.tmpdir();

  const sdk = await execute({ definition, argv: ['version'], cwd, timeoutMs: 60_000 });
  if (sdk.exitCode !== 0) {
    throw new ToolchainError(`\`dpm version\` failed with exit code ${String(sdk.exitCode)}.`);
  }
  const damlSdkVersion = parseActiveSdkVersion(sdk.stdout);
  if (damlSdkVersion === undefined) {
    throw new ToolchainError('Could not determine the active Daml SDK version.');
  }

  const cli = await execute({ definition, argv: ['--version'], cwd, timeoutMs: 60_000 });
  if (cli.exitCode !== 0) {
    throw new ToolchainError(`\`dpm --version\` failed with exit code ${String(cli.exitCode)}.`);
  }
  const dpmCliVersion = SEMVER.exec(cli.stdout)?.[1];
  if (dpmCliVersion === undefined) {
    throw new ToolchainError('Could not determine the dpm CLI version.');
  }

  return { damlSdkVersion, dpmCliVersion, dpmExecutable: definition.executable };
}

/** Throw unless the installed toolchain matches the versions pinned by plan.md. */
export async function assertPinnedToolchain(): Promise<ToolchainVersions> {
  const versions = await readToolchainVersions();

  if (versions.damlSdkVersion !== REQUIRED_DAML_SDK_VERSION) {
    throw new ToolchainError(
      `Daml SDK ${REQUIRED_DAML_SDK_VERSION} is required, found ${versions.damlSdkVersion}.`,
    );
  }
  if (versions.dpmCliVersion !== REQUIRED_DPM_CLI_VERSION) {
    throw new ToolchainError(
      `dpm ${REQUIRED_DPM_CLI_VERSION} is required, found ${versions.dpmCliVersion}.`,
    );
  }

  return versions;
}
