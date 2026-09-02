# agentic-protocol-security-lab

AI-native, spec-driven protocol security agent that turns code changes into threat models, security
invariants, adversarial tests, tool-backed verification, and reproducible eval results. First
adapter: Daml/Canton.

## Status: specification phase — not yet implemented

Nothing here executes yet. There is no CLI, no agent loop, and no fixtures. What exists today is the
governance and specification layer that the implementation must satisfy:

| Artifact | Purpose |
|---|---|
| [`.specify/memory/constitution.md`](.specify/memory/constitution.md) | Ratified project constitution (v1.0.0) — the binding trust and evidence rules |
| [`specs/001-security-agent-loop/spec.md`](specs/001-security-agent-loop/spec.md) | What the MVP must do, and what it must be unable to do |
| [`specs/001-security-agent-loop/plan.md`](specs/001-security-agent-loop/plan.md) | Architecture, pinned Daml toolchain, and trust boundaries |
| [`specs/001-security-agent-loop/tasks.md`](specs/001-security-agent-loop/tasks.md) | Dependency-ordered implementation tasks |

## The intended idea

A local CLI that, given a Daml project path, runs a bounded analysis loop in which the model is
treated as untrusted: it may only emit validated structured artifacts and validated parameters to a
small allowlisted set of deterministic tools. It derives authorization and privacy invariants,
generates adversarial Daml Script tests, executes them with the real pinned Daml toolchain, revises
when results contradict its expectations, and produces a report in which every confirmed conclusion
must reference a recorded tool invocation. A deterministic host scorer — which the model cannot
reach or modify — grades runs against hand-written vulnerable fixtures.

The point is that conclusions are traceable to executed tooling rather than model narrative. If the
demonstration were `prompt → Markdown report`, it would have failed its own definition.

## Scope boundary

When implemented, this will be an AI review and research prototype, **not a formal security audit**.
It targets Daml language-level authorization and privacy semantics on an explicitly pinned toolchain.
It does not claim Canton-network security coverage, Daml Finance coverage, formal verification, or
production audit capability.

## License

Apache-2.0. See [LICENSE](LICENSE).
