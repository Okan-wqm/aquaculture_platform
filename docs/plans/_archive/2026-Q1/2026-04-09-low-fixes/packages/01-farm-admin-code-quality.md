# Package 01: farm-admin-code-quality

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 18K
Priority: LOW
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Context
Six LOW findings across farm-service and admin-api-service covering minor code quality issues: a DEV-only console.error guard, mock data left in a types file, an undersized shared library, a .js extension in a TS import, a silent empty-string return instead of a throw, and mixed-language error messages. All are style/quality fixes with no behavioral risk.

## Findings

**FARM-LOW-001: console.error DEV-only guard**
- Source agent: farm-expert
- Severity: LOW
- File: `apps/farm-service/src/__tests__/e2e/p0-fixes-verification.e2e-spec.ts`
- Line: 180
- Description: `console.warn()` used in test file. Should use NestJS Logger or be guarded behind a DEV-only check per CLAUDE.md. Since this is a test file, replacing with a test-appropriate assertion or suppressing is acceptable.

**FARM-LOW-002: mock data in batch.types.ts**
- Source agent: farm-expert
- Severity: LOW
- File: `apps/farm-service/src/batch/entities/batch.types.ts`
- Description: Contains mock/sample data that should live in test fixtures, not in production type definitions. Review and extract any mock data to `__tests__/fixtures/`.

**FARM-LOW-003: farm-shared only 3 files**
- Source agent: farm-expert
- Severity: LOW
- Files: `libs/farm-shared/src/index.ts`, `libs/farm-shared/src/types/water-quality.types.ts`, `libs/farm-shared/src/components/DynamicMeasurementForm.tsx`, `libs/farm-shared/src/utils/threshold-evaluator.ts`
- Description: The `libs/farm-shared` library exports only 3 files (types, component, util). Evaluate whether this justifies a separate lib or should be inlined into farm-service. If kept, add JSDoc to index.ts explaining the lib's purpose and growth plan.

**FARM-LOW-004: .js extension in TS import**
- Source agent: farm-expert
- Severity: LOW
- File: `apps/farm-service/src/ai-insights/services/mcp-client.service.ts`
- Lines: 142-143
- Description: Dynamic imports use `.js` extensions (`@modelcontextprotocol/sdk/client/index.js`, `@modelcontextprotocol/sdk/client/stdio.js`). These are ESM-style imports that may be intentional for the MCP SDK. Verify whether the SDK requires `.js` extensions or if bare specifiers work. If SDK requires .js, add a `// WHY:` comment.

**ADMIN-LOW-001: getAuthUserId returns '' not throw**
- Source agent: admin-expert
- Severity: LOW
- File: `apps/admin-api-service/src/shared/authenticated-request.ts`
- Line: 35
- Description: `getAuthUserId()` returns `undefined` on unauthenticated requests. Callers in `billing.controller.ts` coalesce to empty string (`?? ''`), silently swallowing authentication failures. Consider whether callers should throw on missing userId instead of proceeding with empty string.

**ADMIN-LOW-002: mixed language error messages**
- Source agent: admin-expert
- Severity: LOW
- Files: Multiple files in `apps/admin-api-service/src/` (billing, settings, security controllers)
- Description: Error messages mix Turkish and English. Standardize to English for error messages in source code; i18n layer handles user-facing localization.

Closing-Findings: [FARM-LOW-001, FARM-LOW-002, FARM-LOW-003, FARM-LOW-004, ADMIN-LOW-001, ADMIN-LOW-002]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Affected Files
- `/var/aqua-saas/apps/farm-service/src/__tests__/e2e/p0-fixes-verification.e2e-spec.ts`
- `/var/aqua-saas/apps/farm-service/src/batch/entities/batch.types.ts`
- `/var/aqua-saas/libs/farm-shared/src/index.ts`
- `/var/aqua-saas/apps/farm-service/src/ai-insights/services/mcp-client.service.ts`
- `/var/aqua-saas/apps/admin-api-service/src/shared/authenticated-request.ts`
- `/var/aqua-saas/apps/admin-api-service/src/billing/billing.controller.ts`
- `/var/aqua-saas/apps/admin-api-service/src/settings/settings.controller.ts`
- `/var/aqua-saas/apps/admin-api-service/src/security/controllers/compliance.controller.ts`

## Dependencies
None. All findings are independent code quality fixes.

## Atomic Commit Plan
```
chore(farm,admin): clean up 6 LOW code quality findings

Address minor code quality issues in farm-service and admin-api-service:
- Guard test console.warn behind Logger or assertion
- Review batch.types.ts for mock data extraction
- Document farm-shared lib purpose in index.ts JSDoc
- Add WHY comment for .js extension imports if SDK-required
- Tighten getAuthUserId callers to throw on missing auth
- Standardize error messages to English (i18n handles localization)

Plan: docs/plans/2026-04-09-low-fixes/packages/01-farm-admin-code-quality.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FARM-LOW-001
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FARM-LOW-002
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FARM-LOW-003
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FARM-LOW-004
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#ADMIN-LOW-001
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#ADMIN-LOW-002
```

## Test Plan
- Verify farm-service compilation: `npx tsc --noEmit -p apps/farm-service/tsconfig.json`
- Verify admin-api-service compilation: `npx tsc --noEmit -p apps/admin-api-service/tsconfig.json`
- Run farm batch tests: `npx jest --testPathPattern="apps/farm-service/src/batch"`
- Run admin billing tests: `npx jest --testPathPattern="apps/admin-api-service/src/billing"`

## Verification Command
`npx tsc --noEmit -p apps/farm-service/tsconfig.json && npx tsc --noEmit -p apps/admin-api-service/tsconfig.json`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
