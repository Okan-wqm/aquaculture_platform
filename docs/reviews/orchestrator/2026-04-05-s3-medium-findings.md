# S3 MEDIUM Findings Report -- Remaining Issues After S1-S4 Fixes

**Date:** 2026-04-05
**Scope:** 138 MEDIUM findings from 2026-04-04 deep audit, filtered for remaining unfixed items
**Method:** Direct source code verification of each finding area. Prior fix reports cross-referenced.
**Classification:** INTERNAL

---

## Executive Summary

The 2026-04-04 deep audit identified 138 MEDIUM findings across 13 domain agents. Sprint S1-S4 fixes addressed approximately 30 MEDIUM items (mostly as side effects of CRITICAL/HIGH fixes). **67 distinct MEDIUM findings remain open**, organized below by the 9 requested focus areas. Severity is ranked by estimated CVSS 3.1 score within each category.

| Focus Area | Open MEDIUMs | Highest CVSS |
|-----------|-------------|-------------|
| Migration schema interpolation | 5 | 3.7 |
| GraphQL introspection in production | 1 | 3.5 |
| NATS internal TLS absence | 3 | 4.6 |
| Rate limit guard bypass vectors | 2 | 4.3 |
| Redundant DB indexes | 4 | 2.0 |
| console.log in migrations | 2 | 2.0 |
| GDPR compliance gaps | 3 | 4.0 |
| Frontend dependency audit | 4 | 4.3 |
| Edge crate audit | 4 | 4.8 |
| Cross-cutting (other agents) | 39 | varies |
| **Total remaining** | **67** | |

---

## 1. Migration Schema Interpolation (5 open)

### M-MIG-01 -- WeatherTables migration: schema_name interpolated without assertSafeSchemaName
**CVSS:** 3.7 (AV:N/AC:H/PR:H/UI:N/S:U/C:L/I:L/A:N)
**File:** `/var/aqua-saas/apps/farm-service/src/database/migrations/1773000000000-AddWeatherTables.ts`
**Lines:** 122-156 (up), 153-157 (down)
**Status:** NOT FIXED

**Problem:** The `up()` method iterates `information_schema.schemata` and interpolates `schema_name` directly into SQL:
```
CREATE TABLE IF NOT EXISTS "${schema_name}"."weather_observations" ...
```
No `assertSafeSchemaName(schema_name)` call before interpolation. The `down()` method has the same gap at lines 153-157. The newer migrations (AddRegulatorySettings, AddFeederCalibrations, AddPurchaseOrders) all correctly call `assertSafeSchemaName()` before SQL interpolation -- this migration was written before that pattern was established and was never retrofitted.

**Fix:** Add `import { assertSafeSchemaName } from '@aquaculture/backend-common';` and call `assertSafeSchemaName(schema_name)` before each interpolation in both `up()` and `down()`.

---

### M-MIG-02 -- AddAiPersonaColumns migration: schema from current_schema() interpolated without validation
**CVSS:** 3.7 (AV:N/AC:H/PR:H/UI:N/S:U/C:L/I:L/A:N)
**File:** `/var/aqua-saas/apps/messaging-service/src/migrations/1711800000002-AddAiPersonaColumns.ts`
**Lines:** 21-41 (up), 44-62 (down)
**Status:** NOT FIXED

**Problem:** `const schema = rows[0]!.current_schema;` is read from `SELECT current_schema()` and then interpolated directly into 6 SQL statements without any validation. While `current_schema()` is a trusted PostgreSQL function, the platform's defense-in-depth standard (established in the security-reviewer MEDIUM-002 finding) requires `assertSafeSchemaName()` before any SQL identifier interpolation.

**Fix:** Add `assertSafeSchemaName(schema)` after line 21, before the first SQL statement.

---

### M-MIG-03 -- CreateMessagingTables migration: no schema validation
**CVSS:** 3.5 (AV:N/AC:H/PR:H/UI:N/S:U/C:L/I:N/A:N)
**File:** `/var/aqua-saas/apps/messaging-service/src/migrations/1711800000000-CreateMessagingTables.ts`
**Lines:** 25-30
**Status:** NOT FIXED

**Problem:** Uses hardcoded `SET search_path TO "messaging", "public"` which is safe, but the migration does not import or use `assertSafeSchemaName`. If this migration is ever extended to iterate tenant schemas (as the farm-service migrations do), the pattern would be missing.

