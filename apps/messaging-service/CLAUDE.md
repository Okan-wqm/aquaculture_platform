# messaging-service — CLAUDE.md (domain context)

> Root rules in `/CLAUDE.md` already apply (always loaded). This file adds ONLY messaging-domain facts.

Channels, messages, attachments, reactions, receipts, GDPR, AI bridge. Schema: `messaging` (tenant-scoped; ADR-013 messaging-isolation-convergence). Routing is connection-default (`apps/messaging-service/src/database/data-source.ts` → `schema: 'messaging'`); each tenant gets a `CREATE TABLE LIKE INCLUDING ALL` clone via `TenantSchemaSyncService`.

## Schema (per-table — read this BEFORE adding any entity)
- Cross-tenant tables (KEEP `schema: 'messaging'`) are messaging's `MODULE_SCHEMAS[].infrastructureTables` in `libs/backend-common/src/database/schema-manager.service.ts`: <!-- infra-tables:messaging -->`migrations`, `messaging_outbox`, `embeddings_metadata`, `message_send_idempotency`, `tenant_erasure_target_proofs`<!-- /infra-tables -->. Proven against the registry by `tests/invariants/nested-steering-parity.spec.ts` — edit the registry, never this copy.
- **INVERSION — do not get this wrong:** the compliance tables are PER-TENANT, so they OMIT `schema:` — `compliance_audit_log`, `retention_policies`, `legal_holds` (`apps/messaging-service/src/compliance/entities/*.entity.ts`). They are cloned into each `tenant_<uuid>`, NOT cross-tenant. The generic "audit logs keep `schema:`" intuition is FALSE here.

## Domain invariants
- Messaging schema DDL has exactly one source of truth: TypeORM migrations in `apps/messaging-service/src/migrations/*.ts`, plus platform-owned primitives in `apps/db-migrate/src/sql/platform-bootstrap/`. Service-local `init-*schema*.sql` files are forbidden because they become a parallel, non-ledger DDL source.
- `messages` and `message_receipts` partition parents are created by the messaging baseline migration. Runtime child partition creation delegates to the platform SECURITY DEFINER primitive `platform.create_messaging_partition`; `PartitionManagerService` must never issue raw partition DDL.
- `compliance_audit_log` is a migration-owned, immutable per-tenant table with composite PK `(id, createdAt)` and DB-level UPDATE/DELETE prevention installed by migration (`trg_compliance_audit_log_prevent_update`). Its `synchronize: false` comes from the DataSource (`apps/messaging-service/src/database/data-source.ts`), NOT from the entity decorator — do not "fix" the entity by adding it. Do not document or add service-local init SQL as an authority for this table.
- `messaging_outbox` overrides `OutboxEntityBase`'s BIGINT PK with a UUID PK for cross-replica NATS Msg-Id dedup.
- An active legal hold blocks GDPR anonymise + retention cleanup for in-scope messages.

## Enforcement
`tests/invariants/messaging-schema-ssot.spec.ts`, `tests/invariants/messaging-partition-ddl-authority.spec.ts`, `messaging-joins.spec.ts`, `messaging-migration-runner.spec.ts`; `e2e/tests/integration/schema-invariants.spec.ts`.
