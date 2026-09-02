# Feature Specification: Security Agent Loop (MVP)

**Feature Branch**: `001-security-agent-loop`

**Created**: 2026-09-02

**Status**: Draft

**Input**: Phase 1 MVP scope for an evidence-backed Daml security analysis loop.

> **Branch note**: no git branch was created for this feature. Phase 1 operates under an explicit
> instruction that no git write operations occur. The directory name carries the feature ID instead.

## User Scenarios & Testing *(mandatory)*

**Primary user**: a protocol/security engineer analyzing a local Daml project.

### User Story 1 - Evidence-backed analysis of a local Daml project (Priority: P1)

The engineer points the CLI at a local Daml project or fixture. The system reads the repository and
its recent changes, examines authorization and privacy semantics (templates, signatories, observers,
controllers, choices, propose/accept flows, lifecycle transitions), derives explicit security
invariants, writes adversarial Daml Script tests, actually executes them with the pinned Daml
toolchain, revises when results contradict its expectations, and produces a report in which every
confirmed conclusion points at a recorded tool result.

**Why this priority**: This is the product. Without it there is nothing to score, and the project's
central claim — that conclusions are tied to executed tooling rather than model narrative — is
unproven.

**Independent Test**: Run the analyze command against a single known-vulnerable fixture. The run is
successful if a report is produced, every confirmed finding resolves to a recorded tool invocation,
and at least one generated Daml Script was compiled and executed by the real toolchain.

**Acceptance Scenarios**:

1. **Given** a Daml project whose choice is controlled by the wrong party, **When** the engineer runs
   analysis, **Then** the report contains a finding of the corresponding class, that finding cites at
   least one evidence ID, and each cited ID resolves to a stored invocation record.
2. **Given** a generated adversarial test that fails to compile, **When** the toolchain reports the
   compilation error, **Then** the system records the failure as evidence and enters a bounded
   revision rather than reporting the associated conclusion as confirmed.
3. **Given** an analysis in which the model asserts a behavior that execution contradicts, **When**
   the run completes, **Then** the contradiction is recorded and the conclusion is not presented as
   confirmed.
4. **Given** any completed run, **When** the report is inspected, **Then** no confirmed finding lacks
   evidence references satisfying the report schema.

---

### User Story 2 - Scored evaluation against known fixtures (Priority: P2)

The engineer runs the evaluation command. The system analyzes each checked-in vulnerable fixture and
a deterministic host scorer compares the results against each fixture's declared expectations,
producing a machine-readable scorecard.

**Why this priority**: Turns a demo into a measurable claim. It is second only because it depends on
Story 1 producing reports at all, but it is what makes the reported numbers defensible.

**Independent Test**: Run the evaluation command across the fixture set and confirm a scorecard is
produced containing per-fixture boolean and count outcomes, and that the scorecard was written by
host code with no model participation.

**Acceptance Scenarios**:

1. **Given** a fixture with a declared expected finding, **When** evaluation runs, **Then** the
   scorecard records whether a finding of that class was detected, by mechanical class matching.
2. **Given** an analysis that emitted a conclusion with no evidence references, **When** scoring
   runs, **Then** that conclusion is counted as an unsupported claim.
3. **Given** an evaluation run in progress, **When** the model attempts to write the scorecard or a
   fixture expectation file, **Then** the write is refused and the attempt is recorded.
4. **Given** a completed evaluation, **When** results are reported, **Then** they name the fixture
   set, the toolchain version, and the model identifier used.

---

### User Story 3 - Reviewable, reproducible run record (Priority: P3)

A reviewer who did not run the tool can open the repository, read a checked-in example run, and see
the tool invocations, their exit codes, the generated tests, and the resulting report — enough to
judge whether the conclusions are earned.

**Why this priority**: The public credibility of the project depends on an outsider being able to
verify the loop without credentials. It ranks third only because it packages Stories 1 and 2.

**Independent Test**: With no API key present, a reviewer inspects the checked-in example run and the
documented commands, and can trace at least one report conclusion to a recorded tool invocation.

**Acceptance Scenarios**:

1. **Given** the repository, **When** a reviewer opens the checked-in example run, **Then** it
   contains tool invocation records including exit codes, the generated Daml Script, and the report.
