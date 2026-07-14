# Sites Setup Enterprise SSOT Remediation

Metadata:

- Created: 2026-06-01
- Last Resumed: 2026-06-02
- Current Phase: Phase 3 - Backend Write Path Replacement
- Last Validated Commit: a7a2e1398
- Next Resume Command: `codex resume /var/aqua-saas docs/plans/sites-setup-remediation/README.md`
- Registry Finding: `FARM-HIGH-003`

## Summary

`/sites/setup*` is already tenant-routed in several paths, but it is not yet fully SSOT-compliant. The remediation target is convergence: setup data must be owned by canonical tenant tables in each tenant schema, written through tenant-pinned transactions, audited and outboxed atomically, exposed through typed API/frontend contracts, and removed from legacy duplicate authorities only after objective gates pass.

This plan supersedes any document that claims site, department, system, tank, worker, fish-health, or document setup writes are already complete unless that claim is backed by current code and tests.

## Retain, Extend, Replace

Retain and extend:

- `MODULE_SCHEMAS` as tenant table manifest.
- `TENANT_AWARE_SCHEMAS` as fan-out/gate eligibility.
- `SCHEMA_REGISTRY` as migration ordering and migration-glob authority.
- `platform.release_ledger`, service migration ledgers, `runInTenantTransaction`, `tenantManagerRepo`, tenant query keys, permission matrices, codegen, `FileUploadSecurityService`, orphan cleanup, retention registry, `farm_audit_logs`, `farm.outbox_events`, and event contracts.

Replace or deprecate:

- `farm_workers` as person SSOT.
- Fish-health setup mock/local data.
- Chemical/feed JSONB documents as writable authority.
- Path-based document presign/delete.
- Direct setup repository writes, raw setup `QueryRunner` or raw `dataSource.transaction`, and direct setup `eventBus.publish`.
- Tank-like writes through generic equipment authority.
- Runtime DDL repair for existing tenants.
- Legacy `farms` and `ponds` as setup authority.

Compatibility rule:

- Temporary dual-read or dual-write is allowed only with explicit exit gates.
- New writes must route to the canonical aggregate as soon as the replacement path exists.

## Phase Plan

### Phase 0 - Docs, Registry, Authority Cleanup

- Keep this plan as the persistent remediation SSOT.
- Maintain `FARM-HIGH-003` as the registry-backed finding for this convergence package.
- Add or update review narrative when new evidence is found.
- Resolve stale docs that claim completed transactional/outbox behavior where current code still uses direct repositories or direct event publish.

Exit gates:

- Plan file exists and carries current metadata.
- Registry entry validates through `npm run findings:verify`.
- No invalid finding IDs are introduced.
- Conflicting docs are either corrected or explicitly superseded by this plan.

### Phase 1 - Inventory And Runtime Baseline

- Inventory handlers, GraphQL fields, REST upload routes, frontend routes/hooks/tabs, realtime consumers, analytics, reports, seeders, tests, and mobile/API clients touching setup surfaces.
- Keep the Phase 1 static inventory and runtime baseline contract in `docs/plans/sites-setup-remediation/INVENTORY.md`.
- Capture runtime usage for `farm_workers`, `farms`, `ponds`, `pondId`, JSONB documents, path presign/delete, tank-like equipment writes, and raw setup GraphQL.
- Each legacy surface must have an owner, canonical successor, telemetry or grep evidence, compatibility rule, and removal gate.

Exit gates:

- Every setup legacy surface has a tracked owner and successor.
- Runtime and static evidence are attached to the plan, inventory, or review narrative.

### Phase 2 - Schema And Migration Authority

- Preserve the authority split: `MODULE_SCHEMAS` owns tenant table surfaces, `TENANT_AWARE_SCHEMAS` gates tenant-aware schemas, and `SCHEMA_REGISTRY` owns migration order.
- SUPERSEDED (ORPHAN-HIGH-369 / FARMPLAT-HIGH-001): the canonical `farm_documents` table was built but never wired (no resolver/controller, no frontend), so the owner decision was to DROP it, not adopt it. The drop is implemented by `apps/farm-service/src/database/migrations/1805300000000-DropFarmDocuments.ts` (per-schema, fail-closed) and pinned complete by `tests/invariants/sites-setup-remediation-plan-contract.spec.ts`. Do NOT re-add `farm_documents`.
- The document surface that actually remains is chemical/feed JSONB document metadata + path-based presign/delete (see Phase 4 "Documents"). With the canonical `farm_documents` replacement retired, these need an explicit owner re-decision (accept JSONB metadata as authority, or open a new scoped finding) — they are NOT a FARM-HIGH-003 closure blocker on a table that no longer exists.
- Convert or retire existing tenant DDL repair surfaces for existing tenants, including `SchemaManagerService.syncTenantSchema()` and the admin schema sync route, or restrict them to new tenant provisioning only.
- Existing-tenant runtime repair is now fail-closed by default in `SchemaManagerService.syncTenantSchema()`; the admin schema sync service no longer calls it for existing tenants. The remaining explicit allowance is limited to disposable farm-service E2E bootstrap.
- Canonical farm outbox writes now target `farm.outbox_events` through the farm outbox entity; `farm.farm_outbox` remains compatibility/migration infrastructure only.
- Update stale registry/bootstrap invariants to compare against current platform bootstrap SQL.
- Fix tenant shape scans to resolve tenant-scoped entities through the same schema-resolution logic used by TypeORM and `MODULE_SCHEMAS`.

