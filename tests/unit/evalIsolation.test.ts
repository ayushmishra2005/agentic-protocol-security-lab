// Architectural test (Constitution Article IV): the evaluation harness must be
// unreachable from anything the model can influence.
//
// This is asserted structurally rather than by convention, because a convention
// holds only until someone adds a convenient import. The check is a static one
// over the import graph: if a model-facing module could reach `src/eval/`, a
// future tool or prompt path could carry an expectation or a score back into the
// conversation, and the benchmark would be grading a model that had seen the
// answer key.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { TOOL_REGISTRY } from '../../src/tools/registry.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceRoot = path.join(repoRoot, 'src');

/**
 * Directories reachable while a model is in the loop: the phase runners, the
 * provider client, and the tool implementations the model can invoke.
 */
const MODEL_FACING_DIRECTORIES = ['agent', 'model', 'tools', 'evidence', 'security', 'report'];

function sourceFilesUnder(directory: string): string[] {
  const root = path.join(sourceRoot, directory);
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) found.push(full);
    }
  };
  walk(root);
  return found;
}

/** Module specifiers imported by one file. */
function importsOf(file: string): string[] {
  const contents = fs.readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g;

  let match = pattern.exec(contents);
  while (match !== null) {
    if (match[1] !== undefined) specifiers.push(match[1]);
    match = pattern.exec(contents);
  }
  return specifiers;
}

function resolvesIntoEval(file: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const resolved = path.resolve(path.dirname(file), specifier);
  return resolved.startsWith(path.join(sourceRoot, 'eval') + path.sep);
}

describe('no model-facing code path can reach the evaluation harness', () => {
  for (const directory of MODEL_FACING_DIRECTORIES) {
    it(`src/${directory}/ does not import src/eval/`, () => {
      for (const file of sourceFilesUnder(directory)) {
        for (const specifier of importsOf(file)) {
          assert.equal(
            resolvesIntoEval(file, specifier),
            false,
            `${path.relative(repoRoot, file)} imports ${specifier}`,
          );
        }
      }
    });
  }

  it('finds real imports, so the check is not vacuously passing', () => {
    // Guards the regex itself: if it silently matched nothing, every assertion
    // above would pass while checking nothing at all.
    const files = sourceFilesUnder('agent');
    assert.ok(files.length > 0);
    assert.ok(files.some((file) => importsOf(file).length > 0));
  });

  it('the eval harness is reached only from the CLI', () => {
    // The one legitimate caller. `src/cli/eval.ts` is host code with no model in
    // the loop; the model has no way to invoke a CLI command.
    const importers = ['agent', 'model', 'tools', 'evidence', 'security', 'report', 'cli']
      .flatMap((directory) => sourceFilesUnder(directory))
      .filter((file) => importsOf(file).some((specifier) => resolvesIntoEval(file, specifier)));

    assert.deepEqual(importers.map((file) => path.relative(repoRoot, file)).sort(), [
      'src/cli/eval.ts',
    ]);
  });
});

describe('the model cannot produce or modify a scorecard', () => {
  it('exposes no tool that names the scorecard, the scorer, or an expectation', () => {
    const surface = JSON.stringify(
      TOOL_REGISTRY.map((descriptor) => ({
        name: descriptor.name,
        description: descriptor.description,
      })),
    ).toLowerCase();

    for (const forbidden of ['scorecard', 'scorer', 'expected.json', 'expectation', 'oracle']) {
      assert.equal(surface.includes(forbidden), false, `the tool surface mentions ${forbidden}`);
    }
  });

  it('exposes no tool that can write anything', () => {
    // The only model-influenced write in the system is a generated Script through
    // the Phase 9 write boundary, which is host-invoked and not a registered tool.
    for (const descriptor of TOOL_REGISTRY) {
      assert.equal(/write|create|delete|remove|move/.test(descriptor.name), false, descriptor.name);
    }
  });
});