2. **Given** the checked-in example run, **When** it is inspected for secrets, **Then** no credential
   material is present.
3. **Given** the documentation, **When** a reviewer follows it, **Then** the commands to reproduce
   both analysis and evaluation are stated explicitly.

---

### Edge Cases

- **Target is not a Daml project** (no package manifest): the system reports the condition and exits
  without fabricating findings.
- **Target is not a git repository, or has no diff**: change inspection degrades to whole-source
  analysis and records that no diff was available.
- **Pinned toolchain missing or version mismatch**: the run refuses to start rather than silently
  analyzing with an unverified toolchain.
- **Generated test never compiles within the revision budget**: affected conclusions remain
  unconfirmed and the run completes with that state recorded.
- **Generated test compiles and passes but does not encode the intended property**: reported as
  best-effort; the system does not claim the property was proven.
- **Repository content contains text resembling instructions to the agent**: treated as data; host
  policy, allowlist, phase order, and scoring are unaffected.
- **Model requests an unlisted tool, flag, or a path outside the workspace**: refused before
  execution and recorded.
- **Model emits a malformed phase artifact**: rejected by validation; after the retry budget the
  phase is marked degraded rather than looping indefinitely.
- **Analysis exceeds its turn budget**: the run terminates with partial artifacts clearly marked
  incomplete.

## Requirements *(mandatory)*

### Functional Requirements

**Commands**

- **FR-001**: The system MUST provide an `analyze <path>` command that analyzes a local Daml project
  or fixture at the given path.
- **FR-002**: The system MUST provide an `eval` command that runs analysis across the checked-in
  fixture set and produces a scorecard.

**Inspection**

- **FR-003**: The system MUST read repository files only within a configured workspace root, subject
  to explicit size limits.
- **FR-004**: The system MUST inspect version-control state and changes through a bounded, read-only
  set of operations.
- **FR-005**: The system MUST invoke the official pinned Daml toolchain for building, testing, and
  archive inspection, and MUST NOT rely on unofficial or invented Daml tooling.

**Analysis loop**

- **FR-006**: The system MUST execute explicit, ordered security-analysis phases, with phase
  progression controlled by the host rather than chosen by the model.
- **FR-007**: The system MUST attach evidence identifiers to supported conclusions, each resolving to
  a recorded tool invocation.
- **FR-008**: The system MUST generate adversarial Daml Script tests targeting the derived
  invariants.
- **FR-009**: The system MUST actually execute generated tests using the pinned toolchain and record
  the results.
- **FR-010**: The system MUST support a bounded revision loop triggered by compilation failures or by
  execution results that contradict stated expectations, with an explicit maximum.

**Outputs**

- **FR-011**: The system MUST produce a structured `report.json` conforming to a published schema.
- **FR-012**: The system MUST produce a human-readable `report.md` rendered from that structured
  report and introducing no claims absent from it.
- **FR-013**: Each fixture MUST declare its expectations in an `expected.json` file that is the sole
  source of truth for scoring that fixture.
- **FR-014**: The system MUST include a deterministic host scorer that compares reports against
  fixture expectations by mechanical class and identifier matching.
- **FR-015**: The system MUST produce a `scorecard.json` written exclusively by host code.
- **FR-016**: The system MUST record per-run token usage and tool invocation counts as part of the
  run evidence.

**Fixtures and packaging**

- **FR-017**: The system MUST include four vulnerable fixtures covering wrong controller
  authorization, unintended observer exposure, missing multi-party authorization, and propose/accept
  workflow bypass.
- **FR-018**: Each fixture MUST include a human-written oracle Script that demonstrates the intended
  behavior on the pinned toolchain independently of the agent.
- **FR-019**: The repository MUST contain a checked-in, redacted example run showing tool
  invocations, generated tests, and the resulting report.
- **FR-020**: All published output MUST carry an explicit boundary statement identifying the system
  as an AI review and research prototype, not a formal security audit.

**Prohibitions (acceptance behavior)**

- **FR-021**: A report MUST NOT be able to present a confirmed security finding without evidence
  references satisfying the report schema.