Exit gates:

- No runtime `CREATE TABLE`, `ALTER TABLE`, or `CREATE TABLE LIKE` repairs existing tenant schemas outside migrations.
- Release and tenant ledgers match expected heads.
- Bootstrap, tenant clone, schema invariant, migration SQL, and entity diff gates pass.

### Phase 3 - Backend Write Path Replacement

- Standard write contract:
  - resolver/controller to `CommandBus`,
  - command includes tenant, user, and correlation metadata,
  - handler uses `runInTenantTransaction`,
  - domain writes use `tenantManagerRepo`,
  - audit uses `AuditLogService.logWithManager`,
  - events use `OutboxPublisher.enqueue` to `farm.outbox_events`,
  - domain row, audit row, projection refresh, and outbox row commit or roll back together.
- Apply to site, department, system, restore, site contacts, supplier approved sites, equipment, sub-equipment, feeder calibration, tanks, Sentinel settings, chemicals, feeds, feeding protocols, worker compatibility, and document metadata.
- Existing transaction-bound site-contact, supplier-site, and non-tank equipment paths may be retained, but must converge on the same tenant transaction/audit/outbox contract.
- Initial Phase 3 setup hierarchy slice is implemented for site, site contacts, department, system create/update/delete, non-tank equipment create/update/delete, sub-equipment create/update/delete, supplier approved-site replacement, feeder calibration replacement, tank-like equipment compatibility, and tank create/update/status/delete flows:
  - handlers use `runInTenantTransaction(dataSource, 'farm', tenantId, ...)`,
  - tenant-owned writes use `tenantManagerRepo`,
  - audit uses fail-closed `AuditLogService.logWithManager`,
  - setup events are enqueued with `OutboxPublisher.enqueue` in the same transaction,
  - strict event schemas and gateway realtime bridge dispatch are wired for site, department, system, PII-free site contacts, equipment, sub-equipment, tank, supplier approved sites, and feeder calibration events,
  - tank code sequence increments use the caller's active tenant transaction manager so code allocation rolls back with aggregate/audit/outbox failures,
  - direct `NatsEventBus`/`eventBus.publish`, raw setup `QueryRunner`, and raw setup `@InjectRepository` write authority are removed from those business writes.

Exit gates:

- Static guardrails reject direct setup `eventBus.publish`, `NatsEventBus`, raw setup `createQueryRunner`, raw setup `dataSource.transaction`, raw setup repository manager transaction, and new raw setup `@InjectRepository` writes.
- Per-handler tests prove audit/outbox/domain rollback together.

### Phase 4 - Canonical Domain Cutovers

- Workers: HR `employees` is canonical. Farm worker APIs become HR-backed compatibility facades returning HR employee IDs. Direct `farm_workers` writes stop except migration bridge.
- Fish health: setup therapeutic substances read/write through Chemical master. Local mock CRUD is removed. `health_events` remains clinical history and may reference `chemicalId` with snapshots.
- Tanks: `tanks.id` is canonical for tank, pond, cage, and container identity. Equipment list may read-merge compatibility data; tank-like writes dispatch Tank commands.
- Documents: N/A for this remediation — the canonical `farm_documents` table was DROPPED as an unwired surface (ORPHAN-HIGH-369; migration `1805300000000-DropFarmDocuments.ts`). The remaining chemical/feed JSONB document metadata and path-based presign/delete are tracked separately for an owner re-decision and do not gate FARM-HIGH-003.
- Legacy `farms/ponds`: read-only compatibility only until backfill, runtime zero-use, test updates, and restore rehearsal pass.

Exit gates:

- No new writes to duplicate stores.
- Compatibility APIs return canonical IDs or an explicit legacy mapping.
- Retired surfaces have static reintroduction guards.

### Phase 5 - Frontend And API Replacement

- Keep `/sites/*` in `farm-module`.
- Normalize `/sites/setup` to `/sites/setup/sites` and update shell/map links to canonical tab routes.
- Move setup GraphQL operations into `web/modules/farm-module/src/graphql/**`.
- Consume generated operations and generated input/result types from hooks.
- Remove raw operation strings, hand-written API DTOs, and unsafe setup DTO casts from hooks/pages.
- Keep UI draft form models UI-only and map them through typed mappers.
- Fix tenant query invalidation to match `['tenant', tenantId, ...]`.
- Gate setup actions by the backend permission matrix.
- Replace hand-rolled modals and browser `alert`/`confirm` with shared modal, toast, i18n, and accessibility patterns.

