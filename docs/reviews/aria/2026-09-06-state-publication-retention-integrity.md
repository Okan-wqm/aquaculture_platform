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

## Historical recovery source repair

The canonical runtime owner now exposes `runtime recover-git-history-artifacts`. Its API and CLI
require an exact current state commit, an exact ancestral source commit, host binding, an existing
typed operator approval, acknowledgement and an audit reason. The dry-run returns the complete
metadata plan without changing files. Source blobs must be regular Git objects, match the historical
index and current manifest/inventory by identity, URI, SHA-256 and size, and pass verification before
the durable recovery intent is appended. Git replacement objects cannot rebind those reads.

The hash-chained retention intent binds the source/current commits, full sorted target plan, canonical
index-row digests and acceptance-ledger prefix. Recovery writes verified bytes without replacing an
existing target, restores only the missing index rows and appends a storage-verification receipt.
Interrupted execution resumes from the same intent; mismatched targets, projections, receipt identity
or ledger boundaries refuse. Publication remains the existing state publisher's responsibility and
requires its exact expected base commit. Storage recovery itself does not commit or push state.

Recovered artifacts remain available for diagnostics but are classified `historical_recovered` and
need revalidation before they can earn execution credit. The existing cycle promotion classifier and
runtime-v2 approval owner reject that history, including its reuse in a later cycle. A fresh unrelated
artifact keeps its existing classification. Local and immutable autonomy-unlock readers preserve
critical violations, reject positive recovery-bound acceptance credit and validate the captured
hash-chain boundary. Pending recovery, missing or unknown evidence status, malformed plans and
receipt/projection identity mismatches remain fail-closed.

Regression contracts cover exact source-object reads, read-only dry-run, interruption before/between
blob writes and around index/receipt persistence, repeat recovery, normal publication and immutable
restore, retained negative evidence, historical promotion/approval rejection and fresh-cycle
classification. The storage graph and evidence projection also reject malformed metadata without
letting diagnostic normalization create execution authority.

## Integrated source validation — 2026-09-07

After integrating main at `a618cb4ee16f9c45555708beaffd1121f28c9051`, the canonical scoped runner
passed 120 tests across the recovery, runtime-artifact, artifact-graph, operator-approval,
unlock-continuity, plan-converged approval, compaction and CLI enterprise modules. Its native-pytest
partition found no additional native tests in those modules; the 120 unittest-owned cases were
excluded from that partition by the normal runner contract.

Scoped Nx affected testing passed six invariant suites and 63 tests: canonical restore, ARIA
documentation/runtime consistency, registry integrity, registry closure drift, the debt-plan
contract and workflow script references. Scoped Nx lint, Python compilation, generated metadata
checks, review Prettier and staged-format regression checking also passed. The format checker
retained four pre-existing base-debt files and reported no new formatting regressions. These are
source checks; they do not establish live recovery or the P10 signed-evidence acceptance contract.

## Live recovery and signed evidence contracts remain open

Coordinator-verified history: state commit `f5bcb194d34ece144abd1d54c4281c6fd5acaf4e` deleted 158
hot blobs present in parent `523dd8c704233da5db454ee2022715309baf9296`, leaving manifest and
inventory references. The 2026-09-07 read-only audit of exact state commit
`a383638a610e9bdc2e45393a55d623acab92667b` found 158 missing hot blobs and 158 missing index
projections. All 158 ancestral objects match the current manifest/inventory and historical index by
SHA-256 and size, totalling 552,621,191 bytes; the 18 newer artifacts verify, with no artifact-graph
defects outside the selected recovery set. The candidate-plan digest is
`sha256:50e523c0d1d8eb9de8c4d7fb1a15825f7bba0f1dcc750d3351e0fe2c38494ddf`.

The snapshot still claims 176 index rows while its actual index has 18. Full snapshot/tree
attestation was not performed, and this immutable candidate inspection was not a canonical API
dry-run: operator acknowledgement, a resolvable approval reference and an operator-selected valid
host binding were not supplied or synthesized. No historical blob was restored. The coordinator's
small audit artifacts remain in the ignored local recovery-audit directory and are not Git content.

The approved P02 live recovery phase remains owned by Okan-Wqm, due 2026-09-13: inspect a separate
recovery worktree, verify each candidate historical blob against its recorded hash, produce a
complete reviewable dry-run, recover trustworthy bytes or issue explicit invalidation receipts,
reconcile dependent approval/promotion/closure/unlock validity, and verify a subsequent normal
restore. The P10 independent signed closure and approval revalidation contract remains owned by
Okan-Wqm, due 2026-09-13. This source change does not reinterpret existing signed closure rows,
independent approval records or previously issued runtime-v2 authorizations. It supplies no new
independent revalidation mechanism and is not proof of global approval or closure reconciliation.
These are tracked P02/P10 acceptance obligations, not additional allocations of ARIA-HIGH-040 or
ARIA-HIGH-041. Source finding closure must never be presented as satisfying live acceptance. No live
state branch, production artifact, authorization or approval requirement was changed by this task.