- **FR-022**: The model MUST NOT produce or modify `scorecard.json`.
- **FR-023**: The model MUST NOT modify any fixture `expected.json` or oracle definition.
- **FR-024**: The model MUST NOT execute arbitrary shell commands; only allowlisted executables with
  validated parameters are available to it.
- **FR-025**: Generated test failures MUST be observable by the workflow and recorded as evidence.
- **FR-026**: Compilation and test failures MUST be capable of triggering a bounded revision.
- **FR-027**: The system MUST NOT expose any network-capable tool to the model. No URL-fetch,
  arbitrary HTTP, browser, web-search, web-fetch, or network-capable MCP capability may be
  registered, and analysing a target repository MUST NOT be able to trigger network access. The
  deterministic repository, version-control, and Daml tools MUST operate entirely locally.
- **FR-028**: Secrets MUST NOT appear in prompts, artifacts, logs, or committed evidence.
- **FR-029**: The only permitted runtime outbound network path is host-owned communication with the
  explicitly configured model provider endpoint, for inference only. Such requests MUST be initiated
  solely by trusted host model-client code; target-controlled or model-controlled content MUST NOT
  determine the destination host, URL, protocol, method, headers, or credentials; and provider
  credentials MUST NOT appear in model-visible content, tool evidence, reports, or any
  target-controlled execution. This exception authorises no other network access.

### Key Entities

- **Run**: one invocation of analysis against one target. Owns a run identifier, the resolved
  toolchain version, the model identifier, phase artifacts, evidence records, generated tests, and
  the report.
- **Phase Artifact**: the validated structured output of one analysis phase, the input to the next.
- **Evidence Record**: an immutable record of a single tool invocation — what was run, where, its
  exit status, and its captured output — addressed by an evidence identifier.
- **Finding**: a security conclusion with a class, the Daml construct it concerns, a confirmation
  state, and its evidence references.
- **Invariant**: an explicit security property expected to hold, expressed so it can be targeted by a
  generated test.
- **Generated Test**: an agent-authored Daml Script written into run-scoped output, plus its
  compilation and execution results.
- **Fixture**: a checked-in vulnerable Daml package with declared expectations and a human-written
  oracle.
- **Expectation Set**: the declared expected findings, invariants, and test outcomes for a fixture.
- **Scorecard**: the host-produced evaluation result across the fixture set.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every fixture, analysis completes and produces both a structured and a
  human-readable report.
- **SC-002**: Every confirmed finding across all fixture runs resolves to at least one stored
  evidence record; the count of confirmed findings lacking evidence is zero.
- **SC-003**: For every fixture, at least one agent-generated Daml Script is compiled and executed by
  the pinned toolchain, and its result is recorded.
- **SC-004**: The evaluation command produces a scorecard reporting, per fixture, whether the
  expected finding was detected, whether the expected invariant was generated, whether a test was
  generated, whether it compiled, whether it exposed the expected behavior, plus counts of
  unsupported claims and false positives.
- **SC-005**: Every fixture's human-written oracle executes on the pinned toolchain with its recorded
  intended outcome.
- **SC-006**: An attempt by the model to write outside its permitted output directory, to use an
  unlisted executable or flag, or to modify expectations or the scorer is refused and recorded, with
  zero successful such writes.
- **SC-007**: A reviewer without an API key can reproduce oracle verification and inspect a complete
  example run from the repository alone.
- **SC-008**: All reported metrics state the fixture set, toolchain version, and model identifier
  they were produced with.

## Assumptions

- The pinned Daml toolchain is the one recorded in [plan.md](./plan.md), verified working offline.
  Its identity is pinned in configuration and checked at runtime.
- Verification uses the language-level Script runner against a simulated ledger. No multi-node
  network, no live participant, and no financial library are involved in the MVP.
- Fixtures are authored by hand for this repository; the agent never authors fixture sources or
  expectations.
- Analysis targets are already present on local disk. Acquiring a repository is a human step.
- A single model provider is used, and its identifier is recorded per run.
- "Exposes the expected behavior" is scored as a best-effort signal. A compiling, passing generated
  test is evidence that a property was exercised, not proof that the intended property was proven;
  reporting reflects this distinction.
- Evaluation runs that require the model may be skipped where no credential is available; oracle
  verification remains runnable without one.
