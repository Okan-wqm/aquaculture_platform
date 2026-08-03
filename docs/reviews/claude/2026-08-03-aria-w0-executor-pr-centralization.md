# ARIA Wave 0 — executor-lane PR opening centralizes on the kernel (2026-08-03)

Program: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md`, Wave 0
item 0.7 — the last Wave 0 item after the re-scope.

## ORPHAN-HIGH-523 — real PRs bypassed the PR perimeter

`pr_manager.open_pr_for_action` is where the PR-opening controls live:
the `ARIA_PR_BASE` mainline guard, `GATE_PRE_PR_OPEN`, the
failure-breaker producer, and the `--change-id` anchor for the §D.4
auto-merge triple-gate. But the executor lane's real PRs never travelled
it: the agent subprocess ran raw `gh pr create --base main` — a row of
`ALLOWED_BASH_COMMANDS` — and the implementer prompt even documented the
raw path as an approved alternative ("or through the equivalent guarded
`gh pr create`"). A perimeter no production PR crosses is the
written-yet-unreachable-control defect class the program keeps finding
(498, 520): every gate on the sanctioned path was real code with no
traffic.

**Fix (same commit):**

- `ALLOWED_BASH_COMMANDS` loses the raw `gh pr create` row and gains the
  kernel path, scoped to the one subcommand:
  `python3 -m aria_kernel pr create …` (which delegates to
  `open_pr_for_action`). The rest of the kernel CLI stays off the
  allowlist — operator surface, not implementer surface.
- The old row survives only as `LEGACY_GH_PR_CREATE_PATTERN`, honoured
  by `verify_bash_command_allowed` solely while
  `ARIA_EXECUTOR_PR_VIA_KERNEL` is unset. The scheduled executor lane
  (`aria-agent-executor.yml`) sets the flag to `1`, so in that lane the
  kernel CLI is the single reachable PR-opening path as of this commit.
- The staged rollout is a tracked two-step, not an open end: after one
  green scheduled run under the flag, the flag and
  `LEGACY_GH_PR_CREATE_PATTERN` are deleted together (PLAN.md Wave 0
  §0.7 owns the follow-through).
- `aria-implementer.md` step 9 now names the kernel CLI as the ONLY
  path and states that the allowlist refuses raw `gh pr create` under
  the lane's flag.

**Validation:** 6 new tests
(`aria-kernel/tests/test_executor_pr_via_kernel.py`): the legacy row is
genuinely out of the closed allowlist set (a copy left behind would make
the flag a no-op that reads as done); the kernel `pr create` argv is
admitted in both flag states while other kernel subcommands are not;
flag-on refuses raw `gh pr create`; flag-off keeps the transition path
open; and `gh pr merge` stays denied in both states — the cutover must
not loosen the merge-authority boundary. The 89 existing
implementation-safety invariants pass unchanged.

Owner: aria-acceptance-gap-fixer. Deadline: 2026-08-10 (post-merge close
ceremony; legacy-row deletion after one green scheduled run).
