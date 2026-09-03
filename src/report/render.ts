/**
 * Markdown rendering (T068).
 *
 * `report.json` is the source of truth and this file is a view of it. The
 * function below takes a validated `Report` and returns a string. It reads no
 * file, resolves no evidence, calls no model, and reaches nothing outside its
 * argument, which is what makes the guarantee checkable rather than aspirational:
 * a claim cannot appear in the Markdown unless the JSON already contains it,
 * because there is nowhere else for it to come from.
 *
 * Two consequences worth stating, because they are the failure modes this
 * design exists to rule out. The renderer cannot add a finding, since it only
 * iterates the array it was given. And it cannot upgrade a finding's state,
 * since the state is printed from the field rather than recomputed from
 * whatever the surrounding text seems to imply.
 *
 * The boundary statement and the verification note are not literals here. They
 * are read from the report, so the published document and the structured record
 * cannot drift apart, and a report that somehow lacked one would render without
 * it rather than have the renderer quietly supply it.
 */
import type { Finding, Invariant } from '../schemas/findings.js';
import type { GeneratedTestResult, Report } from '../schemas/report.js';

/**
 * Make target-derived text safe to place in a Markdown document.
 *
 * Everything printed below other than the host's own headings originates in the
 * analysed repository or in a model response, and neither is trusted. Three
 * things are neutralised: `<` and `>`, so a string cannot open an HTML element
 * in renderers that allow inline HTML; backticks and pipes, so it cannot break
 * out of a code span or a table cell; and control characters, so it cannot move
 * the cursor around in a terminal that renders the file.
 *
 * Nothing here evaluates HTML, follows a link, or produces a clickable action.
 * The output is a document.
 */
export function escapeText(value: string): string {
  return (
    value
      // Removing control characters is the intent, so the class is deliberate.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/[<>]/g, (character) => (character === '<' ? '&lt;' : '&gt;'))
      .replace(/([`|\\])/g, '\\$1')
  );
}

/** Single-line form, for table cells and headings. */
function inline(value: string): string {
  return escapeText(value).replace(/\r?\n/g, ' ');
}

function heading(level: number, text: string): string {
  return `${'#'.repeat(level)} ${text}`;
}

function bulletList(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

function renderFinding(finding: Finding, index: number): string {
  const construct = [finding.template, finding.choice].filter(Boolean).join('.');

  const facts = [
    `State: ${finding.state}`,
    `Severity: ${finding.severity}`,
    `Class: ${inline(finding.class)}`,
    ...(construct.length > 0 ? [`Daml construct: ${inline(construct)}`] : []),
    finding.evidence.length === 0
      ? 'Evidence: none recorded'
      : `Evidence: ${finding.evidence.map((ref) => inline(ref.evidenceId)).join(', ')}`,
  ];

  return [
    heading(3, `${String(index + 1)}. ${inline(finding.title)}`),
    '',
    bulletList(facts),
    '',
    // Multi-line detail, escaped and kept as prose rather than reinterpreted.
    escapeText(finding.detail),
  ].join('\n');
}

function renderInvariant(invariant: Invariant): string {
  const construct = [invariant.template, invariant.choice].filter(Boolean).join('.');
  const suffix = construct.length > 0 ? ` (${inline(construct)})` : '';
  const evidence =
    invariant.evidence.length === 0
      ? 'no resolvable evidence'
      : invariant.evidence.map((ref) => inline(ref.evidenceId)).join(', ');

  return `- \`${inline(invariant.id)}\`${suffix}: ${inline(invariant.statement)} — evidence: ${evidence}`;
}

function renderTest(test: GeneratedTestResult): string {
  const ran =
    test.evidenceId === undefined
      ? 'not executed'
      : `executed (evidence ${inline(test.evidenceId)})`;

  return (
    `- \`${inline(test.id)}\` → \`${inline(test.relativePath)}\` (attempt ${String(test.attempt)}): ` +
    `${inline(test.outcome)}; declared ${inline(test.expectedOutcome)} before running; ` +
    `${test.compiled ? 'compiled' : 'did not compile'}, ${ran}; ` +
    `compile evidence ${inline(test.compileEvidenceId)}`
  );
}

function renderRevision(report: Report): readonly string[] {
  const revision = report.revision;
  if (revision === undefined) return [];

  const state = revision.exhausted
    ? `the budget of ${String(revision.maxRevisions)} was exhausted with a correction still outstanding`
    : 'the cycle completed within budget';

  return [
    heading(2, 'Revision'),
    '',
    bulletList([
      `Execution attempts: ${String(revision.attempts)}`,
      `Host-ordered revisions: ${String(revision.revisions)} of ${String(revision.maxRevisions)}`,
      `Outcome: ${state}`,
    ]),
    '',
  ];
}

/**
 * Render a report as Markdown.
 *
 * Deterministic: the same report always produces the same string. Nothing here
 * reads a clock, a random source, or the filesystem.
 */
export function renderReport(report: Report): string {
  const sections: string[] = [
    heading(1, `Security review: ${inline(report.target.relativePath)}`),
    '',
    // First line of the document, from the JSON field.
    `> ${inline(report.boundaryStatement)}`,
    '',
    escapeText(report.summary),
    '',
    heading(2, 'Run'),
    '',
    bulletList([
      `Run id: \`${inline(report.runId)}\``,
      `Started: ${inline(report.startedAt)}`,
      `Completed: ${inline(report.completedAt)}`,
      `Daml SDK: ${inline(report.toolchain.damlSdkVersion)}`,
      `dpm: ${inline(report.toolchain.dpmVersion)}`,
      `Model: ${inline(report.model.id)}`,
      `Model calls: ${String(report.usage.modelCalls)}`,
      `Tokens in/out: ${String(report.usage.inputTokens)}/${String(report.usage.outputTokens)}`,
      `Cache tokens read/created: ${String(report.usage.cacheReadInputTokens)}/${String(report.usage.cacheCreationInputTokens)}`,
      `Tool invocations: ${String(report.usage.toolInvocations)} dispatched, ${String(report.usage.toolInvocationsRefused)} refused`,
    ]),
    '',
  ];

  sections.push(...renderRevision(report));

  sections.push(heading(2, 'Findings'), '');
  if (report.findings.length === 0) {
    sections.push('No findings were produced by this run.', '');
  } else {
    for (const [index, finding] of report.findings.entries()) {
      sections.push(renderFinding(finding, index), '');
    }
  }

  sections.push(heading(2, 'Invariants under test'), '');
  sections.push(
    report.invariants.length === 0
      ? 'No invariants were derived.'
      : report.invariants.map(renderInvariant).join('\n'),
    '',
  );

  sections.push(heading(2, 'Generated tests'), '');
  sections.push(
    report.generatedTests.length === 0
      ? 'No generated test was executed.'
      : report.generatedTests.map(renderTest).join('\n'),
    '',
  );

  if (report.degradedPhases.length > 0) {
    sections.push(
      heading(2, 'Incomplete phases'),
      '',
      bulletList(report.degradedPhases.map((phase) => inline(phase))),
      '',
    );
  }

  sections.push(
    heading(2, 'What this report is'),
    '',
    escapeText(report.verification.note),
    '',
    bulletList(report.verification.scopeLimitations.map((limitation) => escapeText(limitation))),
    '',
    `> ${inline(report.boundaryStatement)}`,
    '',
  );

  return `${sections
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
