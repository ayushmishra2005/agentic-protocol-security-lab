---
description: "Task list for 001-security-agent-loop (MVP)"
---

# Tasks: Security Agent Loop (MVP)

**Input**: Design documents from `/specs/001-security-agent-loop/`

**Prerequisites**: [plan.md](./plan.md) (required, and the record of the pinned toolchain),
[spec.md](./spec.md) (required for user stories), `.specify/memory/constitution.md` (governing
articles)

**Tests**: Test tasks ARE included. The specification requires them: Article IX mandates a real
oracle run per fixture, and Article II's confinement guarantees are only credible if negatively
tested.

**Organization**: Tasks are grouped into phases that preserve the public proof sequence. Ordering is
deliberate — security primitives precede the tool library, and F01's host-owned oracle is verified
against the real toolchain *before* any model code exists, so that the fixture is proven independently
of the agent.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 (evidence-backed analysis), US2 (scored evaluation), US3 (reviewable run record)
- Exact file paths are given in each task

## Path Conventions

Single project. `src/`, `tests/`, `fixtures/`, `examples/` at repository root, per plan.md.

---

## Phase 1: Foundation — Constitution & Spec

**Purpose**: Governance and specification exist and agree with each other.

- [x] T001 Ratify constitution in `.specify/memory/constitution.md` (v1.0.0, nine articles)
- [x] T002 Write feature specification in `specs/001-security-agent-loop/spec.md`
- [x] T003 Write implementation plan in `specs/001-security-agent-loop/plan.md`, including the pinned toolchain and verified tool behavior
- [x] T004 Write this task breakdown in `specs/001-security-agent-loop/tasks.md`

**Checkpoint**: Governance is ratified, and the plan records the pinned toolchain as the single
source of truth for the Daml surface.

---

## Phase 2: Project & Tooling Skeleton

**Purpose**: A runnable, type-checked, lint-clean project with no product logic yet.

- [x] T005 Initialize `package.json` with TypeScript, Zod, `@anthropic-ai/sdk`, a CLI parser, and a test runner; set `engines` to Node 22
- [x] T006 [P] Pin the Node version in `.nvmrc`
- [x] T007 [P] Configure TypeScript in `tsconfig.json` with strict mode enabled
- [x] T008 [P] Configure linting and formatting
- [x] T009 [P] Add `.gitignore` covering `runs/`, `node_modules/`, `.env`, and `**/.daml/`
- [x] T010 [P] Add `.env.example` documenting the API key variable name with a placeholder value only, never a real credential
- [x] T011 Create the directory skeleton under `src/` per plan.md with placeholder module entry points
- [x] T012 Add `src/config.ts` resolving the pinned `dpm` executable by absolute path (not ambient PATH) with a `DPM_BIN` override, asserting SDK 3.5.5 at startup, and pinning the model identifier with an environment override
- [x] T013 Add a CI workflow running install, type-check, lint, and unit tests

**Checkpoint**: `npm run build` and `npm test` pass on an empty project.

---

## Phase 3: Schemas & Security Primitives (Blocking Prerequisites)

**Purpose**: The Article II and Article I guarantees, implemented and tested before anything can call
a tool. Nothing downstream may bypass these modules.

**CRITICAL**: No tool, model, or agent work may begin until this phase is complete.

- [x] T014 [P] Define phase artifact schemas in `src/schemas/phases.ts` (one Zod schema per phase in the fixed sequence)
- [x] T015 [P] Define finding, invariant, and evidence-reference schemas in `src/schemas/findings.ts`, making evidence references structurally required for any finding whose state is confirmed
- [x] T016 [P] Define the report schema in `src/schemas/report.ts`
- [x] T017 [P] Define the fixture expectation schema in `src/schemas/expected.ts`, including an explicit `allowed_extra_classes` set used to distinguish false positives
- [x] T018 Implement path confinement in `src/security/paths.ts`: resolve, follow symlinks, and reject any path escaping the workspace root
- [x] T019 Implement the argv allowlist and process spawn in `src/security/exec.ts`: fixed executable paths, explicit permitted flags, timeouts, output size caps, no shell interpolation
- [x] T020 Implement secret redaction in `src/security/redact.ts`, applied to all captured output before it is persisted or returned to the model
- [x] T021 [P] Unit-test path confinement in `tests/unit/paths.test.ts` — negative cases: `..` traversal, absolute escape, symlink escape
- [x] T022 [P] Unit-test the allowlist in `tests/unit/exec.test.ts` — negative cases: unlisted executable, unlisted flag, injected shell metacharacters, timeout enforcement
- [x] T023 [P] Unit-test that a confirmed finding without evidence references fails schema validation, in `tests/unit/schemas.test.ts`

