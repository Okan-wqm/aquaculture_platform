# Security Remediation Recommendations

**Date:** 2026-04-04
**Related Audit:** `docs/reviews/security-reviewer/2026-04-04-full-platform-audit.md`

---

## Recommendations

### REC-001: Add JWT Algorithm Restriction to farm-service GqlAuthGuard (addresses HIGH-001)

**Priority:** HIGH
**Estimated Effort:** S (< 1 hour)
**Files to Modify:**
- `apps/farm-service/src/common/guards/gql-auth.guard.ts` -- Add `algorithms: ['HS256']` to `verifyAsync` call

**Recommended Implementation:**

```typescript
// apps/farm-service/src/common/guards/gql-auth.guard.ts
// In validateRequest(), line ~122:
const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
  secret: this.configService.get<string>('JWT_SECRET'),
  algorithms: ['HS256'], // SEC: Prevent algorithm confusion attacks
});
```

**Acceptance Criteria:**
- [ ] `jwtService.verifyAsync()` includes `algorithms: ['HS256']` option
- [ ] Unit test added: token signed with RS256 is rejected
- [ ] Unit test added: token signed with 'none' algorithm is rejected
- [ ] Existing HS256 token tests continue to pass

---

### REC-002: Add JWT Algorithm Restriction to hr-service GqlAuthGuard (addresses HIGH-002)

**Priority:** HIGH
**Estimated Effort:** S (< 1 hour)
**Files to Modify:**
- `apps/hr-service/src/common/guards/gql-auth.guard.ts` -- Add `algorithms: ['HS256']` to `verifyAsync` call

**Recommended Implementation:**

```typescript
// apps/hr-service/src/common/guards/gql-auth.guard.ts
// In validateRequest(), line ~133:
const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
  secret: this.configService.get<string>('JWT_SECRET'),
  algorithms: ['HS256'], // SEC: Prevent algorithm confusion attacks
});
```

**Acceptance Criteria:**
- [ ] `jwtService.verifyAsync()` includes `algorithms: ['HS256']` option
- [ ] Unit test added: token signed with RS256 is rejected
- [ ] Existing HS256 token tests continue to pass

---

### REC-003: Remove continue-on-error from CI Quality Gate Jobs (addresses MEDIUM-001)

**Priority:** MEDIUM
**Estimated Effort:** S (< 1 hour)
**Files to Modify:**
- `.github/workflows/ci-affected.yml` -- Remove `continue-on-error: true` from lint, type-check, and test jobs

**Recommended Implementation:**

```yaml
# .github/workflows/ci-affected.yml
# For each of lint, type-check, test jobs:
  lint:
    needs: [install, detect-changes]
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 40
    # REMOVED: continue-on-error: true
    steps:
      # ... existing steps unchanged
```

**Acceptance Criteria:**
- [ ] `continue-on-error: true` removed from lint, type-check, and test jobs
- [ ] PR merge is blocked when lint fails
- [ ] PR merge is blocked when type-check fails
- [ ] PR merge is blocked when tests fail
- [ ] Build job remains without continue-on-error (already correct)

---

### REC-004: Add SCHEMA_NAME_REGEX Validation to Migration Schema Interpolation (addresses MEDIUM-002)

**Priority:** MEDIUM
**Estimated Effort:** S (< 1 hour per migration, M total across all migrations)
**Files to Modify:**
- `apps/farm-service/src/database/migrations/1769000000000-AddRegulatorySettings.ts`
- `apps/farm-service/src/database/migrations/1773000000000-AddWeatherTables.ts`
- `apps/farm-service/src/database/migrations/1774000000000-AddFeederCalibrations.ts`
- `apps/farm-service/src/database/migrations/1772000000000-AddPurchaseOrders.ts`
- Other migrations with similar pattern

**Recommended Implementation:**

```typescript
// At the top of each migration file:
const SCHEMA_NAME_REGEX = /^[a-z0-9_]+$/;

// Before schema name interpolation:
for (const { schema_name } of tenantSchemas) {
  if (!SCHEMA_NAME_REGEX.test(schema_name)) {
    console.warn(`Skipping unsafe schema name: "${schema_name}"`);
    continue;
  }
  await queryRunner.query(`
    CREATE TABLE "${schema_name}"."regulatory_settings"
    (LIKE "farm"."regulatory_settings" INCLUDING ALL)
  `);
}
```

