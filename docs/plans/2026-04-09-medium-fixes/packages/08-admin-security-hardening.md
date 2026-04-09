# Package 08: admin-security-hardening

## Metadata
Status: PENDING
Estimated Tokens: 18K
Priority: MEDIUM
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none

## Closing-Findings
Closing-Findings: [ADMIN-MEDIUM-001, ADMIN-MEDIUM-002, ADMIN-MEDIUM-003, ADMIN-MEDIUM-004, ADMIN-MEDIUM-005, ADMIN-MEDIUM-006]

## Source-Reviews
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/admin-expert/2026-04-04-full-codebase-audit.md

## Context
Six admin domain findings cover impersonation safety, audit integrity, session tracking, and type safety in the admin-api-service. All files are under `apps/admin-api-service/src/` and share the admin security context. Grouped as a single package for atomicity.

## Findings

**ADMIN-MEDIUM-001 — Impersonation has no IP binding**
The admin impersonation feature creates a session token but does not bind it to the admin's IP address. A stolen impersonation token can be used from any IP. Add `source_ip` to the impersonation session and validate on each request.

**ADMIN-MEDIUM-002 — Database explorer audit logs go to NestJS Logger only**
The SQL explorer controller logs query execution via `Logger.log()` but does not write to the persistent audit table. Admin SQL queries should be recorded in `compliance_audit_log` for SOC 2 compliance.

**ADMIN-MEDIUM-003 — Audit log reading has no meta-audit trail**
Reading audit logs (GET /audit) is not itself audited. An admin could read sensitive audit entries without leaving a trace. Add a meta-audit entry for audit log access.

**ADMIN-MEDIUM-004 — Session entity lacks MFA completion field**
The `Session` entity has no `mfaCompleted: boolean` field. The auth flow checks MFA status by querying a separate table. Adding `mfaCompleted` to the session entity enables the session list UI to show MFA status and simplifies the guard logic.

**ADMIN-MEDIUM-005 — Database explorer does not use read-only transaction**
The SQL explorer executes arbitrary SELECT queries but does not wrap them in a read-only transaction (`SET TRANSACTION READ ONLY`). A malformed query or SQL injection through the explorer could mutate data.

**ADMIN-MEDIUM-006 — Admin event publishing not type-checked**
Admin domain events are published as `Record<string, unknown>` instead of typed event interfaces from `@platform/event-contracts`. This bypasses compile-time contract enforcement.

## Affected Files
- apps/admin-api-service/src/database-management/controllers/explorer.controller.ts
- apps/admin-api-service/src/modules/tenant-management/services/ (impersonation logic)
- apps/admin-api-service/src/database-management/services/ (audit services)
- apps/auth-service/src/modules/authentication/entities/session.entity.ts (or admin session entity)
- libs/event-contracts/src/ (admin event types if missing)

## Dependencies
None. Admin service changes are self-contained. The session entity addition is additive.

## Atomic Commit Plan
```
security(admin): bind impersonation to IP, persist explorer audit, add meta-audit, add session MFA field, enforce read-only TX, type-check events

Six admin security hardening fixes:
- Bind impersonation sessions to source IP; validate on each request
- Write SQL explorer queries to compliance_audit_log (not just Logger)
- Add meta-audit entry when audit logs are read
- Add mfaCompleted boolean to Session entity
- Wrap explorer queries in SET TRANSACTION READ ONLY
- Replace Record<string, unknown> event publishing with typed event contracts

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#ADMIN-MEDIUM-001
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#ADMIN-MEDIUM-002
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#ADMIN-MEDIUM-003
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#ADMIN-MEDIUM-004
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#ADMIN-MEDIUM-005
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#ADMIN-MEDIUM-006
Plan: docs/plans/2026-04-09-medium-fixes/packages/08-admin-security-hardening.md
```

## Test Plan
- Unit test: impersonation session stores and validates source_ip
- Unit test: explorer query creates compliance_audit_log entry
- Unit test: GET /audit creates a meta-audit log entry
- Unit test: Session entity has mfaCompleted column
- Unit test: explorer query wrapped in read-only transaction (mock verifies SET TRANSACTION)
- Unit test: admin event publishing rejects payload not matching typed contract

## Verification Command
`npx tsc --noEmit -p apps/admin-api-service/tsconfig.json && npx jest --testPathPattern="apps/admin-api-service" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
