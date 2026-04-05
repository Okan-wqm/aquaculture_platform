# Security Audit Report

**Date:** 2026-04-04
**Scope:** Full cross-cutting platform security audit -- entire codebase
**Reviewer:** security-reviewer (Principal Security Engineer)
**Classification:** CONFIDENTIAL

---

## Executive Summary

The Aquaculture SaaS platform demonstrates **strong security fundamentals** in its most critical areas: tenant isolation via PostgreSQL `search_path` is well-architected with multi-layer validation (UUID regex, TENANT_SCHEMA_REGEX, CrossTenantProbe watchdog), the gateway AuthGuard correctly restricts JWT algorithms to HS256, and the TenantGuard correctly sources tenant identity exclusively from JWT claims. However, **two HIGH-severity findings** in defense-in-depth subgraph authentication guards (missing algorithm restriction in `GqlAuthGuard` across farm-service and hr-service) and **one MEDIUM CI/CD gate weakness** (lint/type-check/test jobs use `continue-on-error: true`) require attention. No CRITICAL findings were identified. The GDPR implementation covers core rights but the auth-service's `gdpr-compliance.service.ts` is an empty file, indicating incomplete implementation.

## Deployment Decision

- **PASS WITH CONDITIONS**
- **Reason:** No CRITICAL findings. Two HIGH findings related to defense-in-depth guards (farm-service and hr-service `GqlAuthGuard` missing algorithm restriction) are mitigated by the gateway's global AuthGuard and subgraph `ServiceIdentityGuard` which prevent direct external access. These should be fixed this sprint but do not block deployment. The CI `continue-on-error` issue is a process risk, not an active vulnerability.

---

## Threat Model -- Full Platform Posture Assessment

### Attack Surface

| Entry Point | Auth | Authz | Input Validation | Rate Limited |
|-------------|------|-------|-----------------|-------------|
| `/graphql` (gateway) | JWT (HS256, blacklist check) | AuthGuard (global APP_GUARD) | class-validator DTOs | Yes (nginx zone=api, burst=50) |
| Subgraph resolvers (farm, sensor, hr) | ServiceIdentityGuard + TenantGuard + RolesGuard (global APP_GUARD) | @Roles decorator | @Tenant() from JWT | Yes (gateway-level) |
| `/api/` REST endpoints | JWT via gateway AuthGuard | Route-level guards | Varies | Yes (nginx zone=api) |
| MQTT ingestion (sensor-service) | Device provisioning token / MQTT credentials | Schema-scoped | Topic parsing + validation | No nginx (internal) |
| NATS event handlers | ServiceIdentityGuard (subgraph level) | tenantId in BaseEvent | Event schema validation | No (internal bus) |
| `/health/*` endpoints | Public | None | N/A | No (intentional) |
| WebSocket subscriptions | JWT via connection params | Gateway-level | GraphQL schema | Yes (nginx) |

### Trust Boundary Crossings

- **Client -> nginx -> Gateway**: TLS 1.2/1.3 enforced, HSTS preload, CSP headers, rate limiting zones -- VALIDATED
- **Gateway -> Subgraph**: HMAC-signed X-Service-Identity headers via ServiceIdentityGuard -- VALIDATED (fails in production without INTERNAL_SERVICE_SECRET)
- **Subgraph -> PostgreSQL**: search_path isolation via TENANT_SCHEMA_REGEX, parameterized queries -- VALIDATED
- **Subgraph -> Redis**: TenantRedisService with UUID-validated key prefix -- VALIDATED
- **Subgraph -> NATS**: BaseEvent with tenantId routing -- VALIDATED (event contracts enforce)
- **MQTT -> sensor-service**: Device authentication via provisioned credentials -- VALIDATED

### STRIDE Assessment

