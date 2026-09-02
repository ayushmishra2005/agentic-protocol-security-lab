/**
 * The run-scoped write boundary (T059).
 *
 * This is the only place in the system where anything model-influenced reaches
 * the filesystem, and it is deliberately narrow. There is no `writeFile`, no
 * `mkdir`, no rename, no delete, and no tool in `TOOL_REGISTRY` that writes:
 * the model cannot ask for a write at all. It produces a generated-test
 * artifact, the host validates it, and then host code calls
 * `writeGeneratedScript` here with a destination the host chose.
 *
 * The model never supplies a path. It supplies a script name, which is not a
 * path: it is validated against a conservative pattern, rejected if it contains
 * a separator, a dot, or anything but an identifier, and then mapped onto a
 * canonical filename the host constructs. A name is data used to build a
 * filename, never a filename.
 *
 * Everything else is outside. The checked-in fixture, its `expected.json`, the
 * oracle package, `src/eval/`, the repository source, `.github`, `.git`, and
 * package configuration are unreachable — not because they are enumerated as a
 * denylist, but because the boundary is an allowlist of exactly one directory
 * per run and every write is confined to it by canonical, symlink-resolved
 * containment. Enumerating what must not be written is a losing game; naming
 * the one place that may be written is not.
 *
 * Refusals are recorded. A refused write appends an evidence record with the
 * requested name, the reason, and no process detail, because no process ran.
 * Fabricating an argv and an exit code for an operation that never spawned
 * anything would make the log a worse witness, not a better one.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { EvidenceStore } from '../evidence/store.js';
import { canonicalize, isWithin, PathSecurityError } from '../security/paths.js';
import { redact } from '../security/redact.js';

export class WriteBoundaryError extends Error {
  override readonly name = 'WriteBoundaryError';
  readonly evidenceId: string | undefined;

  constructor(message: string, evidenceId?: string) {
    super(message);
    this.evidenceId = evidenceId;
  }
}

/**
 * Daml module names: a capitalised identifier and nothing else.
 *
 * No separator, no dot, no extension, no leading dash. `..` cannot match, and
 * neither can `Foo.daml`, `../../Asset`, or an absolute path.
 */
const SCRIPT_NAME = /^[A-Z][A-Za-z0-9_]{0,63}$/;

/** Upper bound on generated source, so a runaway response cannot fill a disk. */
const MAX_SCRIPT_BYTES = 256 * 1024;

export interface WriteBoundaryOptions {
  /** Absolute path of the run's generated-output directory. Host-chosen. */
  readonly generatedRoot: string;
  readonly store: EvidenceStore;
}

export interface WrittenScript {
  /** Absolute path written. */
  readonly absolutePath: string;
  /** Path relative to the generated root, for reporting. */
  readonly relativePath: string;
  readonly scriptName: string;
  readonly bytesWritten: number;
  readonly evidenceId: string;
  /** True when this replaced an earlier version of the same script. */
  readonly replaced: boolean;
}

/**
 * A write surface scoped to one run's generated directory.
 *
 * Construct one per run, from a directory the host owns. Nothing here accepts a
 * directory from a model-derived value.
 */
export class WriteBoundary {
  readonly generatedRoot: string;
  readonly #store: EvidenceStore;

  constructor(options: WriteBoundaryOptions) {
    if (!path.isAbsolute(options.generatedRoot)) {
      throw new WriteBoundaryError(
        `Generated root must be an absolute host-chosen path, received ${options.generatedRoot}.`,
      );
    }

    fs.mkdirSync(options.generatedRoot, { recursive: true });
    // Canonicalised once, after creation: containment is then compared against
    // a real path, so a symlinked run directory cannot widen the boundary.
    this.generatedRoot = fs.realpathSync(options.generatedRoot);
    this.#store = options.store;
  }

