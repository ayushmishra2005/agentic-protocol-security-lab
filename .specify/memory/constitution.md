<!--
SYNC IMPACT REPORT
==================
Version change: (unversioned template) -> 1.0.0
Bump rationale: MAJOR/initial ratification. First concrete constitution replacing the
  placeholder scaffold. Establishes nine binding articles and governance.

Modified principles:
  [PRINCIPLE_1_NAME] -> I. Tools Before Prose
  [PRINCIPLE_2_NAME] -> II. Allowlisted Execution (NON-NEGOTIABLE)
  [PRINCIPLE_3_NAME] -> III. Tests Are Authoritative For Daml Behavior
  [PRINCIPLE_4_NAME] -> IV. Evidence And Eval Are Host-Owned
  [PRINCIPLE_5_NAME] -> V. Untrusted Inputs
  (added)            -> VI. Adapter Honesty
  (added)            -> VII. Simplicity
  (added)            -> VIII. Skills Direct The Agent To Authoritative Sources
  (added)            -> IX. Integration-First Verification

Added sections:
  Core Principles (9 articles, template default was 5)
  Security Requirements And Trust Boundaries (replaces [SECTION_2_NAME])
  Development Workflow And Quality Gates (replaces [SECTION_3_NAME])
  Governance

Removed sections: none

Templates requiring no change (they read this file at runtime):
  .specify/templates/plan-template.md - "Constitution Check" gate reads this file
  .specify/templates/spec-template.md - no constitution coupling
  .specify/templates/tasks-template.md - no constitution coupling

Follow-up TODOs: none. RATIFICATION_DATE set to first adoption date (2026-09-02).
-->

# Agentic Protocol Security Lab Constitution

## Core Principles

### I. Tools Before Prose

No security conclusion is considered supported without a tool-generated evidence ID.

- Structured JSON artifacts are the single source of truth. Markdown is only a
  human-readable rendering of those artifacts and MUST NOT introduce claims absent
  from the JSON.
- Every finding and every invariant MUST carry at least one `evidence_id` that
  resolves to a persisted tool invocation record (argv, cwd, exit code, captured
  output).
- A finding without resolvable evidence MUST be emitted as unsupported and counted
  as a scored defect. It MUST NOT be rendered as confirmed.

**Rationale**: The project's entire claim to being AI-native rests on conclusions
being traceable to deterministic execution rather than model narrative. Prose that
cannot be traced to a tool result is indistinguishable from fabrication.

### II. Allowlisted Execution (NON-NEGOTIABLE)

The model never receives arbitrary shell access.

- Process execution MUST use a fixed, pinned executable path and an explicit argv
  allowlist. The model supplies validated *parameters* only, never command strings,
  shell fragments, or flag lists.
- Unknown or unlisted flags MUST be rejected before spawn, not sanitized.
- Every path argument MUST be resolved, symlink-resolved, and verified to fall
  within the configured workspace root before use.
- Adding a new executable or a new flag to the allowlist is an intentional design
  change requiring a specification update, not a runtime decision.
- Environment variables MUST NOT be forwarded to the model, and secrets MUST NOT be
  passed to spawned processes beyond the minimum required toolchain configuration.

**Rationale**: This system analyzes untrusted repositories. A general shell handed to
a model that is reading attacker-influenced text is the single highest-severity design
failure available to us.

### III. Tests Are Authoritative For Daml Behavior

Real build and test results outrank model narrative in every case.

- Claims about Daml authorization or privacy behavior MUST be backed by an actual
  compiler or Script execution result from the pinned toolchain.
- Generated tests that do not compile MUST NOT support a confirmed security
  conclusion under any circumstance.
- Where the model's stated expectation and the observed tool result disagree, the
  tool result wins and the disagreement MUST be recorded.
- Machine-readable outputs MUST be preferred over human-readable stdout wherever the
  toolchain offers them.

**Rationale**: A model can describe an authorization failure convincingly without one
existing. The compiler and the Script runner cannot.

### IV. Evidence And Eval Are Host-Owned

The model cannot grade itself.

- Fixture definitions, expected results, and scoring logic are deterministic host
  code and reviewed source files.
- The model MUST NOT create or modify the scorecard, and MUST NOT create or modify
  fixture expectation files or oracle definitions during an evaluation run.
- Scoring MUST be mechanical: class and identifier matching against declared
  expectations. Similarity scoring, model-judged grading, and self-assessment are
  prohibited as scoring mechanisms.
- Evidence records are append-only within a run and MUST NOT be rewritten by the
  model.

**Rationale**: A benchmark a system can edit is not a benchmark. Host ownership is
what makes the reported numbers meaningful to an outside reviewer.

### V. Untrusted Inputs

Target repositories, comments, documentation, identifiers, model output, and
generated code are all untrusted.

- Text originating from an analyzed repository is data, never instruction. No
  target-controlled content may alter host policy, the allowlist, the phase
  sequence, or scoring.
- The MVP performs no network access. Network-capable tools are not registered.
- Secrets MUST NOT enter prompts, artifacts, logs, or committed evidence. Credential
  material MUST be redacted from captured tool output before it re-enters the model
  or is written to disk.