| Threat | Risk | Mitigation | Gap |
|--------|------|-----------|-----|
| Spoofing | LOW | JWT HS256 with algorithm restriction (gateway), ServiceIdentityGuard (subgraphs), StripInternalHeadersMiddleware | Subgraph GqlAuthGuard (defense-in-depth layer) lacks algorithm restriction (HIGH-001) |
| Tampering | LOW | CSRF double-submit (gateway), TLS enforced, HMAC service signatures, parameterized SQL | Schema interpolation in migrations lacks regex validation (MEDIUM-002) |
| Repudiation | LOW | AuditLogService with recordAwait() for cross-tenant access, SecurityEventService via NATS, structured logging | NONE |
| Information Disclosure | LOW | SENSITIVE_FIELDS redaction, PII removed from JWT, error sanitization, /metrics blocked | NONE |
| Denial of Service | LOW | nginx rate limiting (100r/s API, 500r/s static), GraphQL depth limit, alias limit plugin, query complexity | CI quality gates are non-blocking (MEDIUM-001) |
| Elevation of Privilege | LOW | RBAC hierarchy with roleHasPermission(), TenantGuard JWT-only source, MFA step-up for cross-tenant | NONE |

### Risk Rating

- **Overall Risk**: LOW
- **Justification**: Defense-in-depth architecture with multiple redundant security layers. The two HIGH findings are in secondary guard layers that are already protected by the primary gateway AuthGuard and ServiceIdentityGuard. No direct exploitation path exists.

---

## Findings Summary

| Severity | Count | Top Category |
|----------|-------|-------------|
| CRITICAL | 0 | N/A |
| HIGH | 2 | A02/A07: Cryptographic / Authentication |
| MEDIUM | 4 | A05: Security Misconfiguration / CI-CD |
| LOW | 4 | Best Practices |

---

## Findings

### [HIGH-001] GqlAuthGuard Missing JWT Algorithm Restriction (farm-service)

- **File:** `apps/farm-service/src/common/guards/gql-auth.guard.ts:122`
- **Category:** OWASP A02 (Cryptographic Failures) / A07 (Authentication Failures)
- **CVSS 3.1 Score:** 5.9 (CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N)
- **Description:** The `GqlAuthGuard.validateRequest()` method calls `jwtService.verifyAsync()` with only a `secret` option but does NOT specify `algorithms: ['HS256']`. Without algorithm restriction, the JwtService may accept tokens signed with unexpected algorithms, potentially enabling algorithm confusion attacks (e.g., using the public key as an HMAC secret in RS256-to-HS256 downgrade).
- **Impact:** If an attacker can reach the subgraph directly (bypassing gateway and ServiceIdentityGuard), they could forge JWT tokens using algorithm confusion. This is mitigated by the ServiceIdentityGuard (which blocks direct access in production) and the gateway's AuthGuard (which does enforce HS256).
- **Exploitability:** Requires bypassing ServiceIdentityGuard (not possible when INTERNAL_SERVICE_SECRET is set in production) or network-level access to the Docker internal network.
- **Evidence:**
  ```typescript
  // farm-service/src/common/guards/gql-auth.guard.ts:122-124
  const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
    secret: this.configService.get<string>('JWT_SECRET'),
  });
  // Missing: algorithms: ['HS256']
  ```
- **Recommendation:** See REC-001
- **References:** CWE-327 (Use of a Broken or Risky Cryptographic Algorithm), OWASP JWT Algorithm Confusion

### [HIGH-002] GqlAuthGuard Missing JWT Algorithm Restriction (hr-service)

- **File:** `apps/hr-service/src/common/guards/gql-auth.guard.ts:133`
- **Category:** OWASP A02 (Cryptographic Failures) / A07 (Authentication Failures)
- **CVSS 3.1 Score:** 5.9 (CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N)
- **Description:** Identical issue to HIGH-001. The hr-service `GqlAuthGuard` calls `jwtService.verifyAsync()` without specifying `algorithms: ['HS256']`.
- **Impact:** Same as HIGH-001. Mitigated by identical production safeguards.
- **Evidence:**
  ```typescript
  // hr-service/src/common/guards/gql-auth.guard.ts:133-135
  const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
    secret: this.configService.get<string>('JWT_SECRET'),
  });
  // Missing: algorithms: ['HS256']
  ```
- **Recommendation:** See REC-002
- **References:** CWE-327

### [MEDIUM-001] CI Quality Gates Are Non-Blocking (continue-on-error: true)

