# Security review: f01-wrong-controller

> AI review and research prototype, not a formal security audit.

Analysed f01-wrong-controller and produced 1 finding(s): 1 confirmed, 0 unconfirmed. 1 adversarial Daml Script(s) were generated, of which 1 compiled and 1 executed on Daml SDK 3.5.5.

## Run

- Run id: `example-f01`
- Started: 2026-01-01T00:00:00.000Z
- Completed: 2026-01-01T00:00:01.000Z
- Daml SDK: 3.5.5
- dpm: 1.0.21
- Model: fake-model-for-tests
- Model calls: 14
- Tokens in/out: 140/70
- Cache tokens read/created: 0/0
- Tool invocations: 7 dispatched, 0 refused

## Revision

- Execution attempts: 1
- Host-ordered revisions: 0 of 2
- Outcome: the cycle completed within budget

## Findings

### 1. Custodian transfers ownership without the owner submitting

- State: confirmed
- Severity: high
- Class: incorrect_controller
- Daml construct: Asset.Transfer
- Evidence: ev_8e29581647941a24, ev_a28adc229ac8289b, ev_ac7f6c3700e6c15f, ev_b7649abd84025a3c, ev_9a72693bb2f763f9, ev_bbdad2ee2d55d1c4, ev_13e886acd8b47975, ev_b50627bfea57904a, ev_d9bcc52719de71bf

Invariant under test: Only the current owner may transfer ownership of an Asset away from themselves.
Attempted misuse: Allocate issuer, owner and custodian, create an Asset, then have the custodian submit Transfer. If the invariant holds the ledger should reject it.
Generated Script Exploit (attempt 1): executed_expected. It declared script_passes before running, and a violation would be indicated by script_passes.

## Invariants under test

- `inv-1` (Asset.Transfer): Only the current owner may transfer ownership of an Asset away from themselves. — evidence: ev_8e29581647941a24, ev_a28adc229ac8289b, ev_ac7f6c3700e6c15f, ev_b7649abd84025a3c

## Generated tests

- `gt-1` → `generated/daml/Exploit.daml` (attempt 1): executed_expected; declared script_passes before running; compiled, executed (evidence ev_d9bcc52719de71bf); compile evidence ev_b50627bfea57904a

## What this report is

A confirmed finding means a generated Daml Script compiled, executed on the pinned toolchain, and produced the outcome it declared before it ran. That is execution-backed evidence that the scenario was exercised, not a proof that the invariant was encoded correctly, that all executions are safe, or that the package is secure.

- Covers Daml language-level authorization and privacy semantics only: signatories, observers, controllers, and choice structure.
- Results hold for the pinned Daml toolchain recorded in this report, and were produced by compiling and running generated Scripts locally.
- Makes no claim about Canton network security: sequencers, mediators, participant nodes, topology, and operational deployment are all out of scope.
- Does not cover Daml Finance or any other library beyond the analysed package source.
- No formal verification is performed. Absence of a finding is not evidence of absence.
- Not a production security audit, and not a substitute for review by a qualified auditor.

> AI review and research prototype, not a formal security audit.