Exit gates:

- `npm run codegen:check` passes.
- Farm-module tests cover route normalization, permissions, tenant cache invalidation, modal accessibility, and i18n.
- No raw setup GraphQL remains in hooks/pages.

### Phase 6 - Backfill, Conflicts, Compatibility

- Build a new idempotent dry-run/execute migration CLI; no current legacy farm/pond backfill CLI or conflict ledger exists.
- Add durable mapping and conflict artifacts for worker-to-HR, farm-to-site, pond-to-tank, document migration, duplicate names/codes, duplicate worker email/employeeNumber, orphan `pondId`, invalid URLs, duplicate document paths, multiple primary contacts, supplier-site conflicts, and unmappable references.
- Use objective compatibility exit gates: zero legacy writes, rowcount reconciliation, zero or signed-off unresolved conflicts, accepted schema diff, consumer sign-off, release notes, and runbook updates.
- Do not add compatibility views unless schema bootstrap and schema manager gain an explicit view ownership model.

Exit gates:

- Old rows equal new rows plus documented conflicts.
- No silent merge.
- No destructive action before snapshot and restore rehearsal.

### Phase 7 - Canary, Removal, Closure

- Add tenant allowlist or feature flags for worker path, canonical documents, fish-health chemical view, tank write path, route behavior, and legacy read compatibility.
- Canary internal, high-volume, newly provisioned, and intentionally drifted tenants.
- Track setup mutation success/conflict metrics, outbox lag, orphan upload growth, schema/ledger drift, realtime bridge delivery, and cross-tenant denial.
- Remove old resolvers, handlers, entities, imports, fields, and tables only after gates pass.

Exit gates:

- Zero runtime usage for the agreed window.
- No non-migration code references.
- Tenant clone, bootstrap, and factory-reset parity pass.
- GraphQL schema diff is published.
- Restore rehearsal succeeds.
- Release notes and runbook are updated.
- Registry finding is closed with a valid `Closes:` trailer.

## Public Interfaces And Contracts

- WITHDRAWN (ORPHAN-HIGH-369): the planned canonical `farm_documents` aggregate (states `PENDING_UPLOAD`, `UPLOADED_UNVERIFIED`, `ACTIVE`, `QUARANTINED`, `DELETE_PENDING`, `DELETED`) was dropped rather than adopted. No document-state contract ships under FARM-HIGH-003.
- Any future documentId-based presign/delete/upload contract (resolve by `documentId`, tenant, owner row, permission, scan state, retention, legal hold) belongs to a NEW finding, since `farm_documents` no longer exists.
- Add or complete setup event interfaces and JSON schemas for tank, sub-equipment, feeder calibration, chemical/document, feed/document/protocol, worker compatibility, Sentinel settings, and existing site/department/system/equipment events.
- Events must include payload-level `aggregateId` and `aggregateType`.
- Event schemas must use strict validation, bounded free text, UUID validation, and must not expose secrets or unnecessary PII.
- Sentinel events must never include client secrets or decrypted credentials.
- Gateway realtime bridge and frontend invalidation include the migrated setup events for site changes, PII-free site contacts, department/system/equipment/sub-equipment/tank changes, supplier approved sites, and feeder calibration. Canonical document changes remain gated on the `farm_documents` API/write-path slice.

## Test Gates

Core:

- `npm run format:check`
- `npm run type-check`
- `npm run lint`
- `npm run test`
- `npm run build:all`

Contracts and docs:

- `npm run findings:verify`
- `npm run codegen:check`
- `npm run gates:graphql-contracts`

Database and schema:

- `npm run gates:schema-drift-registration`
- `npm run gates:migration-sql`
- `npm run gates:entity-diff-witness -- --diff-base origin/main`
- `npm run gates:migration-deletion-witness`
- `npm run test:bootstrap`
- `npm run test:tenant-clone`
- `npm run test:schema-invariants`

Static invariants:

- No direct setup `eventBus.publish`.
- No raw setup transaction or query runner.
- No writable JSONB document authority.
- No path-based presign/delete.
- No setup raw GraphQL in hooks/pages.
- No retired table/entity/API references after removal.

E2E and security:

- Every setup tab create/update/delete/list/search writes only the current tenant schema.
- Tenant A cannot read or mutate Tenant B.
- Audit/outbox/domain writes roll back together.
- Document IDOR, legal-hold, retention, and scan-state tests pass.
- Frontend route, permission, cache invalidation, modal/a11y, and i18n tests pass.

## Assumptions

- Audit is mandatory and fail-closed for setup business writes.
- New writes route to the canonical aggregate immediately once that path exists.
- `farm.outbox_events` is the canonical outbox target for new setup writes.
- Existing dirty worktree changes are user-owned and must not be reverted by this remediation.
