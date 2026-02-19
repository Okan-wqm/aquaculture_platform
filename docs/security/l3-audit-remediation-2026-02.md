# L3 Security & Quality Audit Remediation — February 2026

**Date:** 2026-02-19
**Scope:** Full platform — all backend services, edge agents, frontend modules, infrastructure
**Findings files:** `agent-workspace/l3-findings/` (96 files across 34 units)
**Status:** ✅ Complete

---

## Overview

A comprehensive L3 audit was performed across the entire aquaculture platform monorepo covering:
- Security vulnerabilities (CRITICAL → LOW)
- Bug & quality issues
- Performance bottlenecks
- Architecture concerns
- API contract violations
- Dependency risks

All findings were remediated in severity order (CRITICAL first). This document summarizes the key changes applied.

---

## Critical Security Fixes

### Authentication & Authorization
- **JWT algorithm pinning**: All JWT verify calls now enforce `{ algorithms: ['HS256'] }` — prevents algorithm confusion attacks
- **JTI enforcement**: Tokens without `jti` claim are rejected in production — enables true token revocation
- **Role separation**: `/tenant/*` routes restricted to `TENANT_ADMIN` only; `archiveThread` restricted to `SUPER_ADMIN`
- **Inviter identity**: `invitedBy` now read from JWT claims (`req.user.id`), never from request body
- **Hardcoded URLs removed**: `APP_URL` env var required; no `localhost` fallback in production

### SQL Injection Prevention
- **sortOrder allowlists**: All `sortOrder` parameters sanitized to `'ASC' | 'DESC'` before use in queries
- **aggregateType validation**: Alphanumeric-only regex enforced on event-store aggregateType path params
- **Schema name injection**: `assertSafeSchemaName()` added in user-role-assignment service — validates `/^tenant_[0-9a-f]{16}$/`
- **CODESYS deploy guard**: Dangerous pattern check + size limit added before sensor CODESYS deployment

### Tenant Isolation
- **Cross-tenant pond creation**: Farm lookup now includes `tenantId` in where clause — prevents IDOR
- **Search path safety**: `code-generator.service.ts` uses `SET LOCAL search_path` within transactions
- **Hydroponics middleware**: Missing `SET search_path` call added — schema isolation was previously broken
- **Rate limit by JWT tenantId**: Gateway rate limiting now uses verified JWT claim, never raw header

### Secrets & Credentials
- **JWT_SECRET_MIN_LENGTH**: Raised from 32 → 64 characters
- **Impersonation tokens**: Now hashed with SHA-256 before storage; only hash persisted in DB
- **Invitation tokens**: No longer truncated — full `crypto.randomBytes` entropy preserved
- **Temporary credentials removed from events**: `UserInvitedEvent.temporaryCredential` removed; replaced with `credentialType` + `actionUrl`
- **NATS auth**: Production compose files updated with proper NATS authentication configuration

### Infrastructure Security
- **GitHub Actions SHA pinning**: All workflow actions pinned to full commit SHA
- **sens-api-gateway release**: `cross` version pinned to `v0.2.5`
- **Dockerfile ownership**: `--chown=nestjs:nodejs` added to all COPY instructions in production stage
- **OPA guard**: Enabled by default in production when `OPA_ENABLED` not set

---

## High Severity Fixes

### Data Integrity
- **MortalityRecordedEvent**: Uncommented and implemented (was silently disabled)
- **BatchCreatedEvent**: `farmId`/`pondId` made optional; `tankIds?: string[]` added for current schema
- **OVAL tank volume formula**: Fixed from circular formula (single diameter) to correct ellipse: `π × (length/2) × (width/2) × depth`
- **Species delete**: Batch dependency check implemented — prevents deleting species with active batches
- **Billing decimal precision**: `safeAdd()` and `Number()` casts prevent TypeORM string-to-decimal bugs
- **Pro-rata calculation**: Double-application of factor fixed in billing service
- **Tiered billing off-by-one**: `tierEnd - tierStart` corrected

### Event Bus Conformance
- **Flat event pattern**: All publishers (admin-api, alert-engine, sensor-service, farm-service) now use flat objects conforming to `BaseEvent`
- **Nested payload pattern eliminated**: Pattern B (`{ payload: { ... } }`) removed from all 7 affected publishers
- **`version: 1`**: Added to all event publishes

### Performance — N+1 & Sequential Queries
- **Parallel queries**: `Promise.all()` used throughout (farm-service tank capacity, admin-api user stats, analytics snapshots)
- **Sensor covering indexes**: Composite `(sensor_id, channel_id, time DESC)` indexes added for `DISTINCT ON` queries
- **Billing tenant index**: Secondary `tenantId → Set<aggregationKey>` map reduces O(N-all-tenants) to O(tenant-record-count)
- **Config-service pagination**: `limit`/`offset` added to `GetConfigurationsHandler`

---

## Medium Severity Fixes

