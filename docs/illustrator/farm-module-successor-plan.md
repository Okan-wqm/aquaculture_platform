# Farm Module — Successor Implementation Plan

> **Status:** OPEN — proposes the next iteration that takes over once
> the current `farm-modulu-kor-noktalar-dogrulama.md` plan reaches 100%
> via the four pending operational engagements (legacy migration,
> ClamAV daemon hosting, backend i18n strategy, sensor federation
> implementation).
>
> **Predecessor:** `farm-modulu-kor-noktalar-dogrulama.md` (the active
> plan, ~95% complete after the 20-PR session of 2026-04-27 to
> 2026-04-29)
>
> **Triggers next phase:** Each of the four contract-spec'd findings
> below flips RESOLVED ⇒ this successor plan's matching phase opens.

## Why this document exists

The session of 2026-04-27 to 2026-04-29 closed 12 architectural
findings via 20 PRs against the predecessor plan. Four items remain
gated on operational engagement; each carries a contract spec landed
in `docs/illustrator/`:

| Item | Contract spec | Operational engagement needed |
|---|---|---|
| Phase 4.3 — legacy farm.farms / farm.ponds migration | `legacy-migration-contract.md` | Backup window scheduling + Mattilsynet freeze coordination |
| Phase 6.2.2 — ClamAV virus scan | `file-upload-virus-scan-contract.md` | clamd hosting topology decision |
| Phase 7.1 — backend i18n | `backend-i18n-contract.md` | `@nestjs/i18n` dep adoption review + auth-service `JwtClaims.locale` coordination |
| Phase 7.4 — sensor `Tank.@ResolveReference` | `sensor-tank-federation-contract.md` | Sensor-team's implementing PR |

Once each of those four engages, the implementing PR closes the
predecessor plan's slice. This successor plan picks up the items that
become visible AFTER those closures land — items that don't belong in
the predecessor plan because they're either (a) the natural follow-on
to closures, (b) cross-cutting concerns the predecessor scoped out
explicitly, or (c) emerged during the 20-PR session as
noted-but-not-yet-prioritised observations.

## Scope of this successor plan

### Phase S1 — Cross-service contract alignment (parallelisable, after sensor + i18n unblock)

The two cross-service contracts (FARM-MEDIUM-009 sensor federation +
FARM-MEDIUM-011 i18n auth coordination) require alignment work that
crosses ownership boundaries. The contract specs from the predecessor
plan capture WHAT each service should deliver; this phase captures
HOW the platform-level alignment happens.

**S1.1 — Cross-service event-shape governance**

- Audit every cross-service event under `libs/event-contracts/src/`
  for tenancy + correlation field consistency.
- Sensor service events (S1.1 v3 with `parameter` field) set the
  precedent: every cross-service event MUST carry `tenantId`,
  `correlationId`, `version` at the envelope level + a typed payload.
- Open finding for any event that doesn't match (audit-log /
  notification / messaging events likely candidates).

**S1.2 — i18n glossary governance**

- Once Phase 7.1.1 ships, the `i18n/{tr,en,no}/errors.json`
  files become the canonical glossary for error wording.
- Cross-service consumers (notification-service email templates,
  alert-engine trigger reasons, regulatory reports) need the same
  glossary to avoid wording divergence — operator sees TR error in
  app + EN error in email + NO error in regulatory report = same
  underlying event.
- Create `libs/event-contracts/src/i18n-glossary.ts` shared module
  that auth-service / notification-service / alert-engine consume.

**S1.3 — Federation gateway introspection invariant**

- Once Phase 7.4 ships sensor-side `extend type Tank`, the gateway
  schema needs an invariant: if the federated extension lands AND
  farm-service's Tank schema changes, the gateway introspection
  must still resolve cleanly.
- New `tests/invariants/federation-introspection-stability.spec.ts`
  asserts the gateway can compose the supergraph without errors
  when farm + sensor schemas are running.

### Phase S2 — Test coverage push (Phase 5.6 of predecessor, deepened)

The predecessor's Phase 5.6 noted "test coverage 65/150 specs;
incremental." This is the natural next phase once the architectural
slice is settled.

**S2.1 — Service-level coverage**

Top 10 untested critical services (identified in this session's
audit but never closed):
  - `water-quality.service.ts`
  - `biomass-calculator.service.ts`
  - `sgr-calculator.service.ts`
  - `batch-domain.service.ts`
  - `health-event.service.ts`
  - `batch-cost-calculator.service.ts` (test exists; depth check)
  - `lot-mix.service.ts` (test exists; depth check)
  - `regulatory-settings.service.ts`
  - `mattilsynet-api.service.ts`
  - `harvest-policy.service.ts` (test exists; depth check)

