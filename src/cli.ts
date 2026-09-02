#!/usr/bin/env node
/**
 * Host CLI. Only the deterministic foundation exists so far, so the single
 * command verifies that the pinned toolchain and the tool surface are sound.
 */
import { Command } from 'commander';

import { resolveDpmExecutable, resolveGitExecutable, resolveModelId } from './config.js';
import { assertPinnedToolchain } from './tools/daml/version.js';
import { assertNoNetworkCapableTools, TOOL_NAMES } from './tools/registry.js';

async function doctor(): Promise<void> {
  assertNoNetworkCapableTools();

  const dpm = resolveDpmExecutable();
  const git = resolveGitExecutable();
  const versions = await assertPinnedToolchain();

  process.stdout.write(
    [
      `dpm executable      ${dpm}`,
      `git executable      ${git}`,
      `Daml SDK            ${versions.damlSdkVersion}`,
      `dpm CLI             ${versions.dpmCliVersion}`,
      `pinned model        ${resolveModelId()} (not contacted)`,
      `registered tools    ${TOOL_NAMES.length} (${TOOL_NAMES.join(', ')})`,
      '',
    ].join('\n'),
  );
}

const program = new Command();

program
  .name('apsl')
  .description('Agentic protocol security lab: deterministic host foundation')
  .version('0.1.0');

program
  .command('doctor')
  .description('Verify the pinned toolchain and the deterministic tool surface')
  .action(async () => {
    try {
      await doctor();
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
