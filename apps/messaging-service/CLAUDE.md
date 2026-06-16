# messaging-service — CLAUDE.md (domain context)

> Root rules in `/CLAUDE.md` already apply (always loaded). This file adds ONLY messaging-domain facts.

Channels, messages, attachments, reactions, receipts, GDPR, AI bridge. Schema: `messaging` (tenant-scoped; ADR-013 messaging-isolation-convergence). Routing is connection-default (`apps/messaging-service/src/database/data-source.ts` → `schema: 'messaging'`); each tenant gets a `CREATE TABLE LIKE INCLUDING ALL` clone via `TenantSchemaSyncService`.

## Schema (per-table — read this BEFORE adding any entity)
- Cross-tenant tables (KEEP `schema: 'messaging'`) are EXACTLY: `messaging_outbox`, `embeddings_metadata`, `message_send_idempotency` — messaging's `MODULE_SCHEMAS[].infrastructureTables` in `libs/backend-common/src/database/schema-manager.service.ts`.
- **INVERSION — do not get this wrong:** the compliance tables are PER-TENANT, so they OMIT `schema:` — `compliance_audit_log`, `retention_policies`, `legal_holds` (`apps/messaging-service/src/compliance/entities/*.entity.ts`). They are cloned into each `tenant_<uuid>`, NOT cross-tenant. The generic "audit logs keep `schema:`" intuition is FALSE here.

## Domain invariants
- `compliance_audit_log` is RANGE-partitioned monthly on `created_at` (composite PK `(id, createdAt)`); partition DDL lives in `apps/messaging-service/src/migrations/init-messaging-schema.sql`, `synchronize: false`. Authority guarded by `tests/invariants/messaging-partition-ddl-authority.spec.ts`.
- `messaging_outbox` overrides `OutboxEntityBase`'s BIGINT PK with a UUID PK for cross-replica NATS Msg-Id dedup.
- An active legal hold blocks GDPR anonymise + retention cleanup for in-scope messages.

## Enforcement
`tests/invariants/messaging-partition-ddl-authority.spec.ts`, `messaging-joins.spec.ts`, `messaging-migration-runner.spec.ts`; `e2e/tests/integration/schema-invariants.spec.ts`.
<!-- back-test: CLAUDE-DRIFT-002, verified 2026-06-16 -->