Each gets a focused spec under
`apps/farm-service/src/<module>/__tests__/<service>.spec.ts`. Pure
unit tests; mocks for repositories. Delivers measurable coverage
uplift without changing production code.

**S2.2 — Handler-level coverage gaps**

Per the FARM-LOW-005 finding, `transfer-batch.handler.spec.ts` and
`create-batch.handler.spec.ts` need the `okCapacity()` factory
pattern that allocate-to-tank.handler.spec.ts established in
PR #203. Land the shared factory in
`apps/farm-service/src/batch/__tests__/helpers/capacity-fixtures.ts`
and wire all three specs through it.

**S2.3 — Integration smoke tests for the contract-spec'd flows**

Once the four contract-spec'd items implement, each gets an
integration smoke test (real DB; minimal mocks) that asserts the
end-to-end flow:
  - Legacy migration: source row → migration → canonical row,
    rowcount reconciliation passes.
  - ClamAV: clean upload happy path; infected upload moves to
    quarantine + emits FileInfectedEvent.
  - i18n: TR locale claim → TR message; NO claim → NO message;
    missing claim → TR fallback.
  - Sensor federation: `tank(id) { sensorReadings { ... } }`
    federated query returns rows from sensor-service, scoped by
    tenant.

### Phase S3 — Observability hardening

Each of the four operational engagements adds new operational
surfaces (migration_log table, FileInfectedEvent stream, i18n
locale-resolution metric, federation gateway query latency). Each
needs a Grafana dashboard + alerting rule.

**S3.1 — Migration runbook dashboards**

Per the legacy-migration contract, the operator runbook calls for
live tail of `migration_log` during the migration window. Build the
Grafana dashboard `farm-legacy-migration` that shows:
  - Per-tenant rowcount diff (legacy → canonical)
  - Conflict count from `migration_log_conflicts`
  - Estimated remaining time per tenant
  - Failure-state alerts (any tenant exceeds expected runtime by
    2x → page on-call)

**S3.2 — Quarantine bucket monitoring**

Per the ClamAV contract, the quarantine bucket has a 30-day TTL.
Build the dashboard + alert:
  - Quarantine bucket fill rate (rows/day per tenant)
  - Stuck-in-quarantine alert (any object > 7 days that hasn't
    been operator-reviewed)
  - Scanner-availability metric (provider.isReady() poll)

**S3.3 — i18n locale-resolution metrics**

Per the i18n contract, the `JwtI18nResolver` extracts the locale
claim. Add Prometheus metric `i18n_locale_resolved_total` with
labels `{locale, source}` where source is `claim` or `default`.
Operations dashboard tracks the locale distribution per tenant.

**S3.4 — Federation gateway latency**

Per the sensor federation contract, the federated query crosses
service boundaries. Add a Grafana panel showing
`federation_resolve_duration_p95` per field-resolver; alert when
the p95 exceeds 500ms (operator-perceived sluggishness threshold).

### Phase S4 — Cross-cutting architectural debt

The 20-PR session surfaced three FARM-LOW findings that are
genuinely actionable but small enough to bundle into this successor
phase rather than fight for individual prioritisation.

**S4.1 — FARM-LOW-003: ITenantCommand correlationId pattern**

Extend the base CQRS command interface with a required
`correlationId: string` field. Migrate every command class. Wire the
field through every audit-log / outbox emission site that wants to
bind to it. ~30-50 file changes, mechanically simple per-file diff.
Test invariant after closure: assert every command class extends
ITenantCommand and the field is populated.

**S4.2 — FARM-LOW-004: Equipment vs Tank denormalization**

Phase 4.3's legacy migration is the right window to converge on
ONE canonical column for `currentBiomass` / `currentCount` / `volume`.
Per the contract spec, the recommended path is "drop redundant
columns from one entity (likely Equipment) — Tank's tank-shape
semantics are domain-specific while Equipment is the generic parent
class." This phase is the implementation, gated on Phase 4.3 landing
first.

**S4.3 — FARM-LOW-005: okCapacity() factory consolidation**