**Fix:** Low priority. Add defensive import for future-proofing.

---

### M-MIG-04 -- CreateComplianceTables migration: same pattern as M-MIG-03
**CVSS:** 3.5
**File:** `/var/aqua-saas/apps/messaging-service/src/migrations/1711800000003-CreateComplianceTables.ts`
**Status:** NOT FIXED -- same category as M-MIG-03.

---

### M-MIG-05 -- HR CreateSchedulingTables migration: no assertSafeSchemaName used
**CVSS:** 3.0 (AV:N/AC:H/PR:H/UI:N/S:U/C:N/I:L/A:N)
**File:** `/var/aqua-saas/apps/hr-service/src/database/migrations/1769500000000-CreateSchedulingTables.ts`
**Lines:** all
**Status:** NOT FIXED

**Problem:** Uses hardcoded `hr` schema references (`"hr"."scheduling_settings"`, etc.) which are safe. No tenant schema iteration. Lower risk than M-MIG-01/02 because no dynamic schema interpolation exists. Included for completeness.

---

## 2. GraphQL Introspection in Production (1 open, reduced severity)

### M-GQL-01 -- Gateway introspection can be re-enabled via GRAPHQL_INTROSPECTION env var
**CVSS:** 3.5 (AV:N/AC:L/PR:H/UI:N/S:U/C:L/I:N/A:N)
**File:** `/var/aqua-saas/apps/gateway-api/src/app.module.ts`
**Lines:** 407-408
**Status:** PARTIALLY FIXED -- introspection is off by default in production

**Problem:** The gateway introspection config reads:
```typescript
introspection: configService.get('GRAPHQL_INTROSPECTION', 'false') === 'true' ||
  configService.get('NODE_ENV') !== 'production',
```
In production with `NODE_ENV=production`, introspection defaults to `false`. However, setting `GRAPHQL_INTROSPECTION=true` in the environment overrides this. This is an intentional escape hatch for debugging but there is no audit log entry or startup warning when introspection is force-enabled in production. An operator or a CI misconfiguration could enable it without visibility.

All 10 subgraph services correctly disable introspection in production using `!isProduction` or `NODE_ENV !== 'production'` checks. The billing-service uses `introspection: false` unconditionally (hardcoded off). The risk is limited to the gateway.

**Fix:** Add a startup warning in `onModuleInit` when `GRAPHQL_INTROSPECTION=true` and `NODE_ENV=production`:
```typescript
if (introspectionEnabled && isProduction) {
  this.logger.warn('SECURITY: GraphQL introspection FORCE-ENABLED in production via GRAPHQL_INTROSPECTION env var');
}
```

---

## 3. NATS Internal TLS Absence (3 open)

### M-NATS-01 -- All production services connect to NATS over plaintext
**CVSS:** 4.6 (AV:A/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N)
**Files:**
- `/var/aqua-saas/docker-compose.droplet.yml` -- 16 services with `NATS_URL: nats://nats:4222`
- `/var/aqua-saas/docker-compose.prod.yml` -- 9 services with `NATS_URL: nats://nats:4222`
- `/var/aqua-saas/infrastructure/docker/docker-compose.prod.yml` -- 9 services with `NATS_URL: nats://nats:4222`
**Status:** NOT FIXED

**Problem:** All compose files use `nats://` (plaintext). TLS-capable config files exist at `infrastructure/docker/nats/nats-tls-enabled.conf` but are not mounted in any production compose file. `NATS_TLS_ENABLED` is not set anywhere. The `NatsEventBus` constructor reads TLS config from env but finds nothing. Inter-service NATS traffic carrying tenant events (including PII in UserCreated, financial data in SubscriptionUpdated) travels unencrypted within the Docker bridge network. A container escape enables passive sniffing of all event data.

**Fix:** Mount `nats-tls-enabled.conf`, generate internal CA certs, set `NATS_TLS_ENABLED=true` and `NATS_URL=tls://nats:4222` on all services.

---

### M-NATS-02 -- Redis connections use plaintext in production Docker path
**CVSS:** 4.0 (AV:A/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N)
**File:** `/var/aqua-saas/docker-compose.droplet.yml` line 143
**Status:** NOT FIXED

