# agentic-protocol-security-lab

AI-native, spec-driven protocol security agent that turns code changes into threat models, security
invariants, adversarial tests, tool-backed verification, and reproducible eval results. First
adapter: Daml/Canton.

## Status: the end-to-end pipeline runs — no real-model result yet

`analyze <path>` now runs the whole loop: six validated analysis phases, generated adversarial Daml
Scripts, real compilation and execution on the pinned toolchain, bounded host-controlled revision,
and an evidence-backed report written as `report.json` with `report.md` rendered from it.

**This is the implemented pipeline, not a benchmark result.** No live provider request has been made.
Every model interaction so far is a deterministic fake in a test, so nothing here shows that a real
model found anything: the F01 end-to-end test scripts the model's outputs and proves the machinery
around them. A controlled live run is a separate, later step. Nothing yet supports a claim that Claude
found F01, that a real model detected the vulnerability, or that this is an autonomous auditor or a
production audit tool.

The deterministic scorer now exists too, and it carries the same caveat in a stronger form. `eval`
runs every fixture and writes a `scorecard.json` graded mechanically against host-owned expectations
the evaluated model never sees. The only scorecard produced so far has provenance
`harness_validation`: it was produced by a scripted fake and measures the harness, not any model. The
scorecard schema requires that field, so the file cannot be quoted later as if it were a benchmark
result.

What exists today is the governance and
specification layer, the host-side security boundary that must be in place before a model is ever
allowed into the runtime, and four vulnerable fixtures, each with a host-owned, independently
reviewed oracle proving the defect on the real toolchain:

| Artifact | Purpose |
|---|---|
| [`.specify/memory/constitution.md`](.specify/memory/constitution.md) | Ratified project constitution (v1.1.1) — the binding trust and evidence rules |
| [`specs/001-security-agent-loop/spec.md`](specs/001-security-agent-loop/spec.md) | What the MVP must do, and what it must be unable to do |
| [`specs/001-security-agent-loop/plan.md`](specs/001-security-agent-loop/plan.md) | Architecture, pinned Daml toolchain, and trust boundaries |
| [`specs/001-security-agent-loop/tasks.md`](specs/001-security-agent-loop/tasks.md) | Dependency-ordered implementation tasks |

Implemented so far: workspace path confinement, an argv-allowlisted process boundary with no shell,
secret redaction, the Zod artifact and report schemas, deterministic read-only repository, git and
Daml/`dpm` tools, and the append-only evidence store those tools now record through. The only
executable entry point is `apsl doctor`, which verifies the pinned toolchain and the tool surface.

Evidence is the substrate the later agent will be held to, not the agent itself. Every tool
invocation is dispatched through one function that appends a record capturing the argv, working
directory, exit code and output digests, addressed by a host-allocated identifier; refusals are
recorded as refusals. Redaction runs before anything is written to disk.

Also implemented: the bounded host-controlled model runtime substrate — a Messages API client, tool
plumbing that routes provider `tool_use` blocks through that same evidence-backed dispatch, per-run
usage accounting from provider-reported numbers only, a manual loop with host-owned turn and
tool-call budgets, the fixed phase state machine, and Zod artifact validation with a bounded retry
budget that marks a phase degraded rather than looping. The Agent SDK is not used, and no
provider-side shell, file-editor, web or code-execution tool is registered. The model is a
participant in this loop, never its controller.

Built on that: the first six validated, evidence-linked analysis phases — understand, inspect,
threat model, invariants, auth semantics and scenarios — each with a host-authored objective and a
schema its output must satisfy. The model is not handed the repository; it has to request source
through the allowlisted tools, and an artifact citing an evidence identifier that does not resolve to
a real recorded invocation is rejected rather than accepted on trust. Target-derived text is fenced
as untrusted data and never enters the trusted prefix.