**Checkpoint**: Confinement and allowlisting are enforced and negatively tested. Article II holds.

---

## Phase 4: Allowlisted Tool Library

**Purpose**: The deterministic tools the model may call, each routed through Phase 3 primitives.

- [x] T024 [P] Implement bounded repository reads in `src/tools/repo/read.ts` with size and count limits
- [x] T025 [P] Implement bounded listing and search in `src/tools/repo/list.ts`
- [x] T026 [P] Implement bounded read-only version-control inspection in `src/tools/git/inspect.ts` using fixed argv forms
- [x] T027 Implement `dpm build` wrapper in `src/tools/daml/build.ts`, capturing exit code and diagnostics
- [x] T028 Implement `dpm test` wrapper in `src/tools/daml/test.ts` using `--junit` and parsing the JUnit XML, not human stdout
- [x] T029 [P] Implement `dpm inspect-dar --json` wrapper in `src/tools/daml/inspect.ts`
- [x] T030 [P] Implement `dpm script` wrapper in `src/tools/daml/script.ts` using `--ide-ledger` and `--list-scripts-json`
- [x] T031 Define the model-facing tool registry in `src/tools/registry.ts`, exposing parameter schemas only — never command strings — registering no network-capable tool and no third-party MCP tool
- [x] T032 [P] Unit-test JUnit XML parsing in `tests/unit/junit.test.ts`, covering pass, failure, and malformed input

**Checkpoint**: Every tool the model can reach is deterministic, bounded, and structured-output based.

---

## Phase 5: F01 Fixture & Oracle — Proof Before Agent (US1)

**Purpose**: Prove the vulnerability is real using the actual toolchain, with no model involved. Per
Article IX this must precede agent work, so a later passing score cannot be an artifact of the
fixture and the agent sharing a misconception.

- [x] T033 [US1] Create the F01 vulnerable package in `fixtures/f01-wrong-controller/main/` — a template whose choice names the wrong controlling party
- [x] T034 [US1] Create the F01 test package in `fixtures/f01-wrong-controller/test/` with `daml-script` as a dependency and a `data-dependencies` reference to the main package DAR
- [x] T035 [US1] Add `fixtures/f01-wrong-controller/multi-package.yaml` pinning `sdk-version: 3.5.5`
- [x] T036 [US1] Write the host-owned, independently reviewed oracle Script in `fixtures/f01-wrong-controller/test/daml/Oracle.daml`, demonstrating that an unauthorized party can exercise the choice, and asserting the typed `AuthorizationError` case of `SubmitError` via `trySubmit`/`submitWithError` rather than relying on bare `submitMustFail`
- [x] T037 [US1] Declare F01 expectations in `fixtures/f01-wrong-controller/expected.json`
- [x] T038 [US1] Verify F01 against the real toolchain: `dpm build --all` succeeds and the oracle runs with its documented outcome; record the observed output
- [x] T039 [US1] Add an integration test in `tests/integration/f01-oracle.test.ts` that builds and runs the F01 oracle and asserts the recorded outcome

**Checkpoint**: F01 is a proven vulnerability with a reproducible oracle, independent of any model.

---

## Phase 6: Evidence Store (US1)

**Purpose**: Article I's substrate — the thing evidence IDs resolve to.

- [x] T040 [US1] Implement the append-only evidence store in `src/evidence/store.ts`, recording argv, working directory, exit code, and captured output per invocation
- [x] T041 [US1] Implement evidence ID allocation and resolution in `src/evidence/ids.ts`
- [x] T042 [US1] Route every tool in `src/tools/` through the evidence store so no invocation can occur unrecorded, via the single `src/tools/dispatch.ts` entry point
- [x] T043 [US1] Unit-test in `tests/unit/evidence.test.ts` that records are append-only, that IDs resolve, and that redaction is applied before persistence

**Checkpoint**: Every tool invocation is recorded and addressable.

---

## Phase 7: Model Client & Bounded Loop (US1)

**Purpose**: Connect the untrusted model under host-enforced budgets.