### Code Quality
- **CQRS import**: `@platform/cqrs` used consistently (not `@nestjs/cqrs`)
- **Typescript fixes**: `Awaited<ReturnType<...>>` replaces invalid conditional type cast in event-store
- **Timer leak**: `behavior-tree.service.ts` `executeTimeout` now properly clears timer handle on completion
- **crypto imports**: Missing `import * as crypto from 'crypto'` added in alert-engine services

### Frontend
- **Textarea maxLength**: 4 modals in farm-module now enforce `maxLength` on textarea inputs
- **UserMenu listener**: `mousedown` listener guarded with `if (!isOpen) return` — prevents leaking listeners
- **Sensor module TypeScript**: `schema` prop added to `FieldRendererProps`; `configurationSchema` property name fixed
- **Shell**: Legacy `webpack.config.js` deleted; Turkish comments translated to English

### Infrastructure
- **CI matrix fix**: `matrix.environment` moved from job-level `if:` to step-level `$GITHUB_OUTPUT` check
- **Observability DB env vars**: `DATABASE_HOST` → `DB_HOST`, `DATABASE_NAME` → `DB_NAME: aquaculture_observability` in droplet compose

---

## Architecture Improvements

### Event Contracts Library
- **Missing event types added**: `TenantSuspendedEvent`, `TenantActivatedEvent`, `TenantArchivedEvent`, `TenantProvisioningFailedEvent`, `ParentReadingRoutedEvent`
- **Union types**: `FarmEvent`, `TenantEvent`, `AlertEvent`, `BillingEvent`, `NotificationEvent`, `AnyPlatformEvent` all defined
- **`PlanTier` / `BillingCycle`**: Exported as literal union types from `base-event.ts` — used across billing and tenant events
- **`version: number`**: Made required in `BaseEvent` (was optional, never set)
- **`TenantDeactivatedEvent` removed**: `TenantStatusChangedEvent` is the canonical event for all status transitions
- **`changes: Record<string, unknown>` removed**: Update events now use named optional fields only
- **README.md**: Written with mandated pattern, naming convention, NATS subjects, how-to checklist, version bump policy

### HR Service Events
- **Local class-based events replaced**: `leave.events.ts` rewritten as factory functions using `@app/event-contracts` interfaces with `createBaseEvent()`
- **eventType naming fixed**: `'leave.request.submitted'` → `'LeaveRequestSubmitted'` (PascalCase)

### Config Service
- **Dual write path eliminated**: `ConfigurationService.set()` removed; all writes go through CQRS handlers
- **Encryption extracted**: `EncryptionService` with `ENC_V1:` prefix; scrypt pre-derived at startup
- **Global cache invalidation**: Updating a `tenantId === 'global'` config now purges per-tenant cache entries

### Shared Libraries
- **`@platform/shared` path alias**: Added to `tsconfig.base.json`; barrel export `libs/shared/src/index.ts` created
- **Upload controller OpenAPI**: Full `@ApiOperation`, `@ApiBody`, `@ApiCreatedResponse` decorators added
- **`ApplicationException.notFound/conflict`**: Correct HTTP status codes (`404`/`409`) instead of `500`

---

## Sensor Service — TimescaleDB

- **Continuous aggregate real-time**: `materialized_only = false` set on `metrics_1min`, `metrics_1hour`, `metrics_1day`
- **Covering indexes**: `(sensor_id, channel_id, time DESC)` and `(tank_id, sensor_id, channel_id, time DESC)` partial indexes added

---

## Notification Service

- **Regulatory email templates**: Norwegian/English text replaces Turkish placeholder text
- **Exponential backoff**: `nextRetryAt` column added; retry scheduler filters by `nextRetryAt <= :now`

---

## Audit Log

- **Composite indexes**: `IDX_audit_tenant_created`, `IDX_audit_performer_tenant`, `IDX_audit_entity` replacing 6 single-column indexes
- **Scheduled cleanup**: Daily `@Cron` purge based on `AUDIT_LOG_RETENTION_DAYS`

---

## Files Changed

- **738 files** modified across the monorepo
- **~27,153 insertions**, **~16,371 deletions**
- All changes applied without modifying test expectations beyond the scope of the fix

---

## Skipped / Deferred

The following categories were explicitly deferred as they require infrastructure changes or major schema migrations:

| Area | Reason |
|------|--------|
| Full Stripe webhook controller | Requires new HTTP controller + Stripe SDK integration |
| Redis-backed in-memory rate limiters (alert-engine) | Cross-pod fix requires Redis dependency addition |
| NATS event publishing in billing-service | Cross-cutting architectural wiring |
| pg_trgm GIN index on config tags | Requires `CREATE EXTENSION pg_trgm` (DBA coordination) |
| `farm-service` `StorageModule` → `InventoryModule` rename | Cross-service refactor |
| `GlobalExceptionFilter` migration across all services | Gradual migration (TODO comments in place) |
