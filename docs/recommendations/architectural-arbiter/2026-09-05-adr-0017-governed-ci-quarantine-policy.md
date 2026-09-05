# ADR-0017 — Governed CI Quarantine: Schema-Enforced Owner / Expiry / Finding, Per-Spec Granularity

**Status:** accepted
**Date:** 2026-09-05
**Resolves:** test-runner#TEST-001, #TEST-008, #TEST-009, #TEST-019; observability-expert#OBS-013
**Finding reference:** docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#INFRA-HIGH-141

## Context

`scripts/ci/affected-target-policy.json` quarantines ~40 projects from `lint` and 19 from `test` with opaque prose values ("CI run 26116890061: existing unit-test debt …"): no owner, no expiry, no finding id. `write-affected-target-report.mjs:50-59` only checks key presence and copies the string into a report. The exact Tier-1 pattern already exists twice in this repo: `scripts/ci/check-auth-db-ownership.mjs:62-68` requires every exemption to declare owner and reason and exits 1 on a missing key, and at `:101-106` fails on stale exemptions; `validate-secrets-manifest.ts` requires `owner` on every secret.

The stated justification for the admin test quarantine is false: admin-api-service runs 920 passed / 39 skipped, admin-panel 132 passed under `nx test` (measured 2026-09-05).

Options: a Tier-3 invariant over a schemaless JSON, or make the consumer enforce the schema (Tier-1). A Tier-3 spec can be skipped, quarantined (the `invariants` project is itself in the lint list) or not run on a JSON-only PR.

## Decision

We make the policy value a required object `{ owner, expiry: YYYY-MM-DD, findingId, reason }` and make `write-affected-target-report.mjs` exit 1 on any entry that is malformed, expired, references an unknown finding, or references a finding already RESOLVED. The consumer is the gate. A backstop invariant `tests/invariants/ci-quarantine-schema.spec.ts` asserts the same so an expired entry fails a normal PR even when the affected set omits the project.

Quarantine granularity matches failure granularity: a failing spec is quarantined, a passing project is not. The `test` quarantine for `admin-api-service` and `admin-panel` is lifted immediately on measured evidence. The `lint` quarantine is paid down as a dated per-project ramp with real owners, admin-panel first. No new entry may be added without the full object; each list's ceiling only decreases.

Coverage baselines (`service-coverage-baselines.json`) are not raised in the same PR that lifts a quarantine, so a red build stays attributable.

## Consequences

- Every remaining entry needs an owner and an expiry; the schema change forces that resolution rather than allowing it to be skipped. The fleet-wide historical entries are assigned to the repository owner with a dated expiry and INFRA-HIGH-141 as their finding; when that expiry passes, CI goes red until each entry is renewed with a justification or removed.
- Two admin projects' tests run on every PR again, which is the precondition for trusting any other ruling's gate.
- The losing side: the ability to make a red lane green by adding one line of prose.
