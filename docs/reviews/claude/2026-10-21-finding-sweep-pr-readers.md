# The finding sweep PR fails invariants-fast on private state lists (2026-10-21)

PR #1335 is the daily finding-state sweep. `.github/workflows/finding-state-sweep.yml` re-creates
it every morning from main, and it has been open since 2026-08-28. Quality Gates has failed on
it every day since 2026-10-14. invariants-fast is not a required context, so the PR reads
MERGEABLE while red, and merging it as it stands would turn main's invariants-fast red.

Owner: claude (implementation), Okan-wqm (review). Deadline 2026-10-28.

## PROC-HIGH-059

The registry has one predicate for "is this finding still owed?":
`isUnresolvedFindingState` / `UNRESOLVED_FINDING_STATES` in
`tools/gates/finding-registry-chain.ts`, which covers every state but RESOLVED. STALE and BLOCKED
are the sweep's judgements about an unresolved finding. They are not resolutions (ARIA-HIGH-534,
where debt-plan-truth kept its own list and the sweep failed the debt-plan gate).

Three invariant specs still kept a list of their own. The 2026-10-21 sweep run (Quality Gates run
39600233694, job 119222569972: 3 failed, 3881 passed) fails each of them:

- `tests/invariants/three-store-invariants.spec.ts:1209` requires a scoped closure-policy row to be
  OPEN, IN-PROGRESS or RESOLVED. The sweep stales ARIA-HIGH-010, ARIA-HIGH-012, ARIA-HIGH-014 and
  ORPHAN-MEDIUM-789 by age, all with no closing commit.
- `tests/invariants/ci-image-registry.spec.ts:195-207` (`openFindingIds`) counts only OPEN and
  IN-PROGRESS rows. The sweep blocks INFRA-HIGH-214 past its 2026-10-16 deadline, so the
  `timescale/timescaledb-ha` exception it owns reads as having outlived its fix.
- `tests/invariants/claude-md-accuracy.spec.ts:134-141` accepts only an OPEN, IN-PROGRESS or
  BLOCKED row as tracking a gap. The sweep stales SENSOR-HIGH-070, so the gap cited at
  `apps/gateway-api/CLAUDE.md:27` reads as untracked.

The same class sits in `tools/audit/aggregate-hotspots.ts:321`, where open findings are OPEN or
IN-PROGRESS only. `tests/invariants/web-preview-data-path.spec.ts:69` and
`tools/gates/finding-registry-accountability.spec.ts:120` hold correct but private copies of the
unresolved set, which stop being correct the day the vocabulary changes.

Fix: every one of these readers asks the predicate. The three-store check asserts that the state
is in `FINDING_STATES` and that a row carries closing commits exactly when it is not unresolved.
`tests/invariants/unresolved-finding-state-ssot.spec.ts` parses every tracked TypeScript and
JavaScript file under `tests/` and `tools/`. It fails on an array literal holding two or more
finding-state literals, and on a `||` / `&&` chain that compares one expression with two or more
of them. It sanctions three sites by file and enclosing declaration: `FINDING_STATES` itself,
`planSweep` (the staleness transition starts only from OPEN and IN-PROGRESS) and
`applyClosureRejection` (override reopen starts from OPEN, IN-PROGRESS or RESOLVED, pinned by
`tools/gates/finding-traceability.spec.ts`). A sanctioned site that no longer holds a list also
fails.

With the fix, the three specs pass on #1335's registry content (head 41d603eb5) and stay green
on main's. #1335 needs no change of its own: the next daily run rebuilds it on a main that
carries this fix.