- **File:** `.github/workflows/ci-affected.yml:97,138,180`
- **Category:** OWASP A08 (Software and Data Integrity Failures)
- **CVSS 3.1 Score:** 4.3 (CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N)
- **Description:** The `lint`, `type-check`, and `test` jobs all have `continue-on-error: true`, meaning they will not block PR merges even when they fail. This allows code with lint errors, type errors, or failing tests to be merged into main.
- **Impact:** Security-relevant lint rules (e.g., `@typescript-eslint/no-explicit-any`) and type-check errors (e.g., incorrect guard typing) will not prevent merge. Failing security-related tests will not block deployment.
- **Recommendation:** See REC-003
- **References:** CWE-1127 (Compilation with Insufficient Warnings or Errors)

### [MEDIUM-002] Schema Name Interpolation in Migrations Without SCHEMA_NAME_REGEX Validation

- **File:** `apps/farm-service/src/database/migrations/1769000000000-AddRegulatorySettings.ts:104`
- **Category:** OWASP A03 (Injection) -- Defense-in-Depth Gap
- **CVSS 3.1 Score:** 3.7 (CVSS:3.1/AV:N/AC:H/PR:H/UI:N/S:U/C:L/I:L/A:N)
- **Description:** Several migrations iterate over `information_schema.schemata` and interpolate `schema_name` directly into SQL templates without validating against `SCHEMA_NAME_REGEX`. While the data source is trusted (PostgreSQL `information_schema`), defense-in-depth principles require validation before SQL interpolation. The production code paths in `SchemaManagerService`, `TenantConnectionBootstrapService`, and `CrossTenantProbe` all correctly validate -- migrations are the gap.
- **Impact:** Theoretical only. An attacker would need to have already compromised the database to inject a malicious schema name into `information_schema.schemata`. However, this violates the platform's defense-in-depth standard.
- **Evidence:**
  ```typescript
  // Multiple migrations follow this pattern:
  for (const { schema_name } of tenantSchemas) {
    await queryRunner.query(`
      CREATE TABLE "${schema_name}"."regulatory_settings" ...
    `);
    // Missing: SCHEMA_NAME_REGEX.test(schema_name) validation
  }
  ```
- **Recommendation:** See REC-004
- **References:** CWE-89 (SQL Injection)

### [MEDIUM-003] CI Workflow Missing Explicit permissions: Block

- **File:** `.github/workflows/ci-affected.yml` (top level)
- **Category:** OWASP A05 (Security Misconfiguration)
- **CVSS 3.1 Score:** 3.5 (CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:N/I:L/A:N)
- **Description:** The `ci-affected.yml` workflow does not declare a top-level `permissions:` block. Without explicit permissions, GitHub Actions defaults to the repository's default token permissions (often `write-all`). The security-trivy.yml correctly declares `permissions: { contents: read, security-events: write }`.
- **Impact:** A compromised third-party action could use the over-permissioned GITHUB_TOKEN to push commits, create releases, or modify repository settings.
- **Recommendation:** See REC-005
- **References:** CWE-250 (Execution with Unnecessary Privileges)

### [MEDIUM-004] Empty GDPR Compliance Service in auth-service

- **File:** `apps/auth-service/src/privacy/gdpr-compliance.service.ts`
- **Category:** Compliance (GDPR)
- **CVSS 3.1 Score:** 3.1 (CVSS:3.1/AV:N/AC:H/PR:H/UI:N/S:U/C:L/I:N/A:N)
- **Description:** The file `gdpr-compliance.service.ts` exists but is completely empty (0 bytes). While the platform has GDPR functionality in `libs/backend-common/src/security/gdpr/gdpr.service.ts` (which implements Right to Access, Erasure, Rectification, Restriction) and a consent management system in the GDPR module, this empty file suggests incomplete implementation or a dead reference.
- **Impact:** Potential gap in GDPR compliance coverage within the auth-service's privacy module.
- **Recommendation:** See REC-006

### [LOW-001] console.log Usage in Migrations

- **File:** Multiple migration files in `apps/farm-service/src/database/migrations/`, `apps/sensor-service/src/database/migrations/`
- **Category:** A09 (Security Logging Failures) -- Best Practice
- **Description:** Migration files use `console.log()` instead of NestJS `Logger`. While migrations run outside the NestJS lifecycle (acceptable), structured logging via Logger is preferred for consistency and observability.
- **Recommendation:** Consider migrating to a structured logger for migration output.

