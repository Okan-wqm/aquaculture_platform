# The kernel lane never gated a merge, and the local gate was invoked wrong (2026-10-09)

Owner: claude (implementation), okan (review). Recorded after the 2026-10-08 night.

## INFRA-HIGH-212 — no kernel lane gated a merge, and the local gate was invoked wrong

## CI-HIGH-001

PR #1892 auto-merged at 21:27 while its `aria-kernel` check was FAIL (11s) and
`suite (7)` was FAIL (20m33s) — a real regression: the questioning fold's read
of `agent_invocation_results` was an unrostered proof-surface consumer
(`test_capability_specs_cover_discovered_surface_writers_and_consumers`), fixed
the next morning by PR #1897. Main stayed red for 8h46m.

Evidence:

- `.github/manifests/main-required-status-checks.json` — required contexts were
  `sens-enterprise-summary`, `merge-gate`, `aria-merge-authority`, `build-status`;
  no kernel lane among them, so auto-merge had nothing to obey.
- `.github/workflows/aria-kernel.yml:395` — the `aria-kernel` job already folds
  `suite`+`lane`+`state` results (`Require every kernel job`), so one required
  context gates the whole kernel lane.
- The local pre-merge gate had been invoked as `aria-suite-run.sh full`
  (`/tmp/aria-suite-baseline.log`, 21:21 — six minutes before the merge): the
  runner takes module paths, never mode words; the call exited 1 unused.

Rule: a merge (manual or auto) requires the scoped local gate green on the PR
head AND the `aria-kernel` check green; kernel-code changes additionally pin
the discovery-based invariant tests (`test_autonomy_evidence_status`,
`test_surface_reachability`) into every scoped run, because they assert over
the whole discovered surface set and the import graph cannot reach them.

Fix (this change): manifest + `enterprise_readiness.REQUIRED_MERGE_STATUS_CHECKS`
gain `aria-kernel` (parity test enforces equality); `applyInvariantFloor` in
`scripts/ci/aria-suite-changed.mjs`; `docs/runbooks/aria-pr-landing-gate.md`
records the landing rule, the correct invocation, and the night budget measured
from the 2026-10-08 defect rate (~0.6 defects/PR → ≤3 PRs/night).
