# event-store-service — CLAUDE.md (domain context)

> Root rules in `/CLAUDE.md` already apply (always loaded). This file adds ONLY the event-store facts that CONTRADICT a correct reading of those rules.

Event persistence, projections, upcasters, crypto-shred key store. Schema: `event_store` (platform-level — every entity declares `schema: 'event_store'` explicitly).

## GDPR erasure does NOT delete `stored_events` — and must not

`libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target-registry.ts` excludes `stored_events`, `event_store_outbox` and `tenant_payload_keys` from the erasure cascade. This is the design, not a gap:

- Erasure here is **crypto-shred**. `apps/event-store-service/src/crypto-shred/entities/tenant-payload-key.entity.ts` holds the wrapped DEK; the shred overwrites it and stamps `shredded_at`. Once the key is gone, the ciphertext in `stored_events` is unreadable — the event ledger stays intact and append-only.
- Deleting the `tenant_payload_keys` ROW would be actively harmful twice over: it destroys the shred tombstone, so a fresh DEK could be minted for an already-erased tenant, and it deadlocks the erasure transaction against the shred hook's own `UPDATE` on that same row.

An agent "closing the GDPR gap" by adding these tables to the cascade would break both erasure and the audit ledger. Read the exclusion comment in the registry before touching it.

## Tenant routing is by COLUMN, not by schema clone

`event_store` runs in `source-schema-tenant-column` mode: every table carries a `tenantId` column and NOTHING is cloned into `tenant_<uuid>`. It is not one of the seven tenant-scoped services despite being full of tenant data — so entities here always declare `schema:`.

## Rules that look like redundancy and are not

`stored_events` carries several unique composite indexes; `(tenantId, producer, producerEventId)` is the idempotent-publish dedup anchor, not a duplicate of the primary key. Dropping it re-opens double-publish on replica restart.

## Enforcement

Boot: `SchemaDriftValidator`. CI: `tests/invariants/tenant-erasure-ssot.spec.ts`, `pii-events-mandatory-crypto-shred.spec.ts`, `upcaster-chain.spec.ts`, `platform-entity-registry-parity.spec.ts`; entity-surface-vs-database parity by `apps/db-migrate/src/__tests__/bootstrap-from-scratch.spec.ts` (`db-migration-check.yml`).