Those scenarios now become tests that actually run. The model writes Daml Script source and declares,
before anything executes, what it expects the run to report; the host writes that source through a
write boundary whose only permitted destination is the run's own generated directory, compiles it
against a copy of the target, and runs it. The committed fixture is never a build root or a write
destination. What the toolchain reports is sorted into four states the host keeps apart — the test
never compiled, it compiled but no result was observed, it ran and matched its prediction, or it ran
and contradicted it — and the last two of those are the only ones that say anything about the target
at all. A compile failure or a contradiction sends the run back for at most two host-ordered
revisions; the model cannot choose to revise, cannot raise the budget, and cannot restate its
expectation after seeing the result. A conclusion whose supporting test never compiled and ran to its
own prediction cannot reach confirmed state, whatever the model asserts about it.

The report is assembled by the host, not written by the model. The model is never asked to summarise,
to state a finding's status, or to describe what the run established; the builder maps validated
scenarios and invariants onto findings, keeps a finding confirmed only when its evidence resolves in
the store and its supporting Script compiled, ran and matched its pre-declared expectation, and
downgrades everything else while keeping it visible. `report.json` is the single source of truth and
`report.md` is a pure function of it, so the document cannot contain a claim the structured record
does not. Both carry the same prototype boundary statement and the same explicit scope limits, read
from the JSON rather than pasted into the renderer. A generated Script that passes is
execution-backed evidence that a scenario was exercised — not a proof that the package is secure, and
not an audit.

The deterministic F01 end-to-end tests run against the real Daml 3.5.5 toolchain with a fake model
client and no credential. Analysing an ordinary project hides nothing; withholding a benchmark
fixture's own expectation and oracle is requested explicitly by the caller that evaluates it, not
implied by any filename.

Four fixtures are verified this way: F01 wrong controller, F02 template-level observer exposure, F03
missing multi-party authorization, and F04 propose/accept bypass. Each oracle demonstrates the
vulnerable transition succeeding, and — where the failure kind carries the meaning — pins a typed
`AuthorizationError` for the party that should be refused, so a passing oracle cannot be explained by
authorization simply not being enforced.

F02 additionally carries a probe establishing what its query results mean. A Daml Script `query` in
this toolchain is filtered by stakeholder: a party named nowhere on a contract sees nothing, and the
same party sees contracts that do name it. F02's exposure result can therefore be read as evidence
about the declared stakeholder set. That is the limit of the claim: it says nothing about what a
Canton participant node stores or transmits, and nothing about explicit contract disclosure.

Requires Node 22 (see [`.nvmrc`](.nvmrc)) and Daml SDK 3.5.5 via `dpm` 1.0.21.

```bash
npm install
npm run check          # typecheck, lint, format check, unit tests
npx tsx src/cli.ts doctor
npx tsx src/cli.ts analyze <path-to-daml-project>   # requires ANTHROPIC_API_KEY
npx tsx src/cli.ts eval                             # requires ANTHROPIC_API_KEY
```

`analyze` writes `runs/<runId>/report.json` and `runs/<runId>/report.md`. `eval` analyses every
fixture through a scratch copy that withholds the expectation and the oracle, then writes
`runs/scorecard.json`. The credential is read from
the environment by the host only, never passed as an argument, and never written to a report, an
evidence record, or a prompt.

## The intended idea

A local CLI that, given a Daml project path, runs a bounded analysis loop in which the model is
treated as untrusted: it may only emit validated structured artifacts and validated parameters to a
small allowlisted set of deterministic tools. It derives authorization and privacy invariants,
generates adversarial Daml Script tests, executes them with the real pinned Daml toolchain, revises
when results contradict its expectations, and produces a report in which every confirmed conclusion
must reference a recorded tool invocation. A deterministic host scorer — which the model cannot
reach or modify — grades runs against checked-in vulnerable fixtures whose oracles and expectations
are host-owned and independently reviewed.

The point is that conclusions are traceable to executed tooling rather than model narrative. If the
demonstration were `prompt → Markdown report`, it would have failed its own definition.

## Scope boundary

When implemented, this will be an AI review and research prototype, **not a formal security audit**.
It targets Daml language-level authorization and privacy semantics on an explicitly pinned toolchain.
It does not claim Canton-network security coverage, Daml Finance coverage, formal verification, or
production audit capability.

## License

Apache-2.0. See [LICENSE](LICENSE).