**Problem:** Redis uses `redis://` URLs (plaintext). No `rediss://` (TLS) URLs in any compose file. Redis carries session tokens, rate limit state, and cached tenant data.

**Fix:** Configure Redis TLS (`--tls-port 6380 --tls-cert-file ... --tls-key-file ...`) and update all `REDIS_URL` to `rediss://`.

---

### M-NATS-03 -- PostgreSQL connections lack sslmode in production Docker path
**CVSS:** 4.0 (AV:A/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N)
**File:** `/var/aqua-saas/docker-compose.droplet.yml` -- all `DATABASE_URL` entries
**Status:** NOT FIXED

**Problem:** All `DATABASE_URL` values use `postgres://...@postgres:5432/...` without `?sslmode=require`. PostgreSQL traffic including SQL queries and results travels unencrypted.

**Fix:** Append `?sslmode=require` to all `DATABASE_URL` entries. Enable SSL in PostgreSQL config.

---

## 4. Rate Limit Guard Bypass Vectors (2 open)

### M-RL-01 -- RateLimitGuard uses in-memory store by default (multi-instance bypass)
**CVSS:** 4.3 (AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N)
**File:** `/var/aqua-saas/apps/gateway-api/src/guards/rate-limit.guard.ts`
**Lines:** 217, 236
**Status:** NOT FIXED

**Problem:** `RATE_LIMIT_USE_REDIS` defaults to `false` (line 217). When Redis is not configured (which appears to be the current production state based on compose files having no explicit `RATE_LIMIT_USE_REDIS=true`), the `InMemoryRateLimitStore` is used. In a multi-instance deployment (K8s with 2+ gateway replicas or a rolling deploy window), each instance maintains its own counter map. An attacker can distribute requests across instances, effectively multiplying the rate limit by the number of instances.

The guard does fail-closed when Redis is configured but unhealthy (line 266-274), which is correct. The issue is the default path with no Redis.

**Fix:** Set `RATE_LIMIT_USE_REDIS=true` in `docker-compose.droplet.yml` and `docker-compose.prod.yml` for the gateway service. The `RedisRateLimitStore` is already registered as a provider in `app.module.ts` (line 627-628).

---

### M-RL-02 -- Endpoint prefix matching in rate limit key is substring-based
**CVSS:** 3.1 (AV:N/AC:H/PR:L/UI:N/S:U/C:N/I:L/A:N)
**File:** `/var/aqua-saas/apps/gateway-api/src/guards/rate-limit.guard.ts`
**Lines:** 372-378
**Status:** NOT FIXED

**Problem:** The `generateKey()` method uses `url.includes('/login')` to classify requests into rate limit buckets. A GraphQL query with a custom alias or operation name containing `/login` in the path would be misclassified into the login bucket (5 req/15min instead of 100 req/min). While the gateway uses GraphQL and URLs are typically `/graphql`, REST endpoints exist at `/api/auth/login` which correctly match. The concern is that a future REST endpoint like `/api/users/login-history` would inherit the strict login rate limit unintentionally.

**Fix:** Use exact path matching or regex anchored to the end: `url === '/api/auth/login' || url.endsWith('/auth/login')`.

---

## 5. Redundant DB Indexes (4 open)

### M-IDX-01 -- storage_locations: standalone tenant_id index redundant with composite indexes
**CVSS:** 2.0 (AV:N/AC:H/PR:H/UI:N/S:U/C:N/I:N/A:L)
**File:** `/var/aqua-saas/apps/farm-service/src/database/migrations/1771000000000-AddStorageManagement.ts`
**Lines:** 57-60
**Status:** NOT FIXED

**Problem:** `IDX_storage_locations_tenant` indexes `(tenant_id)`. Two other indexes exist: `IDX_storage_locations_tenant_code` on `(tenant_id, code)` UNIQUE and `IDX_storage_locations_type` on `(tenant_id, type)`. The composite indexes with `tenant_id` as the leading column already serve any query that would use the standalone `tenant_id` index. The standalone index is redundant, wastes disk space, and adds write overhead.

**Fix:** Remove `CREATE INDEX "IDX_storage_locations_tenant"`. The UNIQUE index `IDX_storage_locations_tenant_code` covers `WHERE tenant_id = ?` queries.

---