- [x] T044 [US1] Implement the model client in `src/model/client.ts` over the Messages API, reading the SDK's installed types for the current structured-output and strict-tool field names rather than assuming them, with retry and with no environment variables or secrets in any prompt
- [x] T045 [US1] Implement tool-call plumbing in `src/model/tools.ts`, validating every model-supplied parameter set against its schema before dispatch and rejecting unlisted tools
- [x] T046 [US1] Implement per-run usage accounting in `src/model/usage.ts`, recording input, output, and cache token counts plus tool invocation counts
- [x] T047 [US1] Implement the bounded model/tool loop in `src/agent/loop.ts` with explicit maximum turns and maximum tool calls. Tool calls are recorded as evidence through the Phase 6 dispatch path; model turns are recorded in a host-owned `LoopTranscript` rather than forced into the tool-invocation evidence schema, which has no honest values for argv, exit code, or output digest when nothing was executed
- [x] T048 [US1] Implement the host-owned phase state machine in `src/agent/phases.ts`, enforcing the fixed order and gating each transition on a schema-valid artifact, with the model unable to reorder, skip, or re-enter phases
- [x] T049 [US1] Implement artifact validation with a bounded retry budget in `src/agent/validate.ts`, marking a phase degraded rather than looping when the budget is exhausted
- [x] T050 [US1] Unit-test in `tests/unit/loop.test.ts`, with the provider mocked by a deterministic fake `ModelClient` and no live request, that budgets terminate the loop and that invalid artifacts do not advance a phase

**Checkpoint**: A bounded, host-controlled loop runs with the model as an untrusted participant.

---

## Phase 8: Analysis Phase Artifacts (US1)

**Purpose**: The first six phases produce real, validated artifacts.

- [x] T051 [US1] Implement `understand` and `inspect` phases in `src/agent/steps/understand.ts`, driving repository and version-control tools
- [x] T052 [US1] Implement `threat_model` in `src/agent/steps/threatModel.ts`
- [x] T053 [US1] Implement `invariants` in `src/agent/steps/invariants.ts`, emitting invariants concrete enough for a test to target
- [x] T054 [US1] Implement `auth_semantics` in `src/agent/steps/authSemantics.ts`, examining signatories, observers, controllers, and choice structure
- [x] T055 [US1] Implement `scenarios` in `src/agent/steps/scenarios.ts`, enumerating candidate misuse scenarios
- [x] T056 [US1] Implement prompt construction in `src/agent/prompt.ts`: frame all target-derived text as untrusted data, and keep target source out of any cached prefix so that no target content can alter host policy, phase order, or the allowlist
- [x] T057 [US1] If a host-side template/signatory/observer/controller extractor is implemented in `src/tools/daml/extract.ts`, label its output as a heuristic wherever it appears, and never as authoritative parsing — N/A: no host-side Daml extractor is implemented in the MVP, so the conditional capability was never introduced. `auth_semantics` entries carry `heuristic: true` because they are model-read source, not parsed structure.
- [x] T058 [US1] Add an injection-resistance test in `tests/unit/injection.test.ts`: a fixture source containing instruction-like text must not change host behavior

**Checkpoint**: Analysis produces validated artifacts and resists target-supplied instructions.

---

## Phase 9: Test Generation, Execution & Revision (US1)

**Purpose**: The part that makes this agentic rather than descriptive — generated tests actually run,
and results feed back.

- [x] T059 [US1] Implement the run-scoped write boundary in `src/agent/writeBoundary.ts`: the only model-influenced writes are generated Scripts into the run directory, with fixture sources, `expected.json`, oracles, and scorer code read-only for the whole run
- [x] T060 [US1] Unit-test in `tests/unit/writeBoundary.test.ts` that attempts to write to a fixture, an expectation file, an oracle, or the scorer are refused and recorded
- [x] T061 [US1] Implement `generate_tests` in `src/agent/steps/generateTests.ts`, writing adversarial Daml Scripts through the write boundary, and instructing the model to use the current Script API — typed `SubmitError` matching and `actAs`/`readAs` submit options — rather than the deprecated `submitMulti` family
- [x] T062 [US1] Implement `execute` in `src/agent/steps/execute.ts`, compiling and running generated tests via the Daml tools and recording results as evidence
- [x] T063 [US1] Ensure compilation failures and execution failures are both observable to the workflow and distinguishable from each other
- [x] T064 [US1] Implement bounded `revise` in `src/agent/steps/revise.ts`, entered by host decision on compilation failure or on execution results contradicting stated expectations, with an explicit maximum attempt count
- [x] T065 [US1] Enforce that a conclusion whose supporting test never compiled cannot reach confirmed state
- [x] T066 [US1] Integration-test the generate/execute/revise cycle in `tests/integration/revise.test.ts` against the real toolchain, asserting that a non-compiling generated test triggers exactly one bounded revision

**Checkpoint**: Generated tests run for real, failures are observed, and revision is bounded.

---

## Phase 10: Reporting (US1)

**Purpose**: Article I's output contract.

