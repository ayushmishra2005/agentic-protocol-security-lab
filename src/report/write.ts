/**
 * Report persistence.
 *
 * The two filenames are constants and the directory is the run's own, derived
 * from a run id the host allocated. No part of either path comes from a model
 * response, a report field, or the analysed repository, so there is nothing
 * here for a hostile string to steer. This is not registered as a tool and is
 * not reachable from `dispatchTool`.
 *
 * The Markdown is rendered from the same in-memory `Report` that is serialised
 * to JSON, in one call, so the two files cannot describe different runs.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ReportSchema, type Report } from '../schemas/report.js';
import { canonicalize, isWithin, PathSecurityError } from '../security/paths.js';
import { renderReport } from './render.js';

export const REPORT_JSON_FILENAME = 'report.json';
export const REPORT_MARKDOWN_FILENAME = 'report.md';

export interface WrittenReport {
  readonly jsonPath: string;
  readonly markdownPath: string;
}

/**
 * Write `report.json` and `report.md` into a run directory.
 *
 * The report is re-validated on the way out. Serialising an object that no
 * longer satisfies the schema — because a caller mutated it after assembly —
 * would put an unchecked document on disk under a name that implies otherwise.
 */
export function writeReportOutputs(runDirectory: string, report: Report): WrittenReport {
  if (!path.isAbsolute(runDirectory)) {
    throw new PathSecurityError(`Run directory must be absolute, received ${runDirectory}.`);
  }

  const parsed = ReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new PathSecurityError('Refusing to write a report that does not satisfy ReportSchema.');
  }

  fs.mkdirSync(runDirectory, { recursive: true });
  const root = fs.realpathSync(runDirectory);

  const jsonPath = path.join(root, REPORT_JSON_FILENAME);
  const markdownPath = path.join(root, REPORT_MARKDOWN_FILENAME);

  for (const target of [jsonPath, markdownPath]) {
    // Containment is checked on canonical paths, so a symlink planted at either
    // filename cannot redirect the write into the repository.
    if (!isWithin(root, canonicalize(target))) {
      throw new PathSecurityError(`Report output ${target} resolves outside the run directory.`);
    }
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      throw new PathSecurityError(`Refusing to write through a symbolic link at ${target}.`);
    }
  }

  fs.writeFileSync(jsonPath, `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownPath, renderReport(parsed.data), 'utf8');

  return { jsonPath, markdownPath };
}