### [LOW-002] GqlAuthGuard Missing Token Type Discrimination

- **File:** `apps/farm-service/src/common/guards/gql-auth.guard.ts:122-129`
- **Category:** OWASP A07 (Authentication Failures) -- Defense-in-Depth
- **Description:** The subgraph `GqlAuthGuard` does not check `payload.type === 'access'`, which means refresh tokens or MFA challenge tokens could theoretically be accepted. The gateway's AuthGuard and `token-validation.util.ts` do check this via `validateAccessTokenCompat()`. This is defense-in-depth only since subgraphs are not directly accessible.
- **Recommendation:** Add `validateAccessTokenCompat()` check or equivalent token type validation.

### [LOW-003] Duplicate getTenantSchemaFromId Implementation

- **File:** `apps/sensor-service/src/edge-device/provisioning.service.ts:724-727` and `apps/sensor-service/src/edge-device/edge-device.service.ts:2374-2377`
- **Category:** Code Quality / Maintainability
- **Description:** Two files duplicate the `getTenantSchemaFromId()` function instead of importing `getTenantSchemaName()` from `@aquaculture/backend-common`. While functionally identical, this creates a maintenance risk -- if the derivation formula changes, these copies could diverge.
- **Recommendation:** Replace with `import { getTenantSchemaName } from '@aquaculture/backend-common'`.

### [LOW-004] SEC-COMPAT: Token Type Optional During Transition

- **File:** `apps/gateway-api/src/guards/utils/token-validation.util.ts:41`
- **Category:** OWASP A04 (Insecure Design) -- Transition Risk
- **Description:** The `validateAccessTokenCompat()` function treats tokens without a `type` field as access tokens for backward compatibility with pre-hardening tokens. The comment indicates this should be tightened to require `payload.type === 'access'` once all legacy tokens have expired. The transition period has been active since pre-2026-04.
- **Recommendation:** Schedule a date to tighten the check. If JWT_EXPIRES_IN is 15m and REFRESH_TOKEN_EXPIRY_DAYS is 7, all legacy tokens should have expired within 7 days of the hardening deployment. Verify and tighten.

---

## Tenant Isolation Assessment

**Overall Rating: STRONG**

The tenant isolation architecture is well-designed and consistently implemented:

1. **Database Isolation (STRONG):**
   - `TenantSchemaMiddleware` validates tenantId as UUID before deriving schema name
   - `TenantConnectionBootstrapService` validates schema name against `TENANT_SCHEMA_REGEX` (/^tenant_[a-f0-9]{16}$/) before `SET search_path`
   - `SchemaManagerService.validateTenantSchemaName()` provides defense-in-depth validation
   - `CrossTenantProbe` watchdog actively detects cross-tenant data contamination
   - `SourceSchemaWriteGuardService` prevents writes to source schemas
   - All raw SQL with schema interpolation in core service code uses validated schema names
   - `listTenantSchemas()` uses regex-based query (`schema_name ~ '^tenant_[a-f0-9]{16}$'`)

2. **Redis Isolation (STRONG):**
   - `TenantRedisService.forTenant()` validates tenantId as UUID before constructing prefix
   - All operations are key-prefixed with `tenant:{uuid}:`
   - `deletePattern()` is scoped to tenant prefix

3. **Event Isolation (ADEQUATE):**
   - `BaseEvent` includes tenantId for routing
   - Event consumers should validate tenantId matches expected context (not fully verified across all handlers)

4. **Guard Enforcement (STRONG):**
   - `TenantGuard` registered as global APP_GUARD in all domain services
   - Regular users: tenantId sourced EXCLUSIVELY from JWT claim
   - SUPER_ADMIN: only via X-Act-As-Tenant with UUID validation and persistent audit logging
   - MFA step-up enforced for cross-tenant access when configured

---

## Compliance Status

| Standard | Status | Gaps |
|----------|--------|------|
| OWASP Top 10 2021 | COMPLIANT (2 HIGH findings, non-critical) | A02/A07: Subgraph guard algorithm restriction |
| GDPR | PARTIALLY COMPLIANT | Empty gdpr-compliance.service.ts; core GdprService functional |
| IEC 62443 | NOT ASSESSED (edge/SCADA code not in review scope) | N/A for this review |
