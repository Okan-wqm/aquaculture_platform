# ARIA producer lane: killed for memory it did not use, then sealed a row it could not publish

**Date:** 2026-09-02 · **Agent:** claude · **Cycle:** 2026-09-02 producer-lane root cause
**Finding:** ARIA-HIGH-034 — closed by this branch; this document is its evidence.

`aria-auto-cycle` had not succeeded since 2026-08-19 (54 runs since
2026-08-15: 5 success, 33 failure, 16 cancelled). The failing step moved
over time — cache, preflight, node deps, unverified state, lock timeout,
OOM, line cap — which is the signature of one environment producing many
symptoms rather than many independent defects. Two mechanisms explain the
last two weeks; both were reproduced on the live host before any fix.

## 1. The runner's job is the designated OOM victim on a shared box

**Reproduction.** Run 33552241359 (2026-09-01): the cycle produced no
output for 90 minutes, then `464182 Killed … python3 -m aria_kernel
autonomy run` (exit 137). Kernel journal at the same second:

```
oom-kill:constraint=CONSTRAINT_NONE … global_oom,
  task_memcg=/system.slice/actions.runner.…service, task=python3, pid=464182
Out of memory: Killed process 464182 (python3) anon-rss:21900kB … oom_score_adj:500
```

The victim held **21.9 MB**. It was chosen because its `oom_score_adj` was
500 — set by the runner itself (`_diag/Worker_*.log:
[ProcessInvokerWrapper] Updated oom_score_adj to 500 for PID …`). The
machine (7.8 GiB) was at 223 MiB free with interactive agent sessions
holding ~3.2 GiB (`user.slice`), four orphan nx daemons among them.
Repeated 2026-09-02 07:48:39 (pid 1992317, 22.5 MB, adj 500).

**Amplifier.** The service drop-in capped the runner at `MemoryMax=2G`
with the default `OOMPolicy=stop`; the cgroup's `memory.peak` sat exactly
on the cap and `memory.events: max 8996`. With `stop`, one killed job
process failed the unit (`Failed with result 'oom-kill'`), systemd
restarted it, and the job queued behind the restart was cancelled — the
"cancelled" half of the history.

**Fix (habitat, repo-tracked).** `scripts/aria/runner-habitat/systemd/`
holds both drop-ins; `scripts/aria/provision_runner.sh` installs and
drift-checks them and probes the _effective_ values. Runner:
`MemoryHigh=2300M MemoryMax=3G OOMPolicy=continue`. Every login session
(`user-.slice`): `MemoryHigh=2816M MemoryMax=3G` — a runaway agent CLI is
now reclaimed and, at the wall, killed inside its own slice instead of
pushing the machine into a global OOM where the kernel reaches for ARIA.

## 2. The ledger row-size cap lived only on the read side

**Reproduction.** Run 33608801135 (2026-09-02) ran 08:42→12:37, then:

```
aria_kernel.ledger.LedgerReadLimitError: immutable_ledger_line_too_large:
  …/.aria-state-store/tools/fixture-runs.jsonl:line=7
aria_kernel.state_snapshot.SnapshotError: snapshot_surface_line_too_large:fixture-runs.jsonl
```

The quarantined state artifact (`aria-state-cache-33608801135`) shows line 7
at **1 463 495 bytes** (line 6: 908 909). The row is one `real-repo-baseline`
case with `evidence_validation` = 1 461 828 bytes: `valid: true`,
`errors: 0`, and an inventory of 1 323 `checked_sources` + 2 996
`evidence_envelopes` serialised inline. Nothing was wrong with the run —
the inventory simply grows with the repository.

**Root cause.** `SNAPSHOT_MAX_LEDGER_LINE_BYTES` (1 MiB) was enforced by
`verify_jsonl_chunks` at publish time only. `ledger.append_jsonl` /
`append_declared_jsonl` accepted any size — 243 callsites across ~14
ledgers. ARIA-HIGH-017 (#1328) bounded `runs.jsonl` at its writer; the
sibling writer (`fixture_runner.run_fixture_case`) carried the identical
shape unbounded. Per-writer patches close one file per incident.

**Fix (kernel).**

- `ledger.LEDGER_ROW_MAX_BYTES` is the one cap; `_append_jsonl_locked_body`
  refuses a row whose written line exceeds it (`LedgerRowTooLargeError`,
  before the fd is opened — file, chain and index untouched).
  `state_snapshot.SNAPSHOT_MAX_LEDGER_LINE_BYTES` imports that constant.
- `ledger_inline` is the shared inline discipline (`spill_oversized_inline`,
  `spill_evidence_validation`); `tool_runner` delegates to it and
  `fixture_runner` bounds `evidence_validation` per case BEFORE the suite
  hash binds the row.

**Regression tests.** `test_ledger_row_cap.py` (cap identity; row at the cap
accepted; one byte over refused with nothing written; chain intact for the
next writer). `test_fixture_runner_row_cap.py` (the production inventory
yields a row under the cap with verdict/errors inline and a recovery stub;
`evidence_hash` verifies against the row as written; small inventories are
verbatim). `test_snapshot_line_grandfather.py` now writes its inherited
fat row the way pre-cap code did — the primitive no longer can.

## Not changed here, deliberately

- `oom_score_adj=500` on job processes is upstream runner behaviour and
  cannot be lowered by the unprivileged job. The habitat budget removes
  the _global_ OOM that made it matter.
- `aria-readiness-claim` fails on `branch_protection_proof_invalid` (main
  lacks signed commits / required reviews / conversation resolution /
  ruleset ids). That is a GitHub configuration decision, tracked separately.