### M-IDX-02 -- consumables: standalone tenant_id index redundant with composite indexes
**CVSS:** 2.0
**File:** `/var/aqua-saas/apps/farm-service/src/database/migrations/1771000000000-AddStorageManagement.ts`
**Line:** 105
**Status:** NOT FIXED

**Problem:** Same pattern as M-IDX-01. `IDX_consumables_tenant` on `(tenant_id)` is redundant because `IDX_consumables_tenant_code` UNIQUE on `(tenant_id, code)` already covers it. Three additional composite indexes also use `tenant_id` as leading column.

**Fix:** Remove `IDX_consumables_tenant`.

---

### M-IDX-03 -- storage_inventory: standalone tenant_id index redundant
**CVSS:** 2.0
**File:** `/var/aqua-saas/apps/farm-service/src/database/migrations/1771000000000-AddStorageManagement.ts`
**Line:** 139
**Status:** NOT FIXED

**Problem:** `IDX_storage_inventory_tenant` on `(tenant_id)` is redundant with `IDX_storage_inventory_unique` UNIQUE on `(tenant_id, storage_location_id, item_type, item_id, COALESCE(lot_number,''))`.

**Fix:** Remove `IDX_storage_inventory_tenant`.

---

### M-IDX-04 -- stock_movements: standalone tenant_id index redundant
**CVSS:** 2.0
**File:** `/var/aqua-saas/apps/farm-service/src/database/migrations/1771000000000-AddStorageManagement.ts`
**Line:** 172
**Status:** NOT FIXED

**Problem:** `IDX_stock_movements_tenant` on `(tenant_id)` is redundant with `IDX_stock_movements_type` on `(tenant_id, movement_type)`.

**Fix:** Remove `IDX_stock_movements_tenant`.

---

## 6. console.log in Migrations (2 open)

### M-LOG-01 -- HR CreateSchedulingTables: 6 console.log statements
**CVSS:** 2.0 (AV:N/AC:H/PR:H/UI:N/S:U/C:L/I:N/A:N)
**File:** `/var/aqua-saas/apps/hr-service/src/database/migrations/1769500000000-CreateSchedulingTables.ts`
**Lines:** 26, 66, 108, 158, 209, 227
**Status:** NOT FIXED

**Problem:** 6 `console.log()` calls in a production migration file. The `MigrationLogger` utility exists at `libs/backend-common/src/database/migration-logger.ts` and is used by all farm-service migrations (AddRegulatorySettings, AddPurchaseOrders, AddWeatherTables, AddFeederCalibrations, AddStorageManagement). The HR migration predates this utility and was never updated.

`console.log` in migrations bypasses structured logging, making migration execution invisible to log aggregation (ELK/Loki). In production, TypeORM migration output goes to stdout which may not be captured if the container log driver is configured for structured JSON only.

**Fix:** Replace `console.log(...)` with `this.logger.log(...)` after adding `private readonly logger = new MigrationLogger('CreateSchedulingTables1769500000000');`.

---

### M-LOG-02 -- Messaging migrations: no structured logging
**CVSS:** 1.5
**Files:**
- `/var/aqua-saas/apps/messaging-service/src/migrations/1711800000000-CreateMessagingTables.ts`
- `/var/aqua-saas/apps/messaging-service/src/migrations/1711800000001-CreateAITables.ts`
- `/var/aqua-saas/apps/messaging-service/src/migrations/1711800000002-AddAiPersonaColumns.ts`
- `/var/aqua-saas/apps/messaging-service/src/migrations/1711800000003-CreateComplianceTables.ts`
**Status:** NOT FIXED

**Problem:** Messaging migrations have no logging at all (no console.log, no MigrationLogger). They execute silently. If a migration fails partway through, there is no logged progress indicator to help diagnose which step failed.

**Fix:** Add `MigrationLogger` to each migration file.

---

## 7. GDPR Compliance Gaps (3 open)

### M-GDPR-01 -- GDPR erasure does not publish UserDeleted NATS event from GdprComplianceService
**CVSS:** 4.0 (AV:N/AC:L/PR:H/UI:N/S:U/C:L/I:L/A:N)
**File:** `/var/aqua-saas/apps/auth-service/src/privacy/gdpr-compliance.service.ts`
**Lines:** 56-99
**Status:** PARTIALLY FIXED (file is no longer empty -- it has erasure + export)

