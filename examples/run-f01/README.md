# Example run: F01, wrong controller

A complete run of the pipeline against `fixtures/f01-wrong-controller`, checked in so that a
reviewer without an API key can judge whether the conclusion was earned.

## What this is not

**The provider was a script, not a model.** The fake was told which file to read, which template and
choice to name, and which exploit Script to write. This example therefore demonstrates the machinery
— six validated analysis phases, a real compile, a real execution, evidence records, and a report
assembled by the host — and demonstrates nothing at all about a model's ability to find F01. No live
provider request has ever been made in this repository.

## What is real

Everything except the model. The Daml SDK 3.5.5 toolchain compiled and ran the generated Script, the
exit codes are the exit codes the toolchain returned, and the report was assembled by host code from
those results under the confirmation gate.

## Files

| File | What it is |
|---|---|
| `report.json` | The report. The single source of truth, valid against `ReportSchema`. |
| `report.md` | A pure rendering of `report.json`. Regenerating it from the JSON reproduces it exactly. |
| `evidence.jsonl` | Every tool invocation, in order, with argv, exit code, and output digests. |
| `generated/Exploit.daml` | The adversarial Script the run generated, compiled, and executed. |

## Redaction and normalisation

Nothing was added or removed. Two classes of field were rewritten:

- **Absolute host paths** became `<run>`, `<repo>`, `<home>`, and `<tmp>`. A public example should
  not carry a username or a machine layout.
- **Wall-clock timestamps and durations** became a fixed synthetic clock, including the timestamps the
  Daml build logger writes into its own output. Re-capturing therefore yields a byte-identical
  result, and a real pipeline change shows up as a diff rather than drowning in timing noise.
- **Output digests were recomputed over the redacted text**, so a reader can check them against the
  bytes in this directory. They are consequently not the digests of the original unredacted output. A
  digest nobody can verify would look like verification without being it.

Everything a reviewer would check is as recorded: argv, exit codes, outcomes, evidence identifiers,
finding states, and artifact content.

## Reproducing it

```bash
npx tsx scripts/capture-example.ts
```

This needs the pinned toolchain but no API key, because the provider is a script.
