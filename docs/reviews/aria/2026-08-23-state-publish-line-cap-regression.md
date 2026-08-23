# ARIA review — 2026-08-23: state publish line-cap regression (live drain checkpoint)

Triggered by the Task 5 live checkpoint: drain run
`Okan-wqm/aquaculture_platform/actions/runs/32650188971` (dispatched 2026-08-23T15:57:51Z
on `main@0e134d0ef`) completed its children but ended red at the
`Publish ARIA state to the aria/state branch` step:

```text
aria_kernel.state_snapshot.SnapshotError: snapshot_surface_line_too_large:runs.jsonl
```

## Measured facts

- The runner store's `tools/runs.jsonl` line 156 is **1,488,466 bytes**; its
  `evidence_validation` field alone is **1,432,674 bytes** (plus `read_paths`
  at 88 KB). The row was written by the cycle `cyc-20260822T153253Z-auto`
  (2026-08-22), not by the drain.
- The same 1.49 MB line **is already present in the published state tip**
  `origin/aria/state@f5ccad395` (published 2026-08-23T05:47:07Z, before the
  Task 2 hardening merged at 11:44): the ledger published fine for weeks
  without a per-line cap.
- `state_snapshot.SNAPSHOT_MAX_LEDGER_LINE_BYTES = 1 MiB` (introduced by the
  Task 2 hardening, PR #1318) now refuses to re-snapshot the very ledger the
  repository already carries. Since 11:44 every `Publish ARIA state` step on
  every lane (drain, cycle, eval) fails closed at this line, so **no runtime
  evidence row has reached `aria/state` since** — the live checkpoints of
  Tasks 5-7 are blocked by this alone.

## Defect statement (two sides)

1. **Writer defect (the real bug the cap caught):** the `runs.jsonl` writer
   embeds a multi-megabyte `evidence_validation` payload inline in an
   append-only, hash-chained ledger row, although the row's own
   `artifact_ref`/`artifact_refs` pattern exists precisely so bulky payloads
   can live as artifacts. Inline blobs make every future reader pay for one
   run's verbosity, forever.
2. **Verifier regression (introduced by the hardening):** the snapshot
   producer's per-line cap applies to INHERITED history. An immutable ledger
   cannot be retroactively shrunk; a cap that rejects lines the publisher
   itself already published turns every existing oversized row into a
   permanent publication outage.

## Agreed fix shape (owner: this finding)

- **Writer:** spill oversized inline `evidence_validation` to the
  runtime-artifact store and keep only the reference (bounded inline size).
- **Verifier:** a grandfather rule — lines already present in the published
  state tip remain admissible; the per-line cap binds newly appended rows.
  Total-surface and per-blob budgets stay unchanged; defense applies to new
  writes, history is never rewritten.

## Finding

ARIA-HIGH-017 — state publication is permanently blocked for inherited
oversized ledger lines; required predicate:
`state_publish_line_cap_code_proven`; closure mode `task_commit`.

## ARIA-HIGH-017 state publication is permanently blocked for inherited oversized ledger lines

The governed anchor for the closure policy: the writer-spill plus
grandfather-rule fix closes this finding; its required predicate is
`state_publish_line_cap_code_proven` and its regression surface is the
snapshot line-cap admission plus the runs-writer inline-size bound.