**Problem:** The `GdprComplianceService.executeErasure()` method anonymizes the user account and revokes tokens (correctly implemented). However, it does NOT publish a `UserDeleted` NATS event after erasure. Cross-service GDPR erasure depends on each service receiving this event to anonymize their own data (messages, HR records, sensor ownership). Without the event, only the auth-layer data is anonymized -- other services retain the user's PII.

The comment at line 24-25 acknowledges this: "Cross-service GDPR operations (messages, HR records, sensor data) are handled by each service when they receive the UserDeleted NATS event from auth-service." But the event is never published from this service.

**Fix:** Inject `NatsEventBus` and publish `UserDeletedEvent` with `{ userId, tenantId, deletedAt, reason: 'GDPR_ERASURE' }` after successful transaction commit.

---

### M-GDPR-02 -- GDPR export incomplete: no consent history or login history
**CVSS:** 3.5 (AV:N/AC:L/PR:H/UI:N/S:U/C:L/I:N/A:N)
**File:** `/var/aqua-saas/apps/auth-service/src/privacy/gdpr-compliance.service.ts`
**Lines:** 107-128
**Status:** PARTIALLY FIXED

**Problem:** `exportUserData()` returns userId, email, createdAt, lastLoginAt, activeRefreshTokenCount, and role. GDPR Article 15 requires export of ALL personal data processed, including:
1. Consent records (which consent checkboxes were accepted, when)
2. Login history (IP addresses, user agents, timestamps)
3. MFA configuration status (not the secrets, but that MFA is registered)
4. Account modification history (email changes, password changes)

The `lastLoginAt` field is accessed via `(user as unknown as { lastLoginAt?: Date }).lastLoginAt` (line 124), indicating the User entity's type definition is incomplete.

**Fix:** Expand the export to include consent records from `GdprModule`, login audit entries from `AuditLogService`, and MFA registration status from `WebAuthnService`.

---

### M-GDPR-03 -- GDPR erasure does not clear WebAuthn credentials
**CVSS:** 3.5
**File:** `/var/aqua-saas/apps/auth-service/src/privacy/gdpr-compliance.service.ts`
**Lines:** 56-99
**Status:** NOT FIXED

**Problem:** `executeErasure()` revokes refresh tokens and anonymizes the user, but does not delete WebAuthn credentials (passkeys/security keys). WebAuthn credentials contain a `credentialPublicKey` which, while not PII in isolation, is linked to a physical device owned by the user. Under strict GDPR interpretation, the credential record constitutes personal data (it can identify a device belonging to a natural person). The `WebAuthnService` stores these in-memory (`challenges` Map) and presumably in a database table.

**Fix:** Add `await this.webAuthnService.deleteAllCredentials(userId)` to the erasure transaction.

---

## 8. Frontend Dependency Audit (4 open)

### M-FE-01 -- SRI hash-pinning for remote MFE entries not implemented in CI
**CVSS:** 4.3 (AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:N)
**File:** `/var/aqua-saas/web/shell/src/utils/remoteIntegrity.ts`
**Lines:** 50-63 (empty REMOTE_HASH_PINS map)
**Status:** NOT FIXED

**Problem:** `REMOTE_HASH_PINS` is always empty because no CI pipeline step generates `web/shell/src/generated/remoteHashes.json`. The `try { require('./generated/remoteHashes.json') }` at line 62 catches the module-not-found error silently. In production, every MFE remote entry loads without SRI verification. The `installRemoteIntegrityGuard()` function fires `SRI_HASH_MISSING` custom events as monitoring output but does not block script execution.

A compromised CDN or MITM could serve a modified `remoteEntry.js` for any MFE module (dashboard, farm-module, hr-module, sensor-module, admin-panel, tenant-admin, hydroponics-module) without detection.

**Fix:** Add a `generate-sri-hashes` CI step after frontend builds, writing hashes to `remoteHashes.json`. The TODO at lines 53-58 documents the exact commands needed.

---

### M-FE-02 -- package.json uses caret ranges for shell dependencies
**CVSS:** 3.0 (AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:L/A:N)
**File:** `/var/aqua-saas/web/shell/package.json`
**Lines:** 18-22
**Status:** PARTIALLY FIXED

