# ARIA state publication and retention integrity

Owner: Okan-Wqm. Source repair deadline: 2026-09-13.

This review covers source-code repair under the approved ARIA P02 plan. It does not claim live state
recovery, activation, evidence reconciliation, or removal of any approval requirement.

## ARIA-HIGH-040

Maintenance publishes through raw Git commands, bypassing the canonical publisher's snapshot
construction, immutable-tree verification and contention handling. The prior restore verifier could
also accept a byte-self-consistent snapshot with dangling artifact history. Sources:
`.github/workflows/aria-state-maintenance.yml`, `aria-kernel/aria_kernel/state_store.py`,
`aria-kernel/aria_kernel/autonomy_evidence.py` at source baseline `3a7a00a51`.

The repair routes maintenance through `aria_kernel state publish` with the existing step-local Git
credential. Runtime graph verification and immutable admission share one validator over all index,
manifest and inventory claims and retained archive receipts. Restore verification uses the same
immutable admission check. Publish receipts bind the code SHA, previous and new state SHAs, snapshot
SHA-256 and validator version. Existing immutable-tree rejection and fast-forward contention
handling remain mandatory.

Source acceptance: real temporary Git repositories reject dangling historical references without
advancing the remote; the next restore rechecks the graph; archived bytes are declared and carried;
publication still refuses post-snapshot changes and undeclared staged files. Host identity remains
host-local.

## ARIA-HIGH-041

Compaction deletes whole hot directories by age, then archives and removes index rows for files no
longer present. Global manifest and inventory rows remain untouched. This treats lost evidence as
removable bookkeeping and can hide existing corruption. Three apparent index regression tests were
below the `__main__` guard and outside the test class, so test discovery never ran them. Sources:
`aria-kernel/aria_kernel/state_compact.py`, `aria-kernel/aria_kernel/runtime_artifacts.py`,
`aria-kernel/tests/test_state_compact.py` at baseline `3a7a00a51`.

The normative contract is archive-first with deletion disabled by default
(`docs/aria/runbooks/runtime-retention.md`). Existing run and raw-finding readers require the
original hot URI. The source repair therefore preserves all artifact bytes and all projection rows;
state compaction no longer owns hot or discovery artifact deletion. Runtime retention owns
hash-verified durable copies and append-only archive receipts, under the same runtime transaction
group as artifact publication. Existing missing or corrupt evidence refuses compaction before source
changes. Artifact ID collisions refuse without overwriting earlier bytes; identical retries preserve
the original payload bytes and existing projection rows. Compressed ledger archives are
content-addressed, fsynced, read back and hash-verified before ledger reduction, and their receipts
participate in publication validation. All four compaction transforms share one declared
read/select/archive/receipt/rewrite transaction so concurrent normal appends cannot disappear.
Runtime archive receipts must match the named artifact identity, original URI, hash and size, not
only the copied archive hash.

Source acceptance: a redacted 158-missing-reference fixture remains invalid and byte-for-byte
unchanged; a live old artifact survives repeated compaction; mismatched bytes, partial inventory
writes and wrong inventory sizes refuse validation; archive-write failure preserves source bytes;
retry succeeds; corrupt archive copies fail verification; dry-run changes no bytes.

## Historical recovery remains open

Coordinator-verified history: state commit `f5bcb194d34ece144abd1d54c4281c6fd5acaf4e` deleted 158
hot blobs present in parent `523dd8c704233da5db454ee2022715309baf9296`, leaving manifest and
inventory references. Canonical state `e5709b087` has 18 live index entries and matching hot blobs,
but 176 manifest and inventory entries. The coordinator subsequently completed a passive audit: all
158 historical blobs match the current manifest/inventory and historical index by SHA-256 and size,
with zero unmatched entries. This source task has restored none of them.

The approved P02 recovery phase remains owned by Okan-Wqm, due 2026-09-13: inspect a separate
recovery worktree, verify each candidate historical blob against its recorded hash, produce a
complete reviewable dry-run, recover trustworthy bytes or issue explicit invalidation receipts,
reconcile dependent approval/promotion/closure/unlock validity, and verify a subsequent normal
restore. Source finding closure must never be presented as satisfying that live acceptance. No live
branch, workflow, production artifact or authority was changed by this task.
