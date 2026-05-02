# Messaging Compliance Audit Tenant Routing

Date: 2026-05-02

## Problem

E2E also showed `ComplianceAuditService` writing `compliance_audit_log` through its injected repository outside a tenant-pinned transaction. `compliance_audit_log` is tenant business/audit data, not source infrastructure, so it must remain protected by the source write guard.

## Enterprise Fix

`ComplianceAuditService` now routes non-transactional single writes, batch writes, and audit-log reads through `runInTenantTransaction()`. Transactional callers still pass their own manager and are wrapped with `tenantManagerRepo()` so audit rows commit atomically with the domain change.

## Validation

Targeted unit tests must prove audit writes pin tenant search_path. Messaging E2E must prove audit logging no longer attempts source-schema writes.
