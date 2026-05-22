# Platform Admin Security Triangle Fix

Date: 2026-05-22

Scope:

- `/admin/security/activity`
- `/admin/security/audit`
- `/admin/security/compliance`
- `/admin/security/threats`

Decision:

- Platform admin security pages are platform-scope by default. The frontend API client now supports explicit `tenantScope: 'platform'`, and the security API adapter uses it so a stale tenant selection cannot narrow or poison these platform-admin reads.
- Compliance report list keeps the backend paginated envelope. The frontend consumes `PaginatedResult<BackendComplianceReport>` instead of requiring a raw array.
- `/security/audit` is backed by immutable `admin.audit_logs` through `AuditLogService`. Activity-log retention policies remain under the same screen, but audit entries and summary reads no longer use mutable `admin.activity_logs`.
- Security monitoring DTOs now use the entity-backed event statuses, event types, and threat indicator aliases. The frontend resolves events with `mitigated`, not stale `resolved`.
- Runtime purge for `admin.audit_logs` is disabled in code. Immutable audit retention must be handled by archive/partition policy outside runtime delete paths.

Changed:

- Added backend DTO/view-model contracts in `web/modules/admin-panel/src/services/types/security.ts` and removed stale frontend-only security interfaces that used obsolete event/request shapes.
- Updated `web/modules/admin-panel/src/services/api/security.ts` to align query names and response envelopes for activity, audit, compliance, monitoring, and threat intelligence. Stale client methods without backend contracts were removed instead of left as runtime throw paths.
- Updated the four security pages to map backend DTOs into UI view models without unsafe raw casts and without blanking all data when one panel fails.
- Imported `AuditLogModule` into `SecurityModule` and moved `/security/audit` list/summary/entity reads to `AuditLogService`.
- Added `tests/invariants/admin-security-runtime-contract.spec.ts` to lock the security route/API/source-of-truth contracts.

Validation Notes:

- Heavy database migration and full Nx suites are intentionally left for GitHub Actions per project policy.
- Local checks run on 2026-05-22: `npx tsc --noEmit -p web/modules/admin-panel/tsconfig.json`, `npx tsc --noEmit -p apps/admin-api-service/tsconfig.app.json`, focused backend/security API lint, focused security page lint, and `npx jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runTestsByPath tests/invariants/admin-security-runtime-contract.spec.ts`. Page lint reports existing explicit-return-type warnings only; no errors.
