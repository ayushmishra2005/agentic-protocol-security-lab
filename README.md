# agentic-protocol-security-lab

An AI-native, spec-driven security agent for Daml/Canton protocol code. Given a Daml project, it
derives a threat model and authorization invariants, writes adversarial Daml Scripts, compiles and
runs them on a pinned toolchain, revises when the results contradict its expectations, and produces a
report in which every confirmed conclusion points at a recorded tool invocation.

The point is that conclusions are traceable to executed tooling rather than to model narrative. If
the demonstration were `prompt → Markdown report`, it would have failed its own definition.

## What is true today

The pipeline is implemented and runs end to end. The evaluation harness is implemented and scores
four fixtures. **No live provider request has ever been made from this repository.**

Every model interaction so far has been a deterministic script standing in for a model. Those runs
demonstrate the machinery around the model — validated phases, real compilation, real execution,
evidence records, host-assembled reports, mechanical scoring — and demonstrate nothing about any
model's ability to find any vulnerability. Nothing here supports a claim that Claude found F01, that
a real model detected a vulnerability, or that this is an autonomous auditor or a production audit
tool.

You do not have to take that on trust. [`examples/run-f01/`](examples/run-f01/) is a complete run
checked in for reading without an API key: the report, its rendering, every tool invocation with its
exit code, and the generated Script that was compiled and executed.

## Trust model

The model is a participant in the loop, never its controller. Concretely:

- **The host owns the loop.** Turn and tool-call budgets, phase order, and revision decisions are all
  host state. The model cannot revise, cannot raise a budget, and cannot restate an expectation after
  seeing a result. The Anthropic Agent SDK is not used; the loop is a manual one over the Messages
  API, so each iteration is visible.
- **The model gets no general capability.** No shell, no file editor, no web fetch, no code
  execution, no network-capable tool of any kind is registered. It reads source through a small
  allowlisted set of deterministic tools under workspace path confinement, and its process boundary
  is argv-allowlisted with no shell.
- **The only model-influenced write** is a generated Daml Script into the run's own generated
  directory, through a write boundary that constructs the path itself.
- **Every tool invocation is evidence.** One dispatch function appends an append-only record with
  argv, working directory, exit code, and output digests, addressed by a host-allocated identifier.
  Refusals are recorded as refusals. Redaction runs before anything reaches disk.
- **Artifacts are gated, not trusted.** Each phase output must satisfy a Zod schema and may only cite
  evidence identifiers that resolve to real recorded invocations. A phase that exhausts its
  validation budget is marked degraded rather than retried forever.
- **Target text is untrusted data.** Source read from the analysed project is fenced as untrusted and
  never enters the trusted prompt prefix.
- **The report is host-assembled.** The model is never asked to summarise, to state a finding's
  status, or to describe what a run established. `report.json` is the single source of truth and
  `report.md` is a pure function of it, so the prose cannot contain a claim the structured record
  does not.
- **Confirmation is earned, not asserted.** A finding reaches `confirmed` only when its evidence
  resolves and its supporting Script compiled, ran, and produced the outcome it declared *before* it
  ran. Everything else is downgraded and kept visible.
- **The evaluation harness is unreachable from model code paths.** No module under `src/agent/`,
  `src/model/`, `src/tools/`, `src/evidence/`, `src/security/`, or `src/report/` may import from
  `src/eval/`, which is asserted structurally by a test over the import graph. The model never sees
  an expectation, never scores itself, and cannot write a scorecard.

The single permitted outbound network path is host-initiated inference against the configured
Anthropic endpoint. The credential is read from the environment by host code only: never passed as an
argument, never placed in a prompt, an evidence record, or a report.

## Requirements

Node 22 (see [`.nvmrc`](.nvmrc)) and **Daml SDK 3.5.5 via `dpm` 1.0.21**. Results are only claimed
for that pinned toolchain, and every report records it.

```bash
npm install
npx tsx src/cli.ts doctor    # verifies the pinned toolchain and the tool surface
```

## Reproducing the results

### Without an API key

Everything except live inference runs with no credential.

```bash
npm run check              # typecheck, lint, format check, unit tests
npm run test:integration   # real Daml toolchain: fixtures, oracles, pipeline, eval harness

npx tsx scripts/capture-example.ts   # re-capture examples/run-f01 and examples/scorecard.json
```

The capture is byte-reproducible: re-running it on the same commit leaves the working tree clean.

**Verifying the oracles independently.** Each fixture's oracle is host-owned and proves the defect on
the real toolchain without any model involvement. You can run one directly:

```bash
cd fixtures/f01-wrong-controller   # or f02-observer-exposure, f03-missing-multiparty, f04-propose-accept-bypass
dpm build --all
cd test && dpm test
```

