# Event-schema identity and cycle progression

## ARIA-HIGH-071 — Event-schema regressions can complete a cycle

Severity: HIGH. Owner: Codex, carried by Claude on the connected candidate. State: OPEN.

The default event-contract check compared only missing-schema counts, so fixing one missing schema
while introducing another could report no regression. Its native postcheck also returned
regression_count without the status consumed by the registered cycle failure collector. A genuine
detected regression could therefore end in a completed cycle.

The existing check now supplies stable path/symbol identities; paired comparisons report introduced
and removed identities without counting the corresponding numeric change twice. Missing historical
identity metadata retains numeric comparison. The registered postcheck wrapper converts positive
regression_count to the existing fail status. Native governance records and the general phase/status
policy remain unchanged.

Source owners: aria-kernel/aria_kernel/architecture_spine_gate.py and
aria-kernel/aria_kernel/cycle.py. Their existing test owners cover native observations, ledger
joins, the real failed/clean cycle and ordinary progression controls. The
[four-file catalogue](../../aria/ARCHITECTURE.md#event-schema-identity-and-native-cycle-completion)
pins source digests, affected callers and read limits.

The original producer regression failed2.79s; its unchanged oracle plus three controls passed7.26s
(4 methods plus6 subtests). Separate legacy6 passed17.65s. The real cycle regression failed39.29s
before the wrapper correction; unchanged regression plus clean control passed96.74s. The two
affected legacy progression controls passed165.85s. These are14 distinct methods across four
executions in an isolated engineering checkout, not a combined main-based run. Runtime agent
independently reviewed the services author's source, oracles and raw results; root reconciled the
exact four-file publication patch.

Publication base:53d3e82d4b500cabc034fe5874df066f2e1af24d. The cycle wrapper is the only cycle
source hunk applied; inherited changes from the engineering checkout are excluded. Actual clean-main
execution and public API results follow; normal repository checks and CI retain their separate
command/run receipts.

### Remaining acceptance boundaries

ARIA-HIGH-045 remains OPEN: this change covers the event-schema metric, not every tenant or other
invariant's stable identity. Owner: services specialist; next core phase after this publication.
Outer orchestration still needs actual plan/status propagation and
regression-to-corrective-attempt/resume evidence, owned by the same specialist next. Native model
execution, seven real pre-merge predicates and later-task learning remain runtime/memory core work.
No merge, activation or whole-system completion is claimed.

### Clean-main publication verification

The exact fourteen selected methods passed with six subtests in138.16 seconds, exit0. Source, index
and execution scripts stayed unchanged at
`dcb33dcdd1b0bdec6603a386f8cb2fdd85e0632ea0681f71ec0ebbdb574447a4`. This main-based combined run
covers the four new producer/comparator methods, six existing controls, the native cycle pair and
two legacy progression controls. It overlaps the isolated evidence and adds no new distinct IDs.

Actual cold before/after API observations are byte-equal under the same import schedule: six
spine/cycle public signatures,964 root names and1576 ordered exports. API SHA256
`a8f94a5afa498b0807dcd804486c79531eda6abc6894fce706321aa8dddad582`. These are this main checkout's
observations, not the separate engineering candidate's larger API inventory.

External evidence: `/tmp/codex-aria-spine-publication-20260911/` contains exact selectors, raw logs,
resources, source/index receipts and API observations. The ordinary publication source/tests are
unchanged by this evidence update. Runtime's distinct semantic/raw review is
`detector-progression-final-and-publication-doc-review.md` (SHA256
`3adfb470b8a0e8b933500b34e12ef2746db023a40bb721b5a688369efa7b0a51`). Normal hooks and head-specific
GitHub checks are reported by the PR; this document does not infer their result.