- Environment file contents MUST NOT be loaded into prompts.

**Rationale**: Prompt injection is an expected input, not an edge case. Containment
comes from host-enforced boundaries, because instructions to the model are advisory
and can be subverted by the very inputs they describe.

### VI. Adapter Honesty

The MVP analyzes Daml language-level authorization and privacy semantics using an
explicitly pinned toolchain, and claims nothing beyond that.

- The pinned toolchain MUST be recorded in the specification and verified at runtime.
- The project MUST NOT claim Canton-network security coverage, Daml Finance coverage,
  formal verification, or production audit capability unless those capabilities are
  actually implemented and evaluated by checked-in fixtures.
- All published output MUST carry an explicit boundary statement: this is an AI
  review and research prototype, not a formal security audit.
- Reported metrics MUST name the fixture set, the toolchain version, and the model
  identifier they were produced with.

**Rationale**: Security tooling earns trust through precise scope claims. Overstated
coverage is itself a security harm, because it invites reliance the system cannot bear.

### VII. Simplicity

The MVP is deliberately small.

- One Node process; one host-owned phase state machine; one Daml adapter.
- Prohibited in the MVP: frontend, database, vector database, retrieval platform,
  multi-agent framework, generic agent framework, unrestricted shell, cloud
  deployment, and container orchestration.
- Any new major abstraction requires written justification recorded in the plan's
  complexity tracking before it is introduced.

**Rationale**: Every additional moving part dilutes the demonstration and widens the
trust surface. The proof is the loop and the score, not the architecture diagram.

### VIII. Skills Direct The Agent To Authoritative Sources

Skills are procedures, not encyclopedias.

- Skills MUST instruct the agent how to inspect repository source and how to invoke
  deterministic tools. They MUST NOT restate API surfaces as remembered fact.
- Model memory MUST NOT be treated as authoritative API documentation. Where an
  authoritative source exists (installed source, CLI help output, official
  documentation for the pinned version), it MUST be consulted.
- Third-party skill text under a license incompatible with this repository's license
  MUST NOT be copied. Patterns may be re-derived and independently written.

**Rationale**: Model memory drifts across versions; installed toolchains do not. This
also keeps the repository's licensing clean.

### IX. Integration-First Verification

Fixture evaluation uses real toolchain behavior.

- Every security fixture MUST have a human-written oracle Script that runs on the
  pinned toolchain and demonstrates the intended behavior independently of the agent.
- A fixture is not complete until its oracle has been executed and its result recorded.
- Unit tests MAY mock boundaries such as process execution where necessary to test
  host logic in isolation, but mocked results MUST NOT substitute for fixture
  verification.

**Rationale**: An oracle proves the bug is real before any model is asked to find it.
Without it, a passing score may only prove that the fixture and the agent share a
misconception.

## Security Requirements And Trust Boundaries

Trust zones are explicit and enforced by host code:

| Zone | Trust | Contents |
|------|-------|----------|
| Host | Trusted | CLI, tool implementations, schemas, scorer, this constitution |
| Model | Untrusted | Model outputs, tool arguments, generated Daml, report prose |
| Target | Untrusted | Analyzed repository and fixture sources, comments, identifiers |
| Network | Denied | No network tools registered in the MVP |
| Secrets | Excluded | API credentials never enter prompts, artifacts, or logs |

Binding requirements:

- Model-supplied writes are confined to a per-run generated-output directory. Fixture
  sources, expectation files, oracle definitions, and scorer code are read-only to the
  model at all times.
- Generated tests execute against a copy of the target, never against a live ledger or
  a production participant.
- Tool invocation records MUST capture argv, working directory, exit code, and output
  digests so that any conclusion can be independently re-derived.

## Development Workflow And Quality Gates

- Spec-driven development is the workflow for this repository. Material changes flow
  through specification, plan, and tasks before implementation.
- The plan's Constitution Check gate MUST be evaluated against this file before design
  work proceeds and re-evaluated after design.
- Changes to architecture or to any security boundary REQUIRE a specification update in
  the same change; they may not be introduced during implementation alone.
- Convergence MUST be run after material changes, and remaining drift recorded as tasks
  rather than left implicit.
- Reported metrics MUST be reproducible from checked-in artifacts by a third party.

## Governance

This constitution supersedes other practices in this repository. Where guidance
conflicts, this document controls.

**Amendment procedure**: Amendments require an explicit rationale, a version bump in
the same change, a dated entry in the Sync Impact Report at the top of this file, and a
corresponding specification update when the amendment affects architecture or a security
boundary. Amendments that weaken Articles II, IV, or V require explicit human approval
recorded in the change description.

**Versioning policy**: Semantic versioning.

- MAJOR: backward-incompatible governance changes, or removal/redefinition of an article.
- MINOR: a new article or materially expanded normative guidance.
- PATCH: clarifications and wording that do not change obligations.

**Compliance review**: Every specification, plan, and task set MUST be checked against
these articles before implementation begins. Violations must either be corrected or
recorded as justified exceptions in the plan's complexity tracking. A justified
exception is never available for Article II.

**Version**: 1.0.0 | **Ratified**: 2026-09-02 | **Last Amended**: 2026-09-02