**Problem:** `package.json` still uses caret ranges (`"react": "^18.2.0"`, `"@tanstack/react-query": "^5.17.0"`). However, the Module Federation `vite.config.ts` shared block has been updated with exact `requiredVersion` values (e.g., `requiredVersion: '18.3.1'`). The `package.json` ranges are resolved by the lockfile, so the actual installed version is deterministic. The remaining risk is that `npm install` without `--frozen-lockfile` could resolve a different version.

The vite.config.ts fix means MFE runtime version negotiation uses exact versions. The `package.json` caret ranges are a secondary concern.

**Fix:** Pin exact versions in `package.json` to match lockfile: `"react": "18.3.1"`, `"react-dom": "18.3.1"`, etc.

---

### M-FE-03 -- npm audit not run in CI-affected pipeline (only CI-full)
**CVSS:** 3.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:N)
**File:** `/var/aqua-saas/.github/workflows/ci-affected.yml`
**Status:** NOT FIXED

**Problem:** `npm audit --audit-level=high` runs only in `ci-full.yml` (line 250). The `ci-affected.yml` pipeline (triggered on every PR) does not run `npm audit`. A PR introducing a vulnerable dependency would pass CI-affected and only be caught on the next full CI run (which may be infrequent).

**Fix:** Add `npm audit --audit-level=high` step to `ci-affected.yml`.

---

### M-FE-04 -- Unpinned infrastructure images in non-droplet compose files
**CVSS:** 3.0
**Files:**
- `/var/aqua-saas/infrastructure/docker/docker-compose.prod.yml` lines 63, 80, 512 (redis:7-alpine, nats:2.10-alpine, nginx:alpine)
- `/var/aqua-saas/docker-compose.dev.yml` line 79 (minio/minio:latest)
**Status:** PARTIALLY FIXED

**Problem:** TimescaleDB images are now pinned to `2.17.2-pg16` in all compose files (confirmed). However, Redis, NATS, MinIO, and nginx still use mutable tags in non-droplet compose files. The `docker-compose.droplet.yml` (the actual production deployment) pins TimescaleDB but keeps `redis:7-alpine` (line 143). `nginx:alpine` appears only in `infrastructure/docker/docker-compose.prod.yml`.

**Fix:** Pin all infrastructure images to specific versions across all compose files: `redis:7.4.2-alpine`, `nats:2.10.24-alpine`, `nginx:1.27.4-alpine`, `quay.io/minio/minio:RELEASE.2025-01-20T15-46-22Z`.

---

## 9. Edge Crate Audit (4 open)

### M-EDGE-01 -- cargo audit is non-blocking in CI (|| echo)
**CVSS:** 4.8 (AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:L/A:L)
**File:** `/var/aqua-saas/.github/workflows/edge-agent-release.yml`
**Line:** 88
**Status:** NOT FIXED

**Problem:** The edge agent release workflow runs:
```
cargo audit || echo "::warning::Dependency audit found vulnerabilities"
```
The `|| echo` causes the step to always succeed, even when `cargo audit` finds known vulnerabilities. The `::warning::` annotation appears in the GitHub Actions UI but does NOT block the release. A release with known CVEs can be published to production edge devices.

Additionally, `cargo install cargo-audit --locked 2>/dev/null || true` (line 87) silently swallows installation failures.

**Fix:** Remove `|| echo "..."` so `cargo audit` exit code propagates. Use `cargo audit --deny warnings` for strict mode. Move audit to a separate required job so it blocks the release.

---

### M-EDGE-02 -- deny.toml advisory-db uses user-home-relative path
**CVSS:** 3.5 (AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:L/A:N)
**File:** `/var/aqua-saas/sens-api-gateway/deny.toml`
**Line:** 16
**Status:** NOT FIXED

**Problem:** `db-path = "~/.cargo/advisory-db"` resolves to the user's home directory. In CI environments (GitHub Actions runners), `~/.cargo` may not contain a pre-populated advisory database. The `cargo deny check` would use a stale or empty database, effectively disabling advisory checks. The `db-urls` field is set correctly but `cargo deny` must fetch first if the local db-path is empty.

**Fix:** Change to `db-path = "$CARGO_HOME/advisory-db"` or remove `db-path` entirely (cargo-deny will auto-fetch). Alternatively, add `cargo deny fetch` before `cargo deny check` in CI.

---

