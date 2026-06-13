# Wave 2 messaging enterprise hardening — close-out

**Cycle:** 2026-06-10-round3 (Wave 2)
**Owner agent:** messaging-expert
**Date:** 2026-06-13
**Source branch evaluated:** `fix/messaging-enterprise-gates-2026-05-29`

Wave 2 was scoped as "fresh-reimplement ~30% real-forward content from the
source branch." Firsthand verification of each slice vs current `main` found the
source branch is now **almost entirely superseded** — its one genuine residual
defect was fixed; the rest is redundant or regressive.

## Slice verdicts

| Slice | Verdict | Detail |
|---|---|---|
| AI egress gate + durable AI consumer | DONE | Merged earlier as #422. |
| **Opaque-push events + handler** | **SUPERSEDED + 1 gap fixed** | main's opaque-push is *superior* (content-free `MessageSent`, `randomUUID` ref + Redis ref-store + `resolveNotificationRef` round-trip, atomic SETNX dedup, failure-compensating rollback, content-free test). Source's `ChannelMessageSent`/`ChatPushRequested` (eventId-as-ref, racy dedup, extra event) is regressive — NOT ported. **Genuine gap MSG-HIGH-004 fixed** (#435): the push fan-out handler was unwired → offline channel-message push was dead. |
| **Composite-tenant FK + tenant_principals** | **SUPERSEDED** | main's messaging is schema-per-tenant (`tenant_<uuid>` clones via search_path) + engine-level RLS (`applyTenantRlsToSchema`, Baseline). Composite `(tenantId,id)` FKs add isolation value only in a *shared* `messaging.*` schema; in schema-per-tenant they're a redundant third belt, and `tenant_principals` FKs would add a new failure mode + backfill + a high-risk production migration for zero benefit. `message_send_idempotency` is already main's `1800600000000` ledger. The composite-FK work belongs to the **ADR-013 shared-schema convergence** (decided, but the `tenant_<uuid>.* → messaging.*` consolidation is an operator-gated P6, intentionally pending) — a strategic initiative, not a Wave-2 slice. |
| **CI invariant workflow** | **SUPERSEDED + 1 finding** | The 3 `check-messaging-*.mjs` scripts are already on main; `tenant-entity-routing` runs in `quality-gates.yml`. The bespoke `messaging-enterprise-release.yml` was not ported (main uses the unified ADR-033 deploy). Residual: **ORPHAN-MEDIUM-103** — `source-outbox` + `canary-metrics` gate scripts are registered but unrun (dead gates); the source-outbox contract is still DDL-enforced by `1800400000000`. |

## Dead-artifact pattern (3 found this session)

This codebase repeatedly ships "implemented but unwired" artifacts:
1. **Wave-6 M2** — `markMessagesRead` mutation defined, never triggered.
2. **MSG-HIGH-004** — push fan-out handler complete, never subscribed.
3. **ORPHAN-MEDIUM-103** — messaging gate scripts registered, never run.

The Wave-6 dead-contract ratchet (`tests/invariants/dead-contract-fe-operations.spec.ts`, #433) institutionalises detection for the FE-GraphQL variant; the backend/CI variants are caught here by review and tracked as findings.

## Source-branch disposition

`fix/messaging-enterprise-gates-2026-05-29` is **superseded-with-proof** across
all slices (verdicts above). Safe to delete (bundled + manifested) per Round-3
"deleted-with-proof". Bundle preserves its `messaging-enterprise-release.yml` as
the reference implementation for the ORPHAN-MEDIUM-103 fix.
