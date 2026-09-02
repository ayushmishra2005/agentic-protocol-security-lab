# Implementation Plan: Security Agent Loop (MVP)

**Branch**: `001-security-agent-loop` | **Date**: 2026-09-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-security-agent-loop/spec.md`

## Summary

Deliver a single Node.js CLI that runs a host-controlled, artifact-gated security analysis loop over
a local Daml package. The host owns the phase sequence and every side effect; the model is treated as
an untrusted planner that may only emit validated structured artifacts and validated parameters to a
small allowlisted tool library. The loop derives authorization/privacy invariants, generates
adversarial Daml Script tests, executes them with the real pinned toolchain, revises on contradiction
within a bounded budget, and emits an evidence-referenced report. A deterministic host scorer grades
runs against hand-written fixtures with human-written oracles.

## Technical Context

**Language/Version**: TypeScript on Node.js 22 LTS, pinned via `.nvmrc` and `engines` so the runtime
never depends on shell resolution order.

**Primary Dependencies**: `@anthropic-ai/sdk` (Messages API only), `zod` (validation), a CLI argument
parser, and a test runner. Deliberately minimal.

**Storage**: Run-scoped files on disk. No database.

**Testing**: Unit tests for host logic with mocked process boundaries, plus integration verification
against the real Daml toolchain. Per Constitution IX, mocks never substitute for fixture
verification.

**Target Platform**: Local developer machine, macOS/Linux. Offline.

**Project Type**: Single-project CLI.

**Performance Goals**: Not a throughput system. The operative budgets are per-run limits: maximum
model turns, maximum tool invocations, maximum revision attempts, and a per-process timeout. For
reference, a verified two-package build takes ~5s and a Script suite ~10s, so per-fixture wall time is
dominated by model latency rather than the toolchain.

**Constraints**: No network-capable tool is exposed to the model and no target repository can trigger
egress; the only outbound path is host-initiated model-provider inference traffic. No arbitrary shell. All filesystem access
confined to a resolved workspace root. Model writes confined to a run-scoped generated-test
directory. Secrets never enter prompts, artifacts, or logs.

**Scale/Scope**: Four fixtures, one adapter, ten model-facing phases plus a host-only evaluation
stage.

### Pinned toolchain

The MVP targets **Daml SDK 3.5.5 via `dpm`**. This is the ratified baseline, not an open question.
The `daml` Assistant front-end is not used.

| Component | Pinned version |
|---|---|
| Daml SDK | 3.5.5 |
| `dpm` | 1.0.21 |
| `damlc` | 3.5.2 |
| `daml-script` | 3.5.2 |
| `canton-open-source` | 3.5.12 |
| Java (toolchain runtime) | 21 |
| Node.js (control plane) | 22 LTS |

**Executable resolution**: `dpm` MUST be resolved by absolute path, configurable via `DPM_BIN`, and
its SDK version asserted at startup. Ambient `PATH` is not trusted, both because the installed
location is not on a default `PATH` and because Article II requires the spawned executable to be
pinned rather than discovered.

**Verified toolchain behavior** (established by direct execution; these are the properties the
architecture depends on):

- `dpm build --all` compiles a multi-package project offline.
- `dpm test` runs Daml Script suites; `dpm test --junit FILE` emits machine-readable JUnit XML with
  per-testcase `<failure>` elements.
- Exit code contract: `1` when any script fails, `0` when all pass.
- `dpm inspect-dar --json` yields structured package metadata.
- `dpm script` supports `--ide-ledger` (simulated ledger, so no Canton network is required) and
  `--list-scripts-json`.
- `submitMustFail` works as an adversarial primitive, verified including the negative case, where an
  expectation that wrongly predicts failure reports
  `Aborted: Expected submit to fail but it succeeded`. See the assertion rule under Fixtures for why
  it is not sufficient on its own.

**Evidence preference**: JUnit XML is the preferred machine-readable test evidence. Per Article III,
the scorer and tool wrappers consume structured XML and JSON, never scraped human-readable stdout.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Article | Gate | Status |
|---|---|---|
| I. Tools before prose | Report schema makes evidence references structurally required for confirmed findings; Markdown is rendered from JSON only | PASS |
| II. Allowlisted execution | Fixed executable paths, explicit argv allowlists, model supplies parameters only, path confinement enforced pre-spawn | PASS |
| III. Tests authoritative | Confirmation state gated on real compile/execute results; JUnit XML and exit codes are the signal | PASS |
| IV. Host-owned eval | Scorer, expectations, and oracles are host code and reviewed files; read-only to the model during a run | PASS |
| V. Untrusted inputs | Target text framed as data; no network-capable tool registered and no target-reachable egress, with host-initiated provider inference as the only outbound path; secret redaction before capture is persisted | PASS |
| VI. Adapter honesty | Scope fixed at language-level Daml semantics on a pinned toolchain; boundary statement required in output | PASS |
| VII. Simplicity | One process, one state machine, one adapter; prohibited technologies listed below and not introduced | PASS |
| VIII. Skills to authoritative sources | Toolchain surface derived from installed CLI help, not model memory; no third-party skill text copied | PASS |
| IX. Integration-first | Every fixture requires a human-written oracle executed on the pinned toolchain before it counts | PASS |

No violations. Complexity Tracking is therefore empty.

**Explicitly not introduced**: LangChain, LangGraph, CrewAI, AutoGen, any database, any frontend,
RAG, any vector database, cloud deployment, Kubernetes, arbitrary Bash, the provider's
code-execution tool, and the provider's web-search or web-fetch tools.

The analyzer also MUST NOT consume third-party MCP servers. Doing so would import an unreviewed tool
surface into a process whose entire security argument rests on an allowlist. This constraint applies
to the stretch MCP work as well, which is about *exposing* our own tools, never consuming others'.

## Project Structure

### Documentation (this feature)

```text
specs/001-security-agent-loop/
├── spec.md              # Feature specification
├── plan.md              # This file
└── tasks.md             # Task breakdown (/speckit-tasks output)
```

`research.md`, `data-model.md`, `contracts/`, and `quickstart.md` are not generated as separate
artifacts for this feature. Research conclusions and the verified toolchain baseline are recorded in
this plan, the data model is the Key Entities section of `spec.md`, and contracts are the schema
tasks below. Adding parallel documents that restate them would violate Article VII.

### Source Code (repository root)

```text
src/
├── cli/                  # analyze and eval entry points, argument parsing
├── agent/                # host-owned phase state machine, turn/tool budgets, revision control
├── model/                # Anthropic Messages API client, tool-call plumbing, usage accounting
├── tools/                # allowlisted deterministic tools exposed to the model
│   ├── repo/             # bounded file read, listing, search within workspace root
│   ├── git/              # bounded read-only version-control inspection
│   └── daml/             # dpm build / test / inspect-dar / script wrappers
├── security/             # path confinement, argv allowlist, process spawn, redaction
├── schemas/              # Zod schemas for phase artifacts, findings, report, expectations
├── evidence/             # append-only evidence store and evidence ID allocation
├── report/               # report.json assembly and report.md rendering
└── eval/                 # host-only deterministic scorer and fixture runner

