/**
 * The `understand` and `inspect` phases (T051).
 *
 * These two are defined together because they share one idea: the model is not
 * handed the repository. It is told where the target is and given bounded
 * listing, reading, searching and version-control tools, and it has to ask.
 * That is what makes the evidence real — every fact in the artifact traces to a
 * tool call the host executed and recorded, rather than to text the host
 * pasted into a prompt.
 *
 * Neither phase parses Daml. The model reads source and reports what it saw. A
 * host-side extractor is a separate, later task and would be labelled a
 * heuristic wherever its output appeared; nothing here claims to be a parser.
 */
import type { PhaseDefinition } from './runPhase.js';

export const understandPhase: PhaseDefinition<'understand'> = {
  phase: 'understand',
  consumes: [],
  objective:
    'Establish a bounded structural understanding of the target: what Daml packages exist, where ' +
    'their manifests and sources are, and which modules, templates and choices are visible in the ' +
    'source you actually read.',
  toolGuidance: [
    'You have not been given the repository contents. Obtain them with the tools:',
    '- repo_list_files to discover structure; filter by extension such as .daml or .yaml.',
    '- repo_read_file to read a specific file you have located.',
    '- repo_search_text for a literal substring across readable files.',
    '',
    'Work within your tool budget. Prefer reading the package manifests and the Daml sources they',
    'point at over reading everything. Some paths are unreadable by host policy; if a read is',
    'refused, record that as a limitation and move on rather than retrying it.',
  ].join('\n'),
  acceptance: [
    'summary: what the target is and how it is structured, in prose.',
    'damlPackages: the package roots or manifest paths you actually located.',
    'evidence: one identifier per tool call whose result you relied on.',
    'State explicitly in the summary which parts of the target you did not inspect. An unexamined ' +
      'area is a limitation to report, not a gap to fill by assumption.',
    'Do not describe runtime behaviour. This phase establishes structure only.',
  ],
};

export const inspectPhase: PhaseDefinition<'inspect'> = {
  phase: 'inspect',
  consumes: ['understand'],
  objective:
    'Inspect the security-relevant source surface: the templates, choices and party roles that ' +
    'determine who may do what. Where version-control context exists, identify what recently ' +
    'changed, since a recent change to an authorisation construct deserves attention.',
  toolGuidance: [
    'Use repo_read_file and repo_search_text for source, and the version-control tools for change',
    'context:',
    '- git_status for the working tree.',
    '- git_diff for changes, optionally scoped to paths.',
    '- git_log for recent commit metadata.',
    '',
    'The target may not be a git repository, or may have no changes, or may have no history you can',
    'reach. Any of those is a normal outcome: record it as an inspection gap in changeSummary and',
    'inspect the source as a whole instead. Never describe a diff you did not receive from a tool.',
  ].join('\n'),
  acceptance: [
    'inspectedFiles: the workspace-relative paths you actually read or searched.',
    'changeSummary: what the version-control context showed, or a plain statement that it was ' +
      'unavailable or empty, and what you inspected instead.',
    'evidence: one identifier per tool call you relied on, including calls that returned nothing.',
    'Report only what the tool results contained. Do not infer the content of a file you did not read.',
  ],
};