A passing oracle means the vulnerable transition really succeeds on Daml 3.5.5 — and, where the
failure kind carries the meaning, that the party who should be refused is refused with a typed
`AuthorizationError`, so the result cannot be explained by authorization simply not being enforced.
Build output (`.daml/`, `*.dar`) is gitignored. `tests/integration/fixture-oracles.test.ts` runs the
same checks and additionally asserts that no fixture source is mutated.

### With an API key

```bash
export ANTHROPIC_API_KEY=...                        # host-read only; never an argument
npx tsx src/cli.ts analyze <path-to-daml-project>
npx tsx src/cli.ts eval
```

`analyze` writes `runs/<runId>/report.json` and `runs/<runId>/report.md`. `eval` analyses every
fixture through a scratch copy that withholds that fixture's expectation and oracle, then writes
`runs/scorecard.json`.

Analysing an ordinary project hides nothing from the model. Withholding a benchmark fixture's answer
is requested explicitly by the caller that evaluates it — there is no global ban on the filename
`expected.json`, which an ordinary project is free to contain.

## The fixture set

Four vulnerable Daml packages, each with a host-owned, independently reviewed oracle proving the
defect on the real toolchain, and an `expected.json` the evaluated model never sees.

| Fixture | Defect |
|---|---|
| `f01-wrong-controller` | A choice names the wrong controller, so a party can move an asset the owner never authorised |
| `f02-observer-exposure` | A template-level observer is disclosed contract data it has no business need to read |
| `f03-missing-multiparty` | A change requiring two authorities can be effected by one |
| `f04-propose-accept-bypass` | A settled state binding a counterparty is reachable without their acceptance |

F02 carries a probe establishing what its query results mean. A Daml Script `query` on this toolchain
is filtered by stakeholder: a party named nowhere on a contract sees nothing, and the same party sees
contracts that do name it. F02's exposure result can therefore be read as evidence about the declared
stakeholder set. That is the limit of the claim: it says nothing about what a Canton participant node
stores or transmits, and nothing about explicit contract disclosure.

## The current scorecard

[`examples/scorecard.json`](examples/scorecard.json) is the only scorecard this repository has ever
produced.

| | |
|---|---|
| Fixtures | `f01-wrong-controller`, `f02-observer-exposure`, `f03-missing-multiparty`, `f04-propose-accept-bypass` |
| Toolchain | Daml SDK 3.5.5, `dpm` 1.0.21 |
| Model identifier | `fake-model-for-tests` |
| Provenance | `harness_validation` |

**Read the model identifier before reading the scores.** They were produced by a scripted fake that
was told which template and choice to name and which exploit to write. The scorecard therefore shows
that the scorer computes the score it should when handed a report that deserves one, and shows
nothing about model performance. `provenance` is a required schema field precisely so this file
cannot later be quoted as a benchmark result; only a real provider run may carry `model_run`.

Scoring is mechanical: class and identifier matching against the fixture's expectation, with no
similarity measure and no model-judged grading. Six dimensions are scored per fixture — expected
finding detected, expected finding confirmed, expected invariant generated, test generated, test
compiled, expected behaviour exposed — alongside counts of unsupported claims and false positives. A
classification listed in a fixture's `allowedExtraClasses` is a defensible alternate reading and is
not counted against the run, but it cannot substitute for the expected finding either.

## Governance

This repository is specification-driven; the documents below are authoritative over the code.

| Artifact | Purpose |
|---|---|
| [`.specify/memory/constitution.md`](.specify/memory/constitution.md) | Ratified project constitution (v1.1.1) — the binding trust and evidence rules |
| [`specs/001-security-agent-loop/spec.md`](specs/001-security-agent-loop/spec.md) | What the MVP must do, and what it must be unable to do |
| [`specs/001-security-agent-loop/plan.md`](specs/001-security-agent-loop/plan.md) | Architecture, pinned Daml toolchain, and trust boundaries |
| [`specs/001-security-agent-loop/tasks.md`](specs/001-security-agent-loop/tasks.md) | Dependency-ordered implementation tasks |

## Capability boundary

This is an AI review and research prototype, **not a formal security audit**.

- It covers Daml language-level authorization and privacy semantics: signatories, observers,
  controllers, and choice structure.
- Results hold for the pinned toolchain recorded in each report, and were produced by compiling and
  running generated Scripts locally.
- It makes no claim about Canton network security. Sequencers, mediators, participant nodes, topology,
  and operational deployment are out of scope.
- It does not cover Daml Finance or any library beyond the analysed package source.
- No formal verification is performed. **Absence of a finding is not evidence of absence.**
- A generated Script that compiled, ran, and matched its pre-declared expectation is execution-backed
  evidence that one scenario was exercised. It is not proof that the invariant was encoded correctly,
  that other executions are safe, or that the package is secure.

## License

Apache-2.0. See [LICENSE](LICENSE).
