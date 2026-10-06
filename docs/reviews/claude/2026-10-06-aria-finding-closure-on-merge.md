# A merged implementation never closed its finding, and duplicates of one subject came back (2026-10-06)

Owner: claude (implementation), okan (review). Deadline 2026-10-13.

## ARIA-HIGH-363

Two defects let one fixed defect be planned again:

1. **No closure on merge.** `implementation_reconciler` turns a merged PR into the plan's
   `implementation_merged` event and runs convention promotion. It never touched the finding the
   plan was minted from. The only automatic RESOLVED producer for ARIA findings is
   `finding_fix_verified`. It is reachable only from the CLI and needs a recorded reproduction,
   which no seeded drift finding has. The `SELF_LOOP_OWN_CHANGE` guard (`finding_grounding.py`)
   refuses only findings created after the merge. So every finding created before the merge stayed
   OPEN and plannable by the aging-F source.
2. **The seeder deduped by line.** `tools/aria-poc/seed_drift_findings.py` deduped by
   `finding._evidence_chain_id`. That hash covers each evidence ref (with its line) and summary (with
   its value list). Measured on the `aria/state` store (16 findings, read-only):

| Subject (drift class, file + declared name per side)                                                         | Findings                          | Lines cited             |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------- | ----------------------- |
| `ui_option_drift`: `LeavesPage.tsx` `leave-filter-status` vs `leave-request.entity.ts` `LeaveRequestStatus`  | F-003, F-005, F-007, F-008, F-015 | 346, 358, 355, 353, 389 |
| `ui_option_drift`: `CategoriesTab.tsx` `new-category-scope` vs `finance-events.ts` `FinanceScope`            | F-001, F-004, F-006               | 106, 107, 201           |
| `ui_option_drift`: `LeavesPage.tsx` `leave-filter-status` vs aquamobil `types/index.ts` `LeaveRequestStatus` | F-002                             | 346                     |

So 9 seeded findings cover 3 subjects. F-002 compares the same option group against a different
contract (the aquamobil type), so it is a separate subject. The 7 `ai_consensus` findings have no
drift subject and are not grouped.

Rule: a finding a merged plan fixed is closed when its own detector no longer reproduces it at the
merge commit, together with every open finding of the same subject. A drift finding's identity is
its subject, not its line.

Fix:

- **Subject key.** `aria_kernel/finding_subject.py` defines the key as the drift class plus the
  sorted (file, declared name) pairs of the evidence sides, with no line and no values. It is
  derived at read time from fields every seeded record already has: the `claim_summary` prefix and
  each evidence summary's `<name> values:` prefix. No stored finding is rewritten. The seeder
  computes it through the same function on the evidence list it mints with.
- **Seeder dedupe.** A subject held by any finding that is not RESOLVED (OPEN, IN_PROGRESS,
  SUPPRESSED or WITHDRAWN) is already recorded. A RESOLVED subject seen again is a regression and
  gets a new finding. Two drifts of one subject in one scan mint once.
- **Closure.** `aria_kernel/finding_closure.py` `close_merged_plan_finding` runs from the
  reconciler for every IMPLEMENTATION_MERGED plan whose origin is an F finding. That is the
  durable retry source, the same one promotion uses. The finding's own detector, keyed by
  `originating_skill`, rechecks it. For `seed:drift-scan` this is
  `seed_drift_findings.py --recheck-subject <key> --drift-class <c> --at <merge_sha>`, which uses
  the seeder's own scan, selection and mintability rule:
  - The scan runs in a detached worktree of the merge commit.
  - The lane's supergraph is passed only when HEAD and the merge share the newest schema-affecting
    commit. Without a judged wire, a UI subject is `unverifiable`, never `absent`.
  - On `absent`, the finding and every open finding with the same subject go OPEN → IN_PROGRESS →
    RESOLVED. These are the only transitions `finding.STATUS_TRANSITIONS` admits.
    `closes_in_commit` is the merge commit, and `resolution_evidence` holds the plan, merge, PR,
    detector, subject and verdict. `finding_status_changed` carries these as optional fields, and
    only on RESOLVED.
  - On `reproduces`, the result is recorded once and is final, because the revision cannot change.
  - On `unverifiable`, it is recorded once per reason and retried by the next cycle.
  - An origin with no registered detector is recorded and left open.
- `reconcile_recorded_implementations` now takes `workspace_root` as a required argument (the
  finding store and the detector's checkout). `cycle.py` passes the cycle's checkout.

Measured: the drift scan at HEAD takes 16.6 s on this host. It runs once per merged plan per cycle,
and only while that plan's finding is open and unjudged.

Tests (`aria-kernel/tests/test_finding_closure_on_merge.py`):

- Subject key: the five LeavesPage lines and the lowercase-values variant share one key. Another
  file, symbol or drift class gives another key. The stored F-015 record derives the key the seeder
  mints with.
- Seeder: a moved line does not mint, one scan with the subject twice mints once, a RESOLVED
  subject seen again mints a regression, and a SUPPRESSED subject stays held.
- Closure through the real reconciler:
  - A merge closes the primary and the legacy duplicate with the merge evidence and leaves an
    unrelated finding open. A replay is idempotent.
  - `reproduces` stays open and is recorded once.
  - `unverifiable` is retried and closes once it can be judged.
  - An unregistered origin is never closed.
  - A crash between the two transitions resumes.
  - Fixed duplicates are not re-planned: `admit_candidate` gives `finding_not_open`.
- Recheck: the scan runs on the merge commit's tree and the worktree is removed. The lane's
  supergraph is used only when no schema commit separates HEAD from the merge; a tree with no
  schema commit gets none. An unknown revision is `unverifiable`, and the CLI prints one JSON
  verdict.
- Judge: the subject in the scan reproduces; `absent` only when the wire judged the UI pairs; an
  unmintable drift does not reproduce.

22 tests, all passing.
