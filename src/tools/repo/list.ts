/**
 * Bounded listing and search within the workspace.
 *
 * Search takes a literal substring rather than a caller-supplied regular
 * expression. A model-supplied pattern would be an unbounded backtracking
 * hazard, and literal matching is sufficient for locating Daml constructs.
 */
import fs from 'node:fs';
import path from 'node:path';

import { REPO_READ_DEFAULTS } from '../../config.js';
import { relativeToWorkspace, resolveWithin, type Workspace } from '../../security/paths.js';
import { redact } from '../../security/redact.js';
import { isReadable, isTraversableDirectory } from './policy.js';

export interface ListFilesOptions {
  readonly directory?: string;
  /** Lower-case extensions including the dot, e.g. `.daml`. */
  readonly extensions?: readonly string[];
  readonly maxEntries?: number;
}

export interface ListFilesResult {
  readonly directory: string;
  readonly files: readonly string[];
  readonly truncated: boolean;
}

function walk(
  workspace: Workspace,
  root: string,
  extensions: readonly string[] | undefined,
  limit: number,
  collected: string[],
): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (collected.length >= limit) return true;
    const absolute = path.join(root, entry.name);

    if (entry.isDirectory()) {
      if (!isTraversableDirectory(entry.name)) continue;
      if (!isReadable(workspace, absolute)) continue;
      if (walk(workspace, absolute, extensions, limit, collected)) return true;
      continue;
    }

    if (!entry.isFile()) continue;
    if (!isReadable(workspace, absolute)) continue;
    if (extensions && !extensions.includes(path.extname(entry.name).toLowerCase())) continue;
    collected.push(relativeToWorkspace(workspace, absolute));
  }
  return false;
}

export function listFiles(workspace: Workspace, options: ListFilesOptions = {}): ListFilesResult {
  const limit = options.maxEntries ?? REPO_READ_DEFAULTS.maxEntries;
  const absoluteDir = resolveWithin(workspace, options.directory ?? '.');
  const collected: string[] = [];
  const truncated = walk(workspace, absoluteDir, options.extensions, limit, collected);

  return {
    directory: relativeToWorkspace(workspace, absoluteDir),
    files: collected,
    truncated,
  };
}

export interface SearchOptions {
  readonly directory?: string;
  readonly extensions?: readonly string[];
  readonly maxMatches?: number;
  readonly caseSensitive?: boolean;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface SearchResult {
  readonly query: string;
  readonly matches: readonly SearchMatch[];
  readonly truncated: boolean;
}

/** Literal substring search across readable files. */
export function searchText(
  workspace: Workspace,
  query: string,
  options: SearchOptions = {},
): SearchResult {
  if (query.length === 0) {
    throw new Error('Search query must not be empty.');
  }
  const maxMatches = options.maxMatches ?? REPO_READ_DEFAULTS.maxSearchMatches;
  const listing = listFiles(workspace, {
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
  });

  const needle = options.caseSensitive === true ? query : query.toLowerCase();
  const matches: SearchMatch[] = [];

  for (const relative of listing.files) {
    if (matches.length >= maxMatches) {
      return { query, matches, truncated: true };
    }
    const absolute = resolveWithin(workspace, relative);
    let content: string;
    try {
      content = fs.readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index] ?? '';
      const haystack = options.caseSensitive === true ? raw : raw.toLowerCase();
      if (!haystack.includes(needle)) continue;
      if (matches.length >= maxMatches) {
        return { query, matches, truncated: true };
      }
      matches.push({ path: relative, line: index + 1, text: redact(raw.slice(0, 500)) });
    }
  }

  return { query, matches, truncated: listing.truncated };
}