- [X] T067 [US1] Implement `report` phase assembly in `src/report/build.ts`, producing schema-valid `report.json`
- [X] T068 [US1] Implement Markdown rendering in `src/report/render.ts`, deriving `report.md` solely from `report.json` and introducing no claims absent from it
- [X] T069 [US1] Include the run's toolchain version, model identifier, token usage, and tool invocation counts in the report
- [X] T070 [US1] Include the explicit "AI review and research prototype, not a formal security audit" boundary statement in both outputs
- [X] T071 [US1] Implement the `analyze <path>` CLI command in `src/cli/analyze.ts`
- [X] T072 [US1] Test in `tests/unit/report.test.ts` that a confirmed finding lacking resolvable evidence cannot be emitted, and that Markdown introduces no claim absent from the JSON

**Checkpoint**: User Story 1 is complete and independently demonstrable on F01. Proven by
`tests/integration/analyze.test.ts`, which runs the whole pipeline over the F01 fixture with a fake
model client and the real pinned toolchain. That test is additional to the numbered tasks.

---

## Phase 11: Remaining Fixtures & Oracles (US2)

**Purpose**: Broaden the scored surface. Each fixture repeats the Phase 5 discipline: oracle proven
before scoring depends on it.

- [ ] T073 [P] [US2] Create the F02 observer-exposure fixture, oracle, and `expected.json` in `fixtures/f02-observer-exposure/`, with the expectation stating explicitly whether it concerns template-level observer exposure or disclosure-based read delegation
- [ ] T074 [P] [US2] Create the F03 missing-multi-party-authorization fixture, oracle, and `expected.json` in `fixtures/f03-missing-multiparty/`, writing multi-party submissions as `submit (actAs [...] <> readAs [...])` and asserting the typed `AuthorizationError` case
- [ ] T075 [P] [US2] Create the F04 propose/accept-bypass fixture, oracle, and `expected.json` in `fixtures/f04-propose-accept-bypass/`
- [ ] T076 [US2] Verify all three oracles against the real toolchain and record their observed outcomes
- [ ] T077 [US2] For F02 specifically, establish and record whether a Script query reflects the ledger privacy model; if it does not, score F02 on finding and invariant only and record the discrepancy rather than working around it
- [ ] T078 [US2] Extend `tests/integration/` with oracle tests for F02, F03, and F04

**Checkpoint**: Four proven fixtures with reproducible oracles.

---

## Phase 12: Deterministic Scorer & Evaluation (US2)

**Purpose**: Article IV. Host-owned, mechanical, unreachable from model code paths.

- [ ] T079 [US2] Implement the deterministic scorer in `src/eval/scorer.ts` using mechanical class and identifier matching against `expected.json`, with no similarity scoring and no model-judged grading
- [ ] T080 [US2] Implement metrics in `src/eval/metrics.ts`: expected finding detected, expected invariant generated, test generated, test compiled, expected behavior exposed, unsupported claim count, false positive count
- [ ] T081 [US2] Implement the fixture runner in `src/eval/runner.ts`, copying each fixture to a scratch workspace and analyzing the copy so a run can never mutate committed fixture sources
- [ ] T082 [US2] Enforce and test that a fixture's `expected.json` is never placed in the prompt or made readable to the model during that fixture's run, in `tests/unit/expectationIsolation.test.ts`
- [ ] T083 [US2] Emit `scorecard.json` written exclusively by host code, recording the fixture set, toolchain version, and model identifier
- [ ] T084 [US2] Implement the `eval` CLI command in `src/cli/eval.ts`
- [ ] T085 [US2] Add an architectural test in `tests/unit/evalIsolation.test.ts` asserting that no model-facing code path can reach `src/eval/`, and that the model cannot produce or modify the scorecard
- [ ] T086 [US2] Unit-test scorer determinism in `tests/unit/scorer.test.ts`: identical inputs yield identical scorecards, and unsupported claims are counted correctly
- [ ] T087 [US2] Run full evaluation across F01–F04 and record the resulting scorecard

**Checkpoint**: User Story 2 is complete. Results are measurable and host-owned.

---

## Phase 13: Public Reviewability (US3)

**Purpose**: An outsider without credentials can judge whether the conclusions are earned.

- [ ] T088 [US3] Capture a complete redacted example run into `examples/run-f01/`, including tool invocation records with exit codes, the generated Scripts, and the report
- [ ] T089 [US3] Verify the checked-in example contains no credential material
- [ ] T090 [US3] Rewrite `README.md` for the shipped MVP: purpose, trust model, exact reproduction commands for `analyze` and `eval`, the pinned toolchain version, and the honest capability boundary
- [ ] T091 [US3] Document how to verify oracles without an API key, so reviewers can confirm the fixtures independently of the model
- [ ] T092 [US3] Document the current scorecard alongside the fixture set, toolchain version, and model identifier that produced it