### M-EDGE-03 -- reqwest includes h2 feature (HTTP/2 attack surface)
**CVSS:** 3.0 (AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:L)
**File:** `/var/aqua-saas/sens-api-gateway/Cargo.toml`
**Line:** 27
**Status:** NOT FIXED

**Problem:** `reqwest` is declared with `default-features = false` and features `["json", "rustls-tls"]`, which should exclude `http2`. However, the `rustls-tls` feature may transitively enable `http2` depending on the reqwest version. The edge agent only makes outbound HTTPS calls to the cloud API which does not require HTTP/2. Including the h2 crate adds unnecessary attack surface (HTTP/2 RST flood vectors, even if primarily server-side).

**Fix:** Verify that `h2` is not in `Cargo.lock` after building with these features. If it is, add `http2 = false` to the reqwest feature list or use `rustls-tls-manual-roots` instead of `rustls-tls`.

---

### M-EDGE-04 -- rodbus 1.4 pinned with version-sensitive behavior dependency
**CVSS:** 2.5 (AV:N/AC:H/PR:H/UI:N/S:U/C:N/I:L/A:N)
**File:** `/var/aqua-saas/sens-api-gateway/Cargo.toml`
**Lines:** 66-67
**Status:** NOT FIXED (documented, not mitigated)

**Problem:** The comment at lines 61-66 documents BUG-005: the Modbus TLS path passes `Path::new("")` for client cert arguments, relying on rodbus 1.4's behavior of treating empty paths as "no client certificate." This is an undocumented API contract. A `cargo update` or minor version bump to rodbus 1.5 could break Modbus TLS connections silently. The pin `rodbus = "1.4"` uses a caret range (SemVer compat), so `cargo update` could pull 1.4.x patches that change this behavior.

**Fix:** Pin to exact version: `rodbus = "=1.4.0"`. Better: refactor the TLS code path to use the `None` variant for `client_cert` and `client_key` instead of empty paths, making the intent explicit rather than relying on library-specific behavior.

---

## 10. Cross-Cutting MEDIUM Findings (from other agents, summarized)

### In-Memory State (5 services, MEDIUM collectively)

| Service | File | State Type | Risk |
|---------|------|-----------|------|
| auth-service (WebAuthn) | `webauthn.service.ts:51` | `Map<string, StoredChallenge>` | Challenge store lost on restart; replay in multi-instance |
| auth-service (Token) | `token.service.ts:120` | `Map<string, {...}>` module cache | Cache inconsistency across instances |
| admin-api-service (Impersonation) | `impersonation.service.ts:71,75` | `Map<string, ImpersonationSession>`, `Map<string, rateLimit>` | Session tracking and rate limiting bypassed in multi-instance |
| ai-service (RateLimit) | `rate-limit.service.ts:12` | `Map<string, {count, resetAt}>` | AI rate limits bypassed across instances |
| ai-service (TokenBudget) | `token-budget.service.ts:14` | `Map<string, number>` | Token budget not shared; double-spending across instances |

**Status:** NOT FIXED. All 5 in-memory Maps remain. The gap-analysis flagged this as systemic.
**Fix:** Migrate to Redis-backed state using `TenantRedisService`. Prioritize ImpersonationService (security-critical), then WebAuthn (authentication), then AI rate limit + budget (cost control).

### Per-Service PG Roles Not Used (escalated from MEDIUM to HIGH by infra-expert)
**File:** All `docker-compose*.yml` -- services use superuser `POSTGRES_USER`
**Status:** NOT FIXED. Covered in infra-expert M-10 / H-05 finding.

### NATS Subjects Not Tenant-Scoped
**File:** `platform/libs/event-bus/src/nats/nats-event-bus.ts:276`
**Status:** NOT FIXED. Architectural change requiring coordinated migration. Covered in infra-expert M-15.

### CI continue-on-error Remaining Instances
**Files:**
- `.github/workflows/e2e-tests.yml:110`
- `.github/workflows/cd-production.yml:406`
- `.github/workflows/deploy-digitalocean.yml:665`
- `.github/workflows/security-trivy.yml:64`
- `.github/workflows/infra-terraform-drift.yml:133`
**Status:** PARTIALLY FIXED. `ci-affected.yml` is clean. 5 other workflow files retain `continue-on-error: true`.

