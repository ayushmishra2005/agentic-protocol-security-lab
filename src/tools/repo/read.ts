/**
 * Bounded file reads confined to the workspace.
 *
 * This is not a general filesystem API: there is no write, no delete, no
 * rename, and no way to reach outside the workspace root.
 */
import fs from 'node:fs';

import { REPO_READ_DEFAULTS } from '../../config.js';
import { relativeToWorkspace, resolveWithin, type Workspace } from '../../security/paths.js';
import { redact } from '../../security/redact.js';
import { assertReadable, RepoPolicyError } from './policy.js';

export interface ReadFileOptions {
  readonly maxBytes?: number;
}

export interface ReadFileResult {
  /** Workspace-relative path. Absolute host paths are never returned. */
  readonly path: string;
  readonly content: string;
  readonly bytesRead: number;
  readonly truncated: boolean;
}

/** Reject files that are not plausibly UTF-8 text. */
function looksBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8_000);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

export function readFileBounded(
  workspace: Workspace,
  candidatePath: string,
  options: ReadFileOptions = {},
): ReadFileResult {
  const maxBytes = options.maxBytes ?? REPO_READ_DEFAULTS.maxFileBytes;
  const absolute = resolveWithin(workspace, candidatePath);
  assertReadable(workspace, absolute);

  const stat = fs.statSync(absolute);
  if (!stat.isFile()) {
    throw new RepoPolicyError(`Not a regular file: ${relativeToWorkspace(workspace, absolute)}`);
  }

  const handle = fs.openSync(absolute, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, 0);
    const slice = buffer.subarray(0, bytesRead);

    if (looksBinary(slice)) {
      throw new RepoPolicyError(
        `Refusing to read binary file: ${relativeToWorkspace(workspace, absolute)}`,
      );
    }

    return {
      path: relativeToWorkspace(workspace, absolute),
      content: redact(slice.toString('utf8')),
      bytesRead,
      truncated: stat.size > bytesRead,
    };
  } finally {
    fs.closeSync(handle);
  }
}