**Acceptance Criteria:**
- [ ] All migrations validate schema names before SQL interpolation
- [ ] Invalid schema names are skipped with a warning
- [ ] Existing migrations continue to work with valid tenant schemas

---

### REC-005: Add Explicit Permissions to CI Workflow (addresses MEDIUM-003)

**Priority:** MEDIUM
**Estimated Effort:** S (< 30 minutes)
**Files to Modify:**
- `.github/workflows/ci-affected.yml` -- Add top-level `permissions:` block

**Recommended Implementation:**

```yaml
# .github/workflows/ci-affected.yml
# Add at top level, after 'env:' block:
permissions:
  contents: read
  actions: read
```

**Acceptance Criteria:**
- [ ] Top-level `permissions:` block present with minimal required permissions
- [ ] All CI jobs continue to function correctly
- [ ] GITHUB_TOKEN has only read access to repository contents

---

### REC-006: Complete or Remove Empty GDPR Compliance Service (addresses MEDIUM-004)

**Priority:** MEDIUM
**Estimated Effort:** S (decision) / L (implementation if completing)
**Files to Modify:**
- `apps/auth-service/src/privacy/gdpr-compliance.service.ts` -- Either implement or remove

**Recommended Implementation:**

Option A -- Remove if functionality exists elsewhere:
```bash
rm apps/auth-service/src/privacy/gdpr-compliance.service.ts
# Remove any imports/references to this file
```

Option B -- Implement auth-service-specific GDPR operations:
```typescript
// Implement data export/deletion specific to auth-service data
// (users, credentials, sessions, MFA data, login history)
// that the generic GdprService in backend-common does not cover
```

**Acceptance Criteria:**
- [ ] No empty source files in the codebase
- [ ] If removed: verify no broken imports
- [ ] If implemented: covers auth-specific GDPR data categories (WebAuthn credentials, MFA secrets, login history, sessions)

---

### REC-007: Tighten SEC-COMPAT Token Type Validation (addresses LOW-004)

**Priority:** LOW (schedule for next sprint)
**Estimated Effort:** S (< 1 hour)
**Files to Modify:**
- `apps/gateway-api/src/guards/utils/token-validation.util.ts` -- Tighten type check

**Recommended Implementation:**

```typescript
// Change from:
if (payload.type && payload.type !== 'access') {
  throw new UnauthorizedException({ ... });
}

// To (after confirming all legacy tokens have expired):
if (payload.type !== 'access') {
  throw new UnauthorizedException({
    code: 'INVALID_TOKEN_TYPE',
    message: 'Access token required',
  });
}
```

**Acceptance Criteria:**
- [ ] Verify all tokens in circulation have `type: 'access'` (check JWT_EXPIRES_IN + REFRESH_TOKEN_EXPIRY_DAYS since hardening date)
- [ ] Legacy tokens without `type` field are rejected
- [ ] All tests pass with the tightened check

---

### REC-008: Deduplicate getTenantSchemaFromId (addresses LOW-003)

**Priority:** LOW
**Estimated Effort:** S (< 30 minutes)
**Files to Modify:**
- `apps/sensor-service/src/edge-device/provisioning.service.ts` -- Replace private method with import
- `apps/sensor-service/src/edge-device/edge-device.service.ts` -- Replace private method with import

**Recommended Implementation:**

```typescript
// Replace:
private getTenantSchemaFromId(tenantId: string): string {
  const hex = tenantId.replace(/-/g, '').toLowerCase().substring(0, 16);
  return `tenant_${hex}`;
}

// With import at top of file:
import { getTenantSchemaName } from '@aquaculture/backend-common';
// Then use getTenantSchemaName(tenantId) in place of this.getTenantSchemaFromId(tenantId)
```

**Acceptance Criteria:**
- [ ] Both files use the shared `getTenantSchemaName()` from backend-common
- [ ] No duplicate implementations of schema name derivation
- [ ] All existing tests pass
