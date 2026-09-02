# agentic-protocol-security-lab

AI-native, spec-driven protocol security agent that turns code changes into threat models, security
invariants, adversarial tests, tool-backed verification, and reproducible eval results. First
adapter: Daml/Canton.

## Status: bounded model runtime substrate — no analysis yet

There is no security analysis, no generated test, and no evaluation. The model runtime exists but has
no prompts to run: nothing in this repository has yet asked a model to look at Daml code, and no live
provider request has been made. What exists today is the governance and
specification layer, the host-side security boundary that must be in place before a model is ever
allowed into the runtime, and the first vulnerable fixture with a host-owned, independently reviewed
oracle proving the defect on the real toolchain:

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

Requires Node 22 (see [`.nvmrc`](.nvmrc)) and Daml SDK 3.5.5 via `dpm` 1.0.21.

```bash
npm install
npm run check          # typecheck, lint, format check, unit tests
npx tsx src/cli.ts doctor
```

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
