# ARIA gap-closure audit — the remainders the program left untracked in the registry

Recorded 2026-10-08 from a falsifier-verified audit of ARIA's planned-but-unimplemented
surface. Method: three exploration agents mapped every deferred item (plan-D1 remainders,
waiver manifests, debt records) against `origin/main@82798ad8f`, then six falsifier agents
attacked the resulting closure plan's premises; every "already closed on main" claim was
verified against the live tree before this audit accepted it.

Closed on main and therefore NOT re-raised here: the seven `_not_implemented` pre-merge
checks, `validate_request` wiring (ORPHAN-MEDIUM-572), the gap_closure/gap_finding roles
(retired, ORPHAN-MEDIUM-836), DRAFT/SANDBOX/ARCHIVED tool statuses (retired,
ORPHAN-MEDIUM-839), and the fix-dispatch/breaker/budget waiver family (ORPHAN-HIGH-573's
remaining entries carry their own schedule). DEBT-2026-05-07-001 and DEBT-2026-05-07-003
stay tracked in `aria-debts/` and are not duplicated.

What this audit registers — the four plan-D1 remainders plus the dead fixture runner,
none of which had a registry finding a `Closes:` trailer could point at:

| #   | Finding                                                      | Home                                                                                                                                              | Why it is still open on main                                                                                                                                                                           |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | ARIA-MEDIUM-391 — judge replay operator verb                 | Plan 025 §C (ARIA-025-D1's CLI half)                                                                                                              | `judge_replay.py` is cycle-phase-only; `cli.py` has no `judge` parser. The operator cannot replay judges on a gold corpus without waiting for a cycle.                                                 |
| 2   | ARIA-MEDIUM-392 — tier-claim vocabulary is TS-only           | Plan 026 §D (ARIA-026-D1)                                                                                                                         | `.claude/shared/tier-claim-syntax.md` names no Rust mechanism, `tier-claim-lint.ts` filters `\.(ts\|tsx)$` so `.rs` files are never scanned, and `root-cause-auditor.md` cites no Rust knowledge file. |
| 3   | ARIA-MEDIUM-393 — belief decay has no runtime-signal trigger | Plan 028 §D (ARIA-028-D1)                                                                                                                         | `memory.py` has age decay and head-distance decay; an open runtime signal referencing a belief's evidence never invalidates it — a runtime-only regression stays `supported` forever.                  |
| 4   | ARIA-MEDIUM-394 — runtime-signal source connectors           | Plan 029 §D (ARIA-029-D1's connector half)                                                                                                        | `runtime signal ingest` exists but nothing feeds it: no Sentry export reader, no incident importer, no log-anomaly tap, and no registered JSON schema for the record the bridge writes.                |
| 5   | ARIA-MEDIUM-395 — fixture suites have no standalone runner   | `cycle.py` `_phase_fixture_refresh` docstring ("with the driver dead, no fixture suite has run automatically since the heartbeat was superseded") | `refresh_fixture_suite` is reachable only through the superseded heartbeat phase; promotion evidence (fixture passes) can only rot.                                                                    |

Execution order: 1 → 5 → (2, 3, 4 in any order). 1 and 5 unblock the adapter-calibration
sequence tracked by DEBT-2026-05-07-003.

## ARIA-HIGH-396 — main went red on an unrostered proof-surface consumer (resolved)

Recorded 2026-10-09. ARIA-HIGH-204's closing commits (#1892) added
`decision_questioning.py`'s read of `agent_invocation_results` without the
classification `test_capability_specs_cover_discovered_surface_writers_and_consumers`
(`aria-kernel/tests/test_autonomy_evidence_status.py`) demands of every
executor proof-surface consumer, so main was red at `85ac08884` and every open
PR inherited the red suite lane.

The read is observational: the questioning fold records the outcome of
re-asking a closed decision and escalates an overturn; it cannot render or
accept a verdict. #1897 (`daea2732d`) placed it on the observational roster
beside `implementation_settlement.py`, `outage_causality.py` and
`plan_request_closure.py`, which turned main green. This finding records the
defect and its closure so the red interval has a registry row a `Closes:`
trailer can point at; the duplicate roster entry the first salvage branch
carried was dropped in favour of #1897's.

## ARIA-MEDIUM-400 — the fixture-run proof row does not bind what it measured

Recorded 2026-10-09 by the security review of #1898 (finding F1).

`fixture_suite_row` (`aria-kernel/aria_kernel/fixture_runner.py`) writes the
`fixture_calibration` proof row that SHADOW→ACTIVE readiness reads. The row
does not carry:

- the workspace commit the suite ran against;
- a hash of the scripts the runner argv executed.

`latest_fixture_status` decides whether a verdict is still current from the
tool version, the manifest hash and the fixture-set hash only. So a verdict
can outlive the code it measured.

#1898 adds the primary control: `tool fixture-refresh` runs only against the
store's own checkout at a clean HEAD. Binding the row itself is a separate
lane (owner claude, deadline 2026-10-20). It covers:

1. Schema version 2 of the proof row: `workspace_commit_sha` and
   `argv_scripts_hash`, both inside `evidence_hash`. `latest_fixture_status`
   re-hashes the scripts.
2. A deliberate semantic-authority bump for `fixture_calibration`, with the
   producer and fold pins in `tests/invariants/capability_semantic_equivalence`
   recorded in the same PR. This is an accepted reset of that capability's
   evidence.
3. No parallel provenance ledger: a run's facts have one owner.

Residuals the clean-checkout check cannot close. Only binding the row to the
script bytes, or to the inputs the scripts load, closes them:

- **Gitignored runtime inputs.** `node_modules` runner binaries and `.pyc`
  caches are not part of "clean". A modified ignored dependency runs
  unseen.
- **Repo-root override.** The `ARIA_REPO_ROOT` environment override
  redefines which checkout the store counts as bound.
- **Git environment and configuration.** These can change what `git status`
  reports. The check strips caller `GIT_*` variables and disables
  `core.fsmonitor` and the untracked cache. Other repository configuration
  (for example a `core.worktree` or attribute filters) is still read as
  configured.