  /**
   * Write one generated Daml Script into the run's generated directory.
   *
   * Revision reuses this method with the same script name, which replaces the
   * previous file in place. That is the only form of overwrite available, and
   * it cannot reach outside the generated root. Earlier evidence is untouched:
   * the store is append-only, so the failed attempt and the corrected one are
   * both permanently readable.
   */
  writeGeneratedScript(request: { scriptName: string; source: string }): WrittenScript {
    const scriptName = request.scriptName;

    if (!SCRIPT_NAME.test(scriptName)) {
      throw this.#refuse(scriptName, 'InvalidScriptName', {
        message:
          `Rejected generated script name: ${scriptName}. ` +
          'A script name is an identifier, not a path.',
      });
    }
    if (typeof request.source !== 'string' || request.source.length === 0) {
      throw this.#refuse(scriptName, 'EmptyScriptSource', {
        message: `Generated script ${scriptName} carried no source.`,
      });
    }

    const bytes = Buffer.byteLength(request.source, 'utf8');
    if (bytes > MAX_SCRIPT_BYTES) {
      throw this.#refuse(scriptName, 'ScriptTooLarge', {
        message: `Generated script ${scriptName} is ${String(bytes)} bytes, over the limit.`,
      });
    }

    // The filename is built here, by the host, from a validated identifier.
    const absolutePath = path.join(this.generatedRoot, `${scriptName}.daml`);

    // Belt and braces. The name pattern already excludes separators, so this
    // cannot fire today; it is the check that keeps that true if the pattern is
    // ever loosened, and it also catches a pre-existing symlink at the target.
    const canonical = canonicalize(absolutePath);
    if (!isWithin(this.generatedRoot, canonical)) {
      throw this.#refuse(scriptName, 'PathEscape', {
        message: `Generated script ${scriptName} resolves outside the run's generated directory.`,
      });
    }

    let replaced = false;
    try {
      const existing = fs.lstatSync(absolutePath);
      // A symlink sitting where the script goes would redirect the write. It is
      // never something this boundary created, so it is refused rather than
      // followed or quietly removed.
      if (existing.isSymbolicLink()) {
        throw this.#refuse(scriptName, 'SymlinkAtDestination', {
          message: `Refusing to write through a symbolic link at ${scriptName}.daml.`,
        });
      }
      if (!existing.isFile()) {
        throw this.#refuse(scriptName, 'DestinationNotAFile', {
          message: `Destination for ${scriptName}.daml exists and is not a regular file.`,
        });
      }
      replaced = true;
    } catch (error) {
      if (error instanceof WriteBoundaryError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw this.#refuse(scriptName, 'DestinationUnusable', {
          message: `Cannot use destination for ${scriptName}.daml.`,
        });
      }
    }

    // `wx` on a fresh write refuses to follow a symlink that appears between
    // the check above and here; a replacement is a plain truncating write to a
    // path already established to be a regular file inside the root.
    fs.writeFileSync(absolutePath, request.source, {
      encoding: 'utf8',
      flag: replaced ? 'w' : 'wx',
    });

    const relativePath = path.relative(this.generatedRoot, absolutePath);
    const record = this.#store.append({
      toolName: 'host_write_generated_script',
      outcome: 'ok',
      parameters: { scriptName, sourceBytes: bytes },
      result: { relativePath, replaced, bytesWritten: bytes },
    });

    return {
      absolutePath,
      relativePath,
      scriptName,
      bytesWritten: bytes,
      evidenceId: record.evidenceId,
      replaced,
    };
  }

  /** Generated scripts written so far, relative to the generated root. */
  listGeneratedScripts(): readonly string[] {
    return fs
      .readdirSync(this.generatedRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.daml'))
      .map((entry) => entry.name)
      .sort();
  }

  #refuse(
    scriptName: string,
    name: string,
    detail: { readonly message: string },
  ): WriteBoundaryError {
    const message = redact(detail.message);
    const record = this.#store.append({
      toolName: 'host_write_generated_script',
      outcome: 'error',
      // No process detail: nothing was spawned, and inventing an argv and an
      // exit code would misrepresent what happened.
      parameters: { scriptName: redact(scriptName) },
      error: { name, message },
    });
    return new WriteBoundaryError(message, record.evidenceId);
  }
}

/**
 * The generated directory for a run.
 *
 * Host-chosen and derived only from host values, so no model-supplied string
 * takes part in locating it.
 */
export function generatedRootFor(runsRoot: string, runId: string): string {
  if (!path.isAbsolute(runsRoot)) {
    throw new WriteBoundaryError(`runsRoot must be absolute, received ${runsRoot}.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId)) {
    throw new PathSecurityError(`Unsafe run id: ${runId}`);
  }
  return path.join(runsRoot, runId, 'generated');
}
