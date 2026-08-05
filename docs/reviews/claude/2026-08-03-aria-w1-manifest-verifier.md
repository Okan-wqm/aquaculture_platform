# ARIA Wave 1 — integrity coverage derives from the manifest (2026-08-03)

Program: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md`, Wave 1
(Revision-2 order), PR 2.1 — the durable-state wave's opening move,
deliberately independent of the state branch: it closes
`ORPHAN-HIGH-433` standalone.

## ORPHAN-HIGH-433 (closed here) — coverage was a hand list

`covered_tool_ledgers` enumerated 4 required + 28 optional entries while
`state_manifest` declared ~129 tools-root ledger surfaces. memory/_,
enterprise/_, change-ledger/_, validation/_, queues/\* were written with
full hash-chain discipline and never verified: a surface had to be
REMEMBERED in the list to be covered. The fix derives coverage from the
manifest — `root_kind=="tools" ∧ state_class=="ledger"`, glob surfaces
contributing one entry per existing match (`name:relative/path`), the
core four (`runs`, `health`, `cycles`, `tools_governance`) unconditional
so an empty root fails closed. Declaring a surface IS enrolling it, and
the projection test recomputes the set independently so a hand list
cannot quietly return (I-W2-01).

## ORPHAN-HIGH-525 — the index eats the full rewrite (found by the fix)

Widening coverage exposed a second, pre-existing defect the hand list had
masked: `_refresh_adjacent_index_grouped` REPLACES the index's
`ledger_hashes` with exactly its own group membership on every indexed
append — while `update_tools_index` (full rewrite) and
`integrity._index_issues` (verifier) both worked from the WIDER covered
set. Every full rewrite planted entries the next append silently
discarded; the verifier only stayed green because in practice it ran
immediately after full rewrites. Three parties, two shapes, no owner.

**Fix (same commit):** `ledger.py`'s group table becomes the sole,
public authority — `tools_index_group_ledgers` — and all three parties
consume it: the grouped refresh (unchanged behaviour, now the declared
owner), `update_tools_index`, and `_index_issues`. Chain verification
stays on the wide manifest-derived set (that is 433's fix); the index
staleness check is scoped to what the index writers actually maintain.
Index keys are unchanged on disk — no migration. The
rewrite-then-append-then-verify sequence that used to corrupt is pinned
green by test.

**Known, scheduled residue:** `state_manifest`'s `index_group` column
has zero runtime consumers and its values disagree with the live
membership (117 surfaces claim a "runtime" index group that does not
exist). Reconciling or retiring the column belongs to the Wave-2
snapshot redesign, which replaces `integrity_index.json` wholesale with
signed snapshot manifests (`manifest_root`). Owner:
aria-acceptance-gap-fixer; deadline: Wave-2 PR 2.2 landing (tracked in
PLAN.md §W2); recorded in ORPHAN-HIGH-525's notes rather than left as
prose.

**Validation:** 4 new tests (`test_manifest_derived_integrity_coverage.py`)
pin the projection equality, auto-enrollment of a previously-blind
surface, tamper detection on a previously-blind ledger through the
public verify, and the rewrite→append→verify agreement. One test updated
(`test_phase4_agent_network_invocations`) from hand-list alias keys to
manifest surface names. Full kernel suite green on the branch.

Owner: aria-acceptance-gap-fixer. Deadline: 2026-08-10 (post-merge close
ceremonies).

## ORPHAN-MEDIUM-526 — order/load-dependent mutation-detector flake (observed, not fixed here)

While validating this PR, `test_007c_adapters_integration`'s shadow
no-mutation contract failed once in a full sequential suite run
(`repository_mutation_attempt` true) and passed solo, module-solo, and
in an instrumented full re-run; an assertion of the same shape failed
earlier on an UNMODIFIED tree under cross-suite load. The instrumented
run captured no spurious diff, so the mechanism is unconfirmed; the
leading hypothesis is git's racy-stat heuristic making two consecutive
`git status --porcelain` calls disagree without a real change (the
detector's before/after snapshots trust porcelain output).

A second full-run recurrence during this PR's validation (a sibling test
in the same class, same assertion) hardened the diagnosis enough to fix
the structural half immediately: the scoped and raw views of one
observation moment came from SEPARATE `git status` invocations taken
statements apart, so one moment had two witnesses that could disagree —
and the instrumented run had watched only the raw pair, which is exactly
why it captured nothing. `_workspace_snapshots` now takes ONE `git
status` per moment and projects both views from the same stdout
(intra-moment divergence structurally gone). The cross-moment half
(before vs after racy-stat drift) is what the finding remains OPEN for:
its close needs soak evidence (green sequential full runs), not one
green pass.
