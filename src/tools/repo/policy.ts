/**
 * Read policy for the generic, model-facing repository tools.
 *
 * Two categories are denied. Credential-bearing files are denied because of
 * Article V. Fixture expectations and scorer sources are denied because of
 * Article IV: if the model could read `expected.json`, an evaluation would
 * measure recall of a supplied answer rather than analysis.
 */
import path from 'node:path';

import { relativeToWorkspace, type Workspace } from '../../security/paths.js';

export class RepoPolicyError extends Error {
  override readonly name = 'RepoPolicyError';
}

/** Exact file names never returned to a caller. */
const DENIED_BASENAMES: ReadonlySet<string> = new Set([
  'expected.json',
  '.env',
  '.npmrc',
  'id_rsa',
  'id_ecdsa',
  'id_ed25519',
  '.netrc',
]);

/** Path segments whose subtrees are never traversed or returned. */
const DENIED_SEGMENTS: ReadonlySet<string> = new Set(['.git', 'node_modules', 'dist', 'runs']);

/** Workspace-relative prefixes that are host-only. */
const DENIED_PREFIXES: readonly string[] = ['src/eval/'];

/** Extensions that commonly carry key material. */
const DENIED_EXTENSIONS: ReadonlySet<string> = new Set(['.pem', '.key', '.p12', '.pfx']);

function normalise(relative: string): string {
  return relative.split(path.sep).join('/');
}

/** True when the path may be listed, searched or read by a model-facing tool. */
export function isReadable(workspace: Workspace, absolutePath: string): boolean {
  const relative = normalise(relativeToWorkspace(workspace, absolutePath));
  if (relative === '.') return true;

  const base = path.basename(relative);
  if (DENIED_BASENAMES.has(base)) return false;
  if (DENIED_EXTENSIONS.has(path.extname(base).toLowerCase())) return false;
  if (base.startsWith('.env.')) return false;

  for (const segment of relative.split('/')) {
    if (DENIED_SEGMENTS.has(segment)) return false;
  }
  for (const prefix of DENIED_PREFIXES) {
    if (relative === prefix.replace(/\/$/, '') || relative.startsWith(prefix)) return false;
  }
  return true;
}

/** Throw unless the path is readable. */
export function assertReadable(workspace: Workspace, absolutePath: string): void {
  if (!isReadable(workspace, absolutePath)) {
    throw new RepoPolicyError(
      `Path is not readable through repository tools: ${normalise(
        relativeToWorkspace(workspace, absolutePath),
      )}`,
    );
  }
}

/** True when a directory should be traversed during listing or search. */
export function isTraversableDirectory(name: string): boolean {
  return !DENIED_SEGMENTS.has(name);
}
