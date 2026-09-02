# ARIA kernel security defects — three controlled reproductions

**Date:** 2026-09-01 · **Agent:** zcode · **Cycle:** 2026-09-01 advisory-gate-recovery
**Findings:** ARIA-CRITICAL-031 (forged panel token) · ARIA-CRITICAL-032
(out-of-repo prune deletion) · ARIA-HIGH-033 (compaction archive loss) — closed
by this branch; this document is their shared evidence.

Each defect below was reproduced in a controlled setting before any fix was
written, then pinned by a regression test that fails on the pre-fix code.

## 1. Forged `panel_approval_token` promotes a SHADOW tool to ACTIVE

**Reproduction.** `transition_tool(tool, "ACTIVE", ..., panel_approval_token="forged")`
moved a SHADOW tool to ACTIVE.

**Root cause.** `tool_registry.transition_tool` verified the auto-promote
token at consume time (`verify_auto_promote_token`, wired for
ORPHAN-HIGH-787) but counted the panel token by PRESENCE alone:

```python
if (not operator_approval and not _auto_promote_verified and not panel_approval_token) or not evidence_chains_valid:
```

Any truthy string satisfied the third authority. The docstring even
documented the gap as design ("a consume-time check that does not exist");
mint-side gates cannot protect a consume path that receives caller input.

**Fix.** `promotion_veto.verify_panel_approval_token` — consume-time
verification mirroring the auto lane: re-derive the mint (which re-runs
kernel-scope, panel-adjudication and veto-window gates) and compare MACs in
constant time. The predicate now counts `_panel_promote_verified`, and the
I-V6.4-04 source-substring pin was rewritten (third rewrite, same doctrine)
to make a refactor back to presence-checking fail CI.

**Regression tests.** `test_jj2_humanless_promotion.py`:
forged token refuses and leaves the lifecycle untouched; a minted token
verifies at consume time and activates; absent/wrong tokens are
indistinguishable to the caller.

## 2. `worktree-prune --acknowledge` deletes an out-of-repo absolute path

**Reproduction.** A dispatch-ledger row whose `worktree_path` held an
absolute path outside the repository was really deleted by the prune.

**Root cause.** `worker_dispatch.prune_worktrees` joined relative paths
onto the repo root but accepted absolute paths verbatim, then ran
`git worktree remove --force` and fell back to an unconditional
`shutil.rmtree(path, ignore_errors=True)` when git refused the unknown
worktree. The ledger is agent-driven state; nothing confined the
destructive path to the workspace.

**Fix.** Containment guard: the resolved path must be strictly inside the
repository root (and not the root itself) or the row is refused with
`worktree_outside_repo` and recorded in `skipped`. `--acknowledge`
acknowledges pruning worktrees of THIS workspace, not whatever a ledger row
names.

**Regression tests.** `test_worktree_prune_containment.py`: out-of-repo
victim survives on disk; the repo root itself is refused; a legitimate
in-repo worktree is still pruned.

## 3. The "lossless" compaction archive loses the stripped data

**Reproduction.** After compaction, 100 stripped evidence envelopes were
unrecoverable from `archives/runs-compact-*.jsonl.gz` — and the original
ledger rows showed the same mutation, because the archive received the SAME
(shallow-aliased) row objects.

**Root cause.** `_compact_runs`/`_compact_raw_findings` mutate rows in
place (`ev.pop("evidence_envelopes")`, `row.pop("finding")`) and
`kept.append(row)` aliases them; `_archive_stripped(root, surface, rows,
kept)` then serialized the already-mutated `rows`. The docstring's
"nothing is lost" contract was unimplemented, and `test_archives_written`
only asserted the archive file EXISTS.

**Fix.** Compactors snapshot `copy.deepcopy(row)` BEFORE the first
mutation and archive exactly the pristine stripped rows;
`_archive_stripped` now takes only `stripped_rows` — it can no longer be
handed a list that aliases `kept`. Whole-row removal surfaces (beliefs,
learning-events) archive the untouched dropped rows.

**Regression tests.** `test_state_compact.py`: the runs archive carries
`run-old` with its 100 envelopes and 100 read_paths intact; the
raw-findings archive carries inline findings; beliefs/learning archives
carry exactly the dropped rows.

## Deliberate non-changes

- `settle_pending_promotions` mints and consumes the token in one kernel
  process; its activation path needs no consume-time re-verification of a
  value it just derived.
- The dispatch ledger still ACCEPTS absolute paths at write time; the
  destructive read side is now fail-closed, and record-time validation is
  tracked with the finding rather than smuggled into this fix.
