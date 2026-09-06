# The gate had no producer — 2026-09-06

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `c491539d0`.

Not from a branch. This one surfaced by being paid five times in one session.

## PROC-MEDIUM-029 — every merge left the next contributor a red gate

**Severity:** MEDIUM. **Owner:** infra-expert. **State:** IN-PROGRESS.

**Evidence.** `finding-registry-closure-drift` asserts that every finding whose `Closes:` trailer is
reachable from `origin/main` reads `RESOLVED`. The moment a PR merges, main violates that
assertion: the closing commit exists, the registry row does not yet say so. Nothing performs the
closure — `finding-registry.ts reconcile` is invoked by no workflow, no hook and no script.

So the cost lands on whoever opens the next PR, whose CI goes red for someone else's merge. In this
session that was the same branch five times:

| Left by  | Findings                                                                                   |
| -------- | ------------------------------------------------------------------------------------------ |
| PR #1424 | FARM-HIGH-320, ADMIN-HIGH-094, MOB-CRITICAL-021, FARM-HIGH-319, MSG-HIGH-080, MOB-HIGH-022 |
| PR #1450 | ADMIN-MEDIUM-095, FE-HIGH-064, INFRA-HIGH-161                                              |
| PR #1453 | FARM-HIGH-321                                                                              |
| PR #1452 | PLAT-HIGH-902                                                                              |
| PR #1456 | ADMIN-HIGH-097, ADMIN-HIGH-098                                                             |

The same gap produced three structural merge conflicts on the same four files — `findings.jsonl`,
`manifest.json`, `finding-truth-table.md`, `README.md` — because two branches were reconciling the
same hash chain by hand at the same time.

`finding-state-sweep.yml` already proves the machinery: a daily cron that mutates the registry and
publishes it through `tools/scripts/automation/open-report-pr.sh`, with a CODEOWNERS review before
merge. It runs `sweep` — the 30-day STALE and past-deadline BLOCKED transitions. It has never run
`reconcile`.

**Rule violated.** A gate that asserts a derivable state must have something that produces it;
otherwise it bills the next contributor for the last one's merge.

**Fix.** `.github/workflows/finding-closure-reconcile.yml` runs `reconcile` on every push to main
and publishes the resulting rows through the same script and the same review path.

It is a separate lane from the sweep, on three grounds: a closure appears at merge time while
staleness accrues by the calendar; reconcile is mechanically derived from the merged commits' own
trailers while STALE/BLOCKED is a judgement about whether work has gone cold; and a pending closure
keeps the next PR red where a pending staleness transition does not. Sharing one PR branch would
put the fast mechanical change behind review of the slow human one. They mutate the same file, but
`open-report-pr.sh` rebases onto main and force-pushes with lease on every run, so whichever merges
first, the other regenerates against the new tip.

The lane also repins the debt plan, and deliberately fails when the repin refuses: a changed
active-CRITICAL set needs a truth-table row with an owner and a bucket, which is a judgement this
lane must not fake. Failing asks for the human edit instead of publishing a manifest that disagrees
with the registry.

**What this does not do.** It does not eliminate the tax, it removes the delay. The closure is
proposed within minutes of a merge instead of going unnoticed until a contributor trips over it,
but the PR still needs a human merge — so a feature PR opened inside that window still inherits the
drift. Closing the last of the gap means auto-merging reconcile-only PRs, and that is a policy
decision about an audit artifact, not mine to take: `finding-state-sweep.yml` states the position
plainly — "auto-commits to main are a tampering surface" — and an auto-merged bot PR into the same
file is materially the same act. Reconcile differs from the sweep in being mechanically derived
rather than a judgement, which is the argument for treating it differently; the owner decides
whether that argument is enough.

**Closure criterion.** `gates:gha-sha-pin` (0 violations), `gates:required-status-checks`,
`aria-workflow-sha-pin`, `test-target-ci-reachability` and `github-actions-tpm-deps-ssot` all pass.
`workflow-secret-provisioning` caught the incomplete addition — the new lane referenced the three
`ARIA_GH_APP_*` secrets without declaring the dependency — and passes after
`.github/provisioned-secrets.json` names it. The multi-path `CHANGED_PATHS` was verified against
`open-report-pr.sh`'s own parsing (`awk 'NF { print }'` plus a verbatim `-e` check), which the
YAML block's indentation would otherwise have broken. `invariants:fast` 267/270, the three failures
being the `production-host-*` suites that fail in this container for its esbuild binary.

**Not verified here.** The lane cannot be exercised until it is on main — a `push: branches: [main]`
trigger does not fire from a PR. Its first real run is the merge of this PR, and the first thing it
will see is this PR's own closure of PROC-MEDIUM-029.
