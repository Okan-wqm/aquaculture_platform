# Platform Source Schema Boundary

Date: 2026-04-29

## Problem
Tenant-owned business data must not be stored in shared/source schemas. This applies to farm/site/setup, HR, sensor, AI, messaging, and any other schema-per-tenant service. A tenant's business rows must live in that tenant's physical schema so tenant isolation is enforced by schema routing, not only by a `tenantId` column.

## Current Architecture Observed
The codebase uses source schemas such as `farm`, `hr`, and `sensor` as template/source schemas. `MODULE_SCHEMAS` declares each module's source schema and table ownership. Tenant provisioning copies module tables from the source schema into each `tenant_<uuid16>` schema. `SourceSchemaWriteGuardService` installs database triggers to block writes to protected source tables, and farm has strict ownership enforcement for orphan tables.

For farm-service specifically:

- `farm` is the source/template schema for table shape, reference data, migrations metadata, and `farm_outbox`.
- Tenant business data must be in `tenant_<uuid16>` schemas.
- Reference tables such as `equipment_types` may exist in source to seed tenant schemas.
- Infrastructure tables such as `farm_outbox` currently remain in source and carry tenant-stamped event payloads.

## Enterprise Position
The source schema is not a tenant data schema. It may exist as a bootstrap/template/infrastructure boundary only. Any tenant business row in source schema tables is a P0 isolation violation.

Infrastructure outbox tables are a separate platform architecture concern. They are currently shared queues partitioned by tenantId in source schemas. Because this pattern is used across services, moving outbox tables per-tenant must be handled as a platform migration, not as a local farm-service patch.

## Why This Note Was Written
During farm-service stock-operation work, the user clarified that tenant business data must be inside tenant-owned schemas and not stored in shared farm/hr/sensor tables. This note records that invariant explicitly so future fixes do not normalize shared-table tenant storage as acceptable.

## Verification Added
`apps/farm-service/src/__tests__/e2e/mortality-cull-harvest-tenant-isolation.postgres.spec.ts` now asserts that tenant business rows for stock operations are in the tenant schema and absent from the `farm` source schema.

## Status
Invariant documented on 2026-04-29. Farm stock-operation enforcement is implemented and verified. Platform-wide outbox/source-boundary migration remains a separate architectural work item.
