/**
 * The evaluation analysis view.
 *
 * A checked-in fixture holds three kinds of material: the vulnerable Daml
 * source, the host-owned oracle that proves the defect, and the host-owned
 * expectation the scorer grades against. Only the first is the model's to see.
 * If the evaluated model could read the other two, a passing score would
 * measure how well it copied an answer it was handed.
 *
 * The mechanism is deliberately dull: copy the model-visible material into a
 * scratch directory and point the workspace at that. The model then cannot read
 * the expectation because it is not there — not because a filename was
 * blacklisted. That distinction matters in both directions. A user analysing
 * their own project may have a perfectly ordinary `expected.json`, and denying
 * the basename globally would break them for no security benefit; conversely, a
 * benchmark answer stored under some other name would have slipped straight
 * through a name-based rule.
 *
 * This lives under `src/eval/`, which the repository read policy makes
 * unreadable to model-facing tools, so the benchmark policy cannot be read
 * through the surface it exists to constrain. The copying itself lives in
 * `src/agent/targetView.ts`: the execution workspace needs it on every run, and
 * no model-facing module may import from `src/eval/`.
 */
import { materializeTargetView, type AnalysisView } from '../agent/targetView.js';

export type { AnalysisView };

export interface CreateAnalysisViewOptions {
  readonly fixtureRoot: string;
  /** Existing empty directory the view is materialised into. */
  readonly destination: string;
  /** Additional fixture-relative entries to withhold. */
  readonly additionalHostOnly?: readonly string[];
}

/**
 * Fixture entries that belong to the host and never to the evaluated model.
 * Relative to the fixture root, matched exactly.
 *
 * `test` is the oracle package: it demonstrates the defect and asserts the
 * expected authorization outcome, which is the answer in executable form.
 */
export const HOST_ONLY_FIXTURE_ENTRIES: readonly string[] = ['expected.json', 'test'];

/**
 * Materialise the model-visible portion of a fixture.
 *
 * Host-only entries are excluded at the fixture root, where they live, so the
 * exclusion is an explicit list a reviewer can check against the fixture layout
 * rather than a pattern applied at every depth.
 */
export function createAnalysisView(options: CreateAnalysisViewOptions): AnalysisView {
  return materializeTargetView({
    sourceRoot: options.fixtureRoot,
    destination: options.destination,
    hostOnlyEntries: [...HOST_ONLY_FIXTURE_ENTRIES, ...(options.additionalHostOnly ?? [])],
  });
}