**Checkpoint**: User Story 3 is complete. The repository is publicly defensible.

---

## Phase 14: Convergence & Polish

**Purpose**: Close drift between specification and implementation.

- [ ] T093 Run `/speckit-analyze` to detect inconsistencies across constitution, spec, plan, and tasks
- [ ] T094 Run `/speckit-converge` and record any residual drift as explicit follow-up tasks rather than leaving it implicit
- [ ] T095 Re-verify the Constitution Check in `plan.md` against the delivered implementation and update it if design shifted

---

## Phase 15: Stretch — NOT part of the scored MVP

**Purpose**: Optional extension. **These tasks MUST NOT block the scored MVP** and must not be
started before Phase 13 is complete.

- [ ] T096 [STRETCH] Expose the deterministic tool library over MCP, preserving the same allowlist and confinement guarantees; this exposes our own tools only and never consumes third-party MCP servers
- [ ] T097 [STRETCH] Package the analysis procedures as agent skills that direct an agent to authoritative sources, written from scratch with no third-party skill text copied, per Article VIII

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Foundation)**: complete
- **Phase 2 (Skeleton)**: depends on Phase 1
- **Phase 3 (Schemas & Security)**: depends on Phase 2 — **BLOCKS everything downstream**
- **Phase 4 (Tools)**: depends on Phase 3
- **Phase 5 (F01 + oracle)**: depends on Phase 2 for the toolchain pin only; deliberately independent of all model code
- **Phase 6 (Evidence)**: depends on Phase 4
- **Phase 7 (Model & loop)**: depends on Phase 6
- **Phase 8 (Analysis artifacts)**: depends on Phase 7
- **Phase 9 (Generate/execute/revise)**: depends on Phase 8 and Phase 5
- **Phase 10 (Reporting)**: depends on Phase 9 — completes US1
- **Phase 11 (F02–F04)**: depends on Phase 5's established pattern; can proceed in parallel with Phases 6–10
- **Phase 12 (Scorer & eval)**: depends on Phase 10 and Phase 11 — completes US2
- **Phase 13 (Reviewability)**: depends on Phase 12 — completes US3
- **Phase 14 (Convergence)**: depends on Phase 13
- **Phase 15 (Stretch)**: depends on Phase 13; never blocking

### User Story Dependencies

- **US1 (P1)**: Phases 5–10. The MVP slice; independently demonstrable on F01 alone.
- **US2 (P2)**: Phases 11–12. Requires US1 to produce reports.
- **US3 (P3)**: Phase 13. Packages US1 and US2 for outside review.

### Critical Ordering Constraints

1. Security primitives (Phase 3) precede every tool and every model call. No exceptions.
2. F01's oracle is verified (T038) before any agent code can be scored against it.
3. The evidence store (Phase 6) precedes the model loop, so no invocation can occur unrecorded.
4. The write boundary (T059) precedes generated-test writing (T061).
5. Scoring (Phase 12) is implemented only after the write boundary and isolation tests exist.

### Parallel Opportunities

- T006–T010 (project configuration) run in parallel.
- T014–T017 (schemas) run in parallel; T021–T023 (security unit tests) run in parallel.
- T024–T026 (repo and git tools) run in parallel; T029–T030 run in parallel.
- T073–T075 (F02–F04 fixtures) run in parallel with each other and with Phases 6–10.

---

## Implementation Strategy

### MVP First

1. Phases 1–4: governance, skeleton, security primitives, tools.
2. Phase 5: prove F01 with a host-owned oracle, before any model code.
3. Phases 6–10: evidence, loop, analysis, generation/execution/revision, reporting.
4. **STOP and VALIDATE**: run `analyze` against F01 end to end. Confirm every confirmed finding
   resolves to evidence and that at least one generated Script compiled and executed.

### Incremental Delivery

1. US1 on F01 alone is a demonstrable product.
2. Add F02–F04 and the scorer to make the claim measurable.
3. Add the example run and README to make it publicly reviewable.
4. Consider stretch tasks only after all of the above.

---

## Notes

- Task count: **97** total — **95** in the scored MVP (T001–T095), plus **2** stretch tasks.
- Completed: T001–T004.
- `[P]` marks tasks touching different files with no ordering dependency.
- Every fixture requires a host-owned, independently reviewed oracle, beyond the evaluated model's reach, before it may be scored (Article IX).
- MCP is a stretch goal only and must never block the scored MVP.
- No task in this list authorizes committing, pushing, or branching; version-control actions remain a
  human decision.
