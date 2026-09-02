/**
 * Workspace path confinement (Constitution Article II).
 *
 * Containment is decided on canonical, symlink-resolved paths using path
 * segment comparison. A lexical `startsWith` test is deliberately not used: it
 * accepts sibling-prefix escapes such as `/ws-evil` against a root of `/ws`,
 * and it accepts symlinks that point outside the root.
 */
import fs from 'node:fs';
import path from 'node:path';

export class PathSecurityError extends Error {
  override readonly name = 'PathSecurityError';
}

export interface Workspace {
  /** Canonical, symlink-resolved absolute root. */
  readonly root: string;
}

/** Create a workspace from an existing directory. */
export function createWorkspace(root: string): Workspace {
  const absolute = path.resolve(root);

  let real: string;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    throw new PathSecurityError(`Workspace root does not exist: ${absolute}`);
  }

  if (!fs.statSync(real).isDirectory()) {
    throw new PathSecurityError(`Workspace root is not a directory: ${real}`);
  }

  return { root: real };
}

/**
 * Canonicalise a path that may not exist yet.
 *
 * Walks up to the nearest existing ancestor, resolves that ancestor's
 * symlinks, then re-appends the missing trailing segments. This means a path
 * whose parent is a symlink out of the workspace is still caught.
 */
export function canonicalize(target: string): string {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      const resolved = fs.realpathSync(current);
      return missing.length === 0 ? resolved : path.join(resolved, ...missing.slice().reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding anything that exists.
        return absolute;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * True when `target` is the root itself or lies beneath it.
 * Both arguments must already be canonical absolute paths.
 */
export function isWithin(root: string, target: string): boolean {
  if (target === root) return true;
  const relative = path.relative(root, target);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  if (relative === '..') return false;
  return !relative.startsWith(`..${path.sep}`);
}

/**
 * Resolve a caller-supplied path inside the workspace, or throw.
 *
 * Relative inputs resolve against the workspace root. Absolute inputs are
 * permitted only when they canonicalise to a location inside the root.
 */
export function resolveWithin(workspace: Workspace, candidate: string): string {
  if (candidate.includes('\0')) {
    throw new PathSecurityError('Path contains a NUL byte.');
  }

  const joined = path.isAbsolute(candidate) ? candidate : path.join(workspace.root, candidate);
  const canonical = canonicalize(joined);

  if (!isWithin(workspace.root, canonical)) {
    throw new PathSecurityError(
      `Path escapes the workspace root: ${candidate} resolves outside ${workspace.root}`,
    );
  }

  return canonical;
}

/** Path relative to the workspace root, for stable reporting. */
export function relativeToWorkspace(workspace: Workspace, absolute: string): string {
  const relative = path.relative(workspace.root, absolute);
  return relative === '' ? '.' : relative;
}