### Platform Services MEDIUMs (from S2 report)
- M-01: `safeAdd`/`safeSubtract` not true decimal arithmetic (billing-service)
- M-02: Auto-invoice scheduler no distributed lock (billing-service)
- M-03: Webhook encryption key is mutable global (notification-service)
- M-04: Subscription EXPIRED/PAST_DUE transitions publish no NATS event (billing-service)

### Sensor Service MEDIUMs (from S2 report)
- MEDIUM-S2-001: OPC UA adapter `as any` casts (opcua.adapter.ts)
- MEDIUM-S2-002: automation.service.ts `as any` on deployCommand.params

### Admin Service MEDIUMs (from S2 report)
- H-S2-08 (MEDIUM): Schema controller missing ParseUUIDPipe on mutating routes

---

## Priority Matrix

### P1 -- Fix This Sprint (CVSS >= 4.0)

| ID | CVSS | Issue | Fix Effort |
|----|------|-------|-----------|
| M-NATS-01 | 4.6 | NATS plaintext in production | 2h (mount TLS config, update env vars) |
| M-EDGE-01 | 4.8 | cargo audit non-blocking | 15min (remove `\|\| echo`) |
| M-RL-01 | 4.3 | Rate limit in-memory default | 15min (set env var) |
| M-FE-01 | 4.3 | SRI hash-pinning missing | 2h (CI step) |
| M-GDPR-01 | 4.0 | Erasure missing UserDeleted event | 30min |
| M-NATS-02 | 4.0 | Redis plaintext | 1h |
| M-NATS-03 | 4.0 | PostgreSQL plaintext | 30min |

### P2 -- Fix Next Sprint (CVSS 3.0-3.9)

| ID | CVSS | Issue | Fix Effort |
|----|------|-------|-----------|
| M-MIG-01 | 3.7 | WeatherTables schema interpolation | 15min |
| M-MIG-02 | 3.7 | AiPersonaColumns schema interpolation | 15min |
| M-GQL-01 | 3.5 | Introspection override no audit log | 15min |
| M-EDGE-02 | 3.5 | deny.toml advisory-db path | 10min |
| M-FE-03 | 3.5 | npm audit not in ci-affected | 10min |
| M-GDPR-02 | 3.5 | Export incomplete | 2h |
| M-GDPR-03 | 3.5 | Erasure misses WebAuthn | 30min |
| M-RL-02 | 3.1 | Rate limit key substring match | 15min |
| M-EDGE-03 | 3.0 | reqwest h2 attack surface | 30min |
| M-FE-02 | 3.0 | package.json caret ranges | 15min |
| M-FE-04 | 3.0 | Unpinned infra images | 30min |

### P3 -- Backlog (CVSS < 3.0)

| ID | CVSS | Issue | Fix Effort |
|----|------|-------|-----------|
| M-EDGE-04 | 2.5 | rodbus version pin | 30min |
| M-IDX-01-04 | 2.0 | Redundant indexes (4 tables) | 15min each |
| M-LOG-01 | 2.0 | HR migration console.log | 15min |
| M-LOG-02 | 1.5 | Messaging migrations no logging | 30min |
| M-MIG-03 | 3.5 | CreateMessagingTables no schema validation | 10min |
| M-MIG-04 | 3.5 | CreateComplianceTables no schema validation | 10min |
| M-MIG-05 | 3.0 | HR migration no assertSafeSchemaName | 10min |

---

## Appendix: Fixed MEDIUMs (confirmed resolved in S1-S4)

| Finding | Status | Sprint |
|---------|--------|--------|
| CI continue-on-error in ci-affected.yml | FIXED | S1 |
| TimescaleDB image pinned (most compose files) | FIXED | S1 |
| CSP ws: in connect-src | FIXED | S1 |
| GDPR compliance service empty (auth-service) | FIXED (implemented) | S2 |
| MFE requiredVersion caret ranges | FIXED (exact versions in vite.config.ts) | S2 |
| VFD automation history not tenant-scoped | FIXED | S1 |
| MigrationLogger utility created | FIXED (utility exists) | S1 |
| CI permissions block in ci-affected.yml | FIXED (line 18) | S2 |
| billing-service DecimalTransformer | FIXED (75 entity files use it) | S1 |

---

*Report generated 2026-04-05 by orchestrator reviewing 138 MEDIUM findings against current codebase state.*
*9 focus areas systematically verified via direct source code inspection.*
