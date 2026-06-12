# E2E - Messaging Service: chronic cancellation flake (2026-06-12)

## ORPHAN-HIGH-092 — "E2E Tests" job times out on a setup hook and self-cancels ~50% of runs

**Severity:** HIGH · **Layer:** infra/CI · **Owner:** infra-expert
**Discovered:** during B2 (#411) merge gating — plan-independent orphan finding.

### Observation

The `E2E - Messaging Service` workflow (single job `E2E Tests`) cancels on
roughly half its runs. Sampled last 18 runs: **9 cancelled / 8 success /
1 failure**. Cancellations are NOT concurrency auto-cancel — they are the
job hitting its own wall-clock after repeated `Exceeded timeout of 60000 ms
for a hook` (Jest beforeAll/afterAll), ending in
`##[error]The operation was canceled`. Reproduced identically on two
consecutive runs of the SAME commit (B2 head 4699f72dc, runs 27416356094
×2), confirming an environmental cause, not a code regression.

Main pushes flake too (095d44c03 cancelled), and the suite is NOT in
`branches/main/protection/required_status_checks` — K7 (#410, 807dc90a5)
deployed to production with this suite never green. So today it both
(a) masks real messaging-E2E signal behind noise and (b) blocks no merge,
i.e. provides near-zero assurance while looking like coverage.

### Why HIGH

A ~50%-cancel E2E suite is indistinguishable from "broken" — a real
messaging regression would hide in the same cancel noise. The suite must
either be made reliable (so it can become a required gate) or be honestly
demoted, not left as theater.

### Root-cause direction (not yet fixed — owner + follow-up)

The hook timeouts point at container/service readiness: the Jest global
setup waits on TimescaleDB + Redis + NATS coming up and exceeds 60s under
CI load. Candidate architectural fixes (highest tier first):
1. **Make it automatic:** a readiness gate (healthcheck poll) in the
   compose/test harness BEFORE Jest starts, so hooks never race startup.
2. **Make it detectable:** raise the hook timeout to a budgeted value AND
   fail loudly with a container-state dump on timeout (not silent cancel).
3. Split container-boot time out of the per-test hook budget.

Owner: infra-expert + messaging-expert (harness). Tracked, not deferred-
without-owner. Pairs with [[ORPHAN-MEDIUM-055]] (the embedding-column
error surfaced from the same E2E Postgres logs).

### Tier

Tier-3 (detectable): a required readiness gate + loud-timeout would make
the broken-environment state CI-visible instead of a silent cancel.