Land `apps/farm-service/src/batch/__tests__/helpers/capacity-fixtures.ts`
exporting the okCapacity() pattern that PR #203 established inline.
Update `transfer-batch.handler.spec.ts` and `create-batch.handler.spec.ts`
to import it. Pure additive work; touches only test sources.

### Phase S5 — Plan retrospective + next-cycle planning

After Phases S1-S4 complete, the predecessor `farm-modulu-kor-noktalar`
work is fully landed. The retrospective phase:

**S5.1 — Doc archival**

Each of the four contract specs from the predecessor plan
(`sensor-tank-federation-contract.md`, `file-upload-virus-scan-contract.md`,
`backend-i18n-contract.md`, `legacy-migration-contract.md`) gets
archived to `docs/illustrator/archive/2026-Q2/` with an index entry
in `docs/illustrator/archive/INDEX.md` so future contributors can
find the negotiated contract that the implementation honoured.

**S5.2 — Successor plan cycle planning**

Once S1-S4 land, the next cycle's planning starts. Open question for
that cycle's plan author: which surfaces emerged DURING S1-S4 that
warrant their own plan slice? (Likely candidates: GraphQL query
complexity refinement based on production telemetry, audit-log
retention deepening based on regulatory feedback, cross-tenant
analytics if the product lands a multi-tenant aggregation surface.)

## Sequencing — what blocks what

```
                        (predecessor plan ~95%)
                                 │
      ┌──────────────────────────┼──────────────────────────┐
      │                          │                          │
  Phase 4.3                  Phase 7.1                  Phase 7.4
   landing                    landing                    landing
   (op eng)                   (op eng)                   (op eng)
      │                          │                          │
      ├─ S2.3 integration smoke  ├─ S1.2 glossary           ├─ S1.1 event-shape audit
      │                          │  governance              │  (sensor sets precedent)
      ├─ S3.1 migration dashboards├─ S3.3 i18n metrics      │
      │                          │                          ├─ S1.3 federation
      └─ S4.2 column converge    │                          │  introspection invariant
                                 │                          │
                                 │                          └─ S3.4 federation latency
                                 │
                            Phase 6.2.2 landing
                            (op eng)
                                 │
                                 ├─ S3.2 quarantine bucket monitoring
                                 │
  ───────────────────────────────┴────────────────────────────
                                 │
                       S2.1 / S2.2 (independent of all four)
                       S4.1 / S4.3 (independent of all four)
                                 │
                                 ▼
                          S5 retrospective
```

S2.1 (service-level coverage), S2.2 (okCapacity factory), S4.1
(correlationId pattern), and S4.3 (factory consolidation) are
INDEPENDENT of the four operational engagements and can land at
any time. They are the natural "between merge windows" work.

Everything else gates on at least one of the four engagements.

## Acceptance for this successor plan

This document doesn't have a "closing PR" in the same sense as a
finding. It serves as the architectural input to the next planning
cycle. Acceptance criteria:

- [ ] Each of the four contract specs from the predecessor plan
      lands its implementing PR (closes Phase 4.3, 6.2.2, 7.1, 7.4).
- [ ] Phase S1 (cross-service alignment) ships, using S1.1 / S1.2 /
      S1.3 as separate PRs against the matching closing PR.
- [ ] Phase S2 (test coverage) ships incrementally; no single PR
      bigger than ~5 service specs to keep review tractable.
- [ ] Phase S3 (observability) ships per dashboard; each Grafana
      dashboard is its own PR + alerting rule.
- [ ] Phase S4 (cross-cutting debt) ships its three FARM-LOW
      closures.
- [ ] Phase S5 retrospective produces the next-cycle plan
      successor.

## What this plan does NOT scope

- Frontend coverage push beyond what the existing 16/16 modal
  surface needs (the audit correction in PR #224 confirmed Phase
  3.0 is complete).
- New product features. This plan is purely architectural-debt /
  closure-quality work.
- Operational decisions (those are this plan's INPUTS, not its
  scope).

## Why a plan instead of opening every phase as an individual finding

Every Phase Sx item could be its own finding. Bundling them into a
plan document captures the SEQUENCING + DEPENDENCIES that
individual findings cannot — the diagram above is the load-bearing
artefact. A future contributor planning S2.3's integration smoke
test wants to know it gates on Phase 4.3 landing first; the plan
document carries that constraint cleanly.

When a Phase Sx item starts implementation, a concrete finding gets
registered (e.g. `FARM-MEDIUM-013` for S1.1 event-shape audit) and
the plan's matching phase entry flips to RESOLVED with the closing
PR ref.