fixtures/
└── f01-wrong-controller/ # main package, test package with oracle Script, expected.json
    ...                   # f02-observer-exposure, f03-missing-multiparty, f04-propose-accept-bypass

tests/
├── unit/                 # host logic with mocked process boundary
└── integration/          # real toolchain invocation

examples/
└── run-f01/              # checked-in redacted example run

runs/                     # git-ignored per-run output, including model-writable generated tests
```

**Structure Decision**: Single project. `src/security/` is deliberately separate from `src/tools/` so
that confinement and allowlisting are enforced in one reviewable place that every tool must pass
through, rather than being re-implemented per tool. `src/eval/` is host-only and never reachable from
model-facing code paths. `fixtures/` and `examples/` are committed; `runs/` is not.

### Architecture

**Trust model**: the host is trusted; the model, the target repository, and all generated code are
untrusted. The model never receives environment variables, credentials, or command strings.

**Phase state machine** (host-owned, fixed order, each phase gated on a schema-valid artifact):

```
understand → inspect → threat_model → invariants → auth_semantics →
scenarios → generate_tests → execute → revise → report
```

then, host-only and outside the model loop:

```
evaluate
```

The model cannot reorder, skip, or re-enter phases. `revise` is entered only by host decision, driven
by observed compilation or execution results, and is bounded by an explicit maximum. `evaluate` is
unreachable from any model-facing code path, satisfying Article IV.

**Tool library** (deterministic host functions; the model supplies validated parameters only):

| Group | Purpose | Backing |
|---|---|---|
| repo | bounded read, list, search inside workspace root | Node fs, size- and count-limited |
| git | bounded read-only change inspection | fixed read-only argv forms |
| daml | build, test, inspect archive, run script | `dpm` with fixed argv allowlist |

The Daml wrappers consume structured output — JUnit XML from `dpm test --junit`, JSON from
`dpm inspect-dar --json` and `dpm script --list-scripts-json` — rather than parsing human-readable
stdout, per Article III.

**Evidence**: every tool invocation produces an append-only record capturing argv, working directory,
exit code, and captured output, addressed by an evidence ID. Findings reference these IDs, and the
report schema makes a confirmed finding without resolvable references structurally invalid.

**Model interface**: the Messages API with tool use, driven by a host loop with explicit turn and
tool-call budgets and per-run usage accounting. Structured artifacts are validated with Zod on
receipt; invalid artifacts are rejected and retried within a fixed budget, after which the phase is
marked degraded rather than looping.

Four deliberate choices about the model runtime:

- **Messages API, not the Agent SDK.** The Agent SDK's value is its built-in file-write and Bash
  tools, which is precisely the capability Article II forbids a security agent analyzing untrusted
  repositories. Allowlisted functions are simpler to review than a permission layer over a shell.
- **A manual bounded loop, not the provider's managed tool-runner helper.** Every iteration must be
  logged as evidence, and the loop must be explainable in the README. A managed helper that hides
  iterations cannot satisfy Article I.
- **Schema-constrained outputs.** Phase artifacts are requested as JSON conforming to a JSON Schema,
  and tool definitions use strict schema validation. Host-side Zod validation still runs, because the
  host does not delegate its own gate to the provider. Exact SDK field names are read from the
  installed package types at implementation time rather than assumed.
- **Pinned model identifier**, overridable by environment variable and recorded on every run, so the
  model is a named dimension of any reported metric.

**Prompt construction boundary**: the static system prompt and tool definitions may be cached across
turns. Target repository source MUST NOT sit in a cached prefix — it is untrusted and differs per
target. Environment variables and credentials never enter any prompt.

**Source inspection**: there is no official Daml AST or authorization-linter CLI, and none is
invented here. A host-side extractor for templates, signatories, observers, controllers, and choices
is permitted, but MUST be labeled a heuristic wherever its output appears. The compiler and the
Script runner remain the authority, per Article III.

**Write boundary**: the only model-influenced writes are generated Daml Scripts into a run-scoped
directory. Fixture sources, `expected.json` files, oracle Scripts, and scorer code are read-only to
the model for the entire run.

**Scoring**: mechanical class and identifier matching against each fixture's `expected.json`, run by
host code with no model participation. Metrics per fixture: expected finding detected, expected
invariant generated, test generated, test compiled, expected behavior exposed, plus counts of
unsupported claims and false positives. A finding whose class is neither expected nor listed in an
explicit `allowed_extra_classes` set counts as a false positive; a conclusion with no evidence
references counts as an unsupported claim.

**Evaluation integrity**: two host-enforced rules make the score meaningful.

- A fixture's `expected.json` MUST NOT be placed in the prompt or made readable to the model during
  that fixture's run. The agent is scored on what it finds, not on what it was told to find.
- Each fixture is copied to a scratch workspace and analyzed there, so a run can never mutate the
  committed fixture sources.

### Fixtures

Each fixture is a multi-package Daml project in the layout verified against the pinned toolchain — a
model package plus a test package depending on `daml-script` via `data-dependencies`, with
`sdk-version: 3.5.5` — plus a hand-written oracle Script and an `expected.json`.

| ID | Vulnerability | Oracle demonstrates |
|---|---|---|
| F01 | Wrong controller on a choice | An unauthorized party successfully exercises a choice that should be refused |
| F02 | Unintended observer exposure | A party observes contract data it should not be able to see |
| F03 | Missing multi-party authorization | A single party effects a change that should require two authorities |
| F04 | Propose/accept workflow bypass | A state reachable without the counterparty's acceptance |

### Assertion rules for authorization fixtures

Verified against the pinned SDK's Daml Script API. These are correctness requirements, not style
preferences.

- **Assert the failure *kind*, not merely that a submission failed.** `submitMustFail` passes on any
  failure, including an `ensure` precondition violation or a runtime error unrelated to authority. An
  oracle that uses it alone can pass while proving nothing about authorization. Oracles for F01 and
  F03 MUST therefore assert a typed authorization failure, using `trySubmit` (returns
  `Either SubmitError a`) or `submitWithError` and matching the `AuthorizationError` constructor of
  `SubmitError`. `submitMustFail` remains acceptable only where the failure kind is separately
  pinned down.
- **Use the current multi-party submission form.** `submitMulti` and its relatives
  (`submitMultiMustFail`, `submitTreeMulti`, `trySubmitMulti`) are deprecated in this SDK. Multi-party
  submissions MUST be written as `submit (actAs [...] <> readAs [...]) cmds`, built from the
  `actAs`/`readAs` submit-option builders. Every submission must name at least one `actAs` party.

The underlying authorization semantics are unchanged from earlier Daml versions: create requires all
signatories, exercise requires all controllers, `Archive` is controlled by the signatories,
consequences are authorized by actors plus the signatories of the contract acted upon, authority does
not propagate transitively, and propose/accept works by the acceptor adding their authority inside
the accepting choice. F01–F04 remain valid as specified.

**F02 caveat**: using a Script query as a privacy oracle assumes the Script runner's projection
matches the ledger privacy model. F02's hand-written oracle MUST establish this behavior explicitly
before F02 is scored automatically; if the observed behavior differs, F02 is scored on the finding
and invariant only, and the discrepancy is recorded rather than worked around.

**F02 scope note**: this SDK adds explicit contract disclosure, an off-ledger mechanism that grants a
non-stakeholder read rights at submission time, surfaced in Script via the `disclose` submit-option
builder and enabled by default. It confers read access only and cannot grant authority, so it does
not affect F01, F03, or F04. F02's expectation MUST state whether it concerns template-level observer
exposure or disclosure-based read delegation, so the two are not conflated. A dedicated
disclosure-bypass fixture is a post-MVP candidate and is deliberately out of the F01–F04 scope.

## Complexity Tracking

No Constitution Check violations. This section is intentionally empty.
