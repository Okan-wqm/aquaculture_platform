<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 021 — Backend Adapter Completion + Legacy Writer Frozen-Guard Hardening (placeholder)

> **Status:** PLACEHOLDER — created at Plan 020 sign-off (`2026-05-08`).
> Captures Plan 020's explicit hand-off scope so the work has an owner +
> deadline ledger before it rots.

## Why this plan exists

Plan 020 closes the harness reliability + governance gates for ARIA, but
makes two scope decisions that DEFER hardening work to a follow-up plan:

1. **Backend adapter portfolio completion** — Plan 020 Phase 14 promoted
   2 of the 5 remaining shadow_runner adapters to real parsers
   (outbox-adapter + cqrs-adapter). The other 3 (dual-alias-adapter,
   migration-runner-adapter, nats-cert-identity-adapter) STAY on
   `shadow_runner.py` and remain SHADOW status.
2. **Legacy writer frozen-guard hardening** — Plan 020's frozen profile
   semantic is intentionally SCOPED to the 14 PLAN_020_WRITE_SURFACES;
   legacy mutators (finding/debt/observation emit, human_required,
   review_record, change_planned, agent_release/requeue/reap_stale,
   low-level append_tools_governance) are NOT routed through
   enforce_profile_for_write. Plan 020's frozen invariant is therefore
   a NARROW safety boundary — incident response still has observation-
   class write paths available.

## Plan 021 scope (two interlocking work streams)

### Stream A — Backend adapter completion

For each of the 3 remaining adapters (`dual-alias-adapter`,
`migration-runner-adapter`, `nats-cert-identity-adapter`):

1. Replace the `shadow_runner.py` placeholder under
   `tools/aria-poc/<adapter>.py` with a real parser following the
   established pattern (`outbox_adapter.py` + `cqrs_adapter.py` from
   Plan 020 Phase 14 are reference implementations).
2. Each adapter ships with ≥1 fixture-driven positive case test under
   `tools/aria-adapters/fixtures/<adapter>/`.
3. Registry row's `runner.argv` switches from `shadow_runner.py` to the
   adapter-specific script.
4. Live SHADOW invocation produces non-empty observations on the snowball
   repo (or, if the repo is genuinely clean for that adapter,
   fixture-test coverage backs the acceptance — `Plan 020 §Phase 14
   acceptance discipline` carries forward).

Closes: `DEBT-2026-05-07-003` (the original "9 adapters all on
shadow_runner.py" debt; Plan 020 took 5/10 → 7/10 — outbox + cqrs
+ banned-phrase + the original 4. Plan 021 takes 7/10 → 10/10.).

### Stream B — Legacy writer frozen-guard hardening

For each legacy mutator surface listed below, route the persist path
through `enforce_profile_for_write(<surface_kind>, ...)` so the frozen
profile becomes a TRULY GLOBAL no-write invariant rather than the
Plan-020-scoped narrow one:

- `finding.emit_finding`                  → surface_kind='finding'
- `debt.emit_debt`                        → surface_kind='debt'
- `human_required.record_human_required`  → surface_kind='human_required' (NEW)
- `review_record.record_review`           → surface_kind='review_record' (NEW)
- `change_ledger.emit_change_planned`     → surface_kind='change_ledger_planned' (NEW)
- `agent_invocations.release_claim` /
  `requeue_claim` /
  `reap_stale_claims`                     → surface_kind='agent_release' (NEW)
- direct `append_tools_governance` calls
  outside the 9+3 Plan 020 surface above  → audit + extension of
  KNOWN_WRITE_SURFACES.

The PLAN_020_WRITE_SURFACES set extends accordingly; observe-mode
allowlist gets revised so observation-class writes (finding/debt) stay
permitted under observe but blocked under frozen.

## Acceptance

- All 3 backend adapters live SHADOW with `evidence_validation['valid']=True`
  + ≥1 fixture-driven positive case + registry runner.argv resolves.
- Stream B: every legacy writer call site routes through
  `enforce_profile_for_write`; a fixture frozen-mode test confirms each
  legacy writer raises `profile_violation`.
- `DEBT-2026-05-07-003` status flips to RESOLVED.
- New invariant test pins the GLOBAL frozen-no-write semantic
  (`tests/invariants/aria-frozen-global-no-write.spec.ts`) — one positive
  test per legacy writer surface.

## Owner / deadline (placeholder)

- **Owner:** TBD by operator.
- **Deadline:** ≤ 60 days from Plan 020 close (target 2026-07-08).
- **Tracking finding:** `DEBT-2026-05-08-001` (Plan 020 Phase 5 OAuth
  contract closure) is INDEPENDENT of this plan; both ride forward.

## Boundary — Plan 021 does NOT cover

- Plan 020's per-cycle reviews + sign-off framework — those continue on
  the existing per-plan rhythm.
- Real-mode agent eval CI promotion — that depends on
  `DEBT-2026-05-08-001` (Phase 5) closure and is tracked separately.
- ARIA SPEC.md / IDENTITY.md / CONTRACTS.md / ROADMAP.md — Plan 021 is
  an implementation plan, not a contract revision.

---

> Plan 021 placeholder per Plan v3.3 §"Plan 020 Boundary — Closes vs Does
> NOT Close". This file SHALL be replaced with a full Plan 021 spec + 14-
> pass operator audit cycle before any Stream A/B implementation work
> lands on `snowball`.
