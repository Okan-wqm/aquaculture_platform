# Research: CQRS Audit Log Interceptor for Payroll

**Topic:** Why payroll mutations need `@AuditLog()`, immutability guarantees, audit query RBAC
**Date:** 2026-04-08
**Agent:** hr-expert

## Sources
- [NestJS - CQRS Recipe](https://docs.nestjs.com/recipes/cqrs)
- [nestjs/cqrs - EventBus source](https://github.com/nestjs/cqrs/blob/master/src/event-bus.ts)
- [nestjs/cqrs Issue #113 - Transactional outbox pattern](https://github.com/nestjs/cqrs/issues/113)
- [Microsoft Learn - Event Sourcing Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
- [Kurrent.io - Event Sourcing vs Audit Log](https://www.kurrent.io/blog/event-sourcing-audit)
- [Hubifi - Immutable Audit Trails: A Complete Guide](https://www.hubifi.com/blog/immutable-audit-log-basics)
- [Estuary - Building Compliance-Ready Data Pipelines: GDPR, SOX, and Beyond](https://estuary.dev/blog/compliance-ready-data-pipelines-gdpr-sox)

## Key Findings

1. **NestJS `@nestjs/cqrs` provides CommandBus, QueryBus, EventBus, and AggregateRoot primitives.** AggregateRoot collects uncommitted events in memory; `.commit()` flushes them to the EventBus. This split gives the integrator control over the reliability pattern (outbox, retry, replay).
2. **Nest CQRS does NOT implement the transactional outbox pattern natively.** Per the project's own issue tracker, publishing an event after a DB transaction commits is the integrator's responsibility. Publishing inside the transaction risks duplicate-event on retry; publishing after without an outbox risks lost events on crash.
3. **The correct pattern** (transactional outbox): within a single DB transaction, (a) write the aggregate state, (b) insert a row in an `outbox` table with the serialized event. After commit, a background relayer reads the outbox and publishes to NATS, marking the row delivered on ack. Duplicates are handled idempotently by consumer.
4. **Sarbanes-Oxley (SOX)** for publicly-traded companies requires permanent, tamper-evident audit trails of financial transactions. Payroll is a financial transaction. SOX audit reviews examine whether the audit trail can prove that financial reporting controls were not bypassed.
5. **SEC Rule 17a-4(f)** for financial services and similar rules in other jurisdictions require "write once, read many" (WORM) or equivalent tamper-evident storage for financial records.
6. **Event sourcing naturally produces an immutable audit log** — every state change is an append-only event. For payroll, this means every calculation, every approval, every adjustment is an event that cannot be retroactively modified.
7. **Event sourcing conflicts with GDPR erasure** — resolved by crypto-shredding (per-subject encryption keys deleted on erasure request) so the event stream stays intact but PII becomes unreadable.
8. **Audit log RBAC** must be distinct from the CRUD RBAC on the same data. A payroll clerk can edit payroll entries; only a payroll auditor can read the audit log; nobody can modify it. Even SUPER_ADMIN should be read-only on the audit log by default.
9. **Append-only enforcement at the DB layer:** the audit log table should have no UPDATE or DELETE grants; only INSERT. Revoke DELETE and UPDATE on the audit table for the application role. This prevents even a compromised app from tampering with history.
10. **Audit entries must be hash-chained** for tamper evidence: each row stores `prev_row_hash` and `row_hash = SHA256(prev_row_hash || canonical_payload)`. Breaking the chain detects inserted/deleted rows.
11. **Interceptor pattern in NestJS:** an `@AuditLog()` method decorator paired with a `NestInterceptor` captures command, actor, tenant, before/after state, and writes to the audit table within the same transaction as the command handler. This enforces audit-on-every-mutation without per-handler code duplication.

## Security Concerns

- **CRITICAL:** Payroll mutation without an audit entry cannot be defended in a wage-and-hour dispute, IRS audit, or SOX review — a direct compliance failure.
- **CRITICAL:** Audit log with UPDATE or DELETE grants allows tampering; a compromised credential or malicious insider can erase evidence.
- **CRITICAL:** Audit log missing cryptographic chain means row-level tampering is undetectable — auditor cannot prove completeness.
- **HIGH:** Publishing NATS events inside a DB transaction leaks on rollback (event published, DB rolled back) or on crash (DB committed, event never sent). Both inconsistencies corrupt downstream state.
- **HIGH:** Audit log read access granted to routine roles (clerk, manager) violates separation of duties — auditors should see what others did without being able to perform those actions themselves.
- **MEDIUM:** PII in audit log payloads without redaction recreates the GDPR erasure problem in the audit table.
- **MEDIUM:** Missing actor context (who made the change) in audit entries renders them useless for accountability.

## Performance Concerns

- Audit log writes on every command add load; batching hash-chain computation is not possible (chain is strictly sequential). Accept the cost and use a dedicated high-performance partition.
- Outbox table grows unbounded if not archived; implement a daily archive job moving delivered rows to cold storage after retention period.
- Hash-chain verification is an O(N) read of the entire log — run it as a nightly job and alert on any mismatch.
- Audit query RBAC must NOT add a row-level filter that degrades the sequential scan used for hash verification.

## Architectural Implications for hr-expert reviews

- `@AuditLog()` must be a method decorator applied to every command handler that mutates payroll state (`ProcessPayrollCommand`, `AdjustPayrollCommand`, `ApprovePayrollCommand`, `PayEmployeeCommand`, `AdjustDeductionCommand`, `ChangeTaxBracketCommand`, etc.) and every command that mutates employee PII.
- A `PayrollAuditInterceptor` reads the `@AuditLog()` metadata, captures the command payload, actor (from request context), tenant, before/after state, and writes an `AuditLogEntry` row in the same DB transaction as the command handler.
- `AuditLogEntry` schema: `(id UUID, tenant_id, entity_type, entity_id, action, actor_id, actor_role, command_name, before_json, after_json, ip_address, user_agent, created_at, prev_hash, row_hash)`.
- DB migration must explicitly `REVOKE UPDATE, DELETE ON audit_log FROM application_role` to enforce append-only at the DB layer. The `@AuditLog()` test suite must assert the REVOKE is in place.
- Hash chain: `row_hash = SHA256(prev_hash || canonicalize(payload))`. Canonicalization must be deterministic (sorted keys, stable timestamp format).
- Nightly verification job reads the entire log, recomputes the chain, and alerts P0 on any mismatch.
- Audit log RBAC: a dedicated `PAYROLL_AUDITOR` role has read-only access; `SUPER_ADMIN` is read-only by default; no role has write access (only the `@AuditLog()` interceptor does).
- Outbox pattern: all NATS events from HR service must flow through an `outbox_events` table written in the same transaction as the aggregate state. A background relayer publishes to NATS JetStream and marks rows delivered on ack. Direct `eventBus.publish()` inside a command handler without the outbox is a blocking review failure.
- PII in audit payloads must be redacted through the same `SENSITIVE_FIELDS` interceptor used for logs. The audit log is not an exception to GDPR.
- Audit log entries for deleted employees must use crypto-shredding — encrypt with a per-employee key stored in the tenant keyring; erasure destroys the key.

## Domain Rule Additions for hr-expert

- **[CRITICAL]** Every command that mutates payroll state (ProcessPayroll, AdjustPayroll, ApprovePayroll, PayEmployee, AdjustDeduction, ChangeTaxBracket) must be decorated with `@AuditLog()`. A payroll mutation without an audit entry is a blocking review failure.
- **[CRITICAL]** Every command that mutates employee PII (CreateEmployee, UpdateEmployeeProfile, UpdateBankDetails, UpdateCompensation, TerminateEmployee, EraseEmployee) must be decorated with `@AuditLog()`.
- **[CRITICAL]** The `audit_log` table migration must `REVOKE UPDATE, DELETE ... FROM application_role`. Missing revoke or granting UPDATE/DELETE is a blocking review failure. A test must assert the grants.
- **[CRITICAL]** Audit entries must be hash-chained (`row_hash = SHA256(prev_hash || canonical_payload)`). A nightly verification job must run and alert P0 on mismatch. Missing chain or missing verifier is a blocking review failure.
- **[CRITICAL]** HR service NATS events must be published through the transactional outbox (`outbox_events` table written in the same transaction as aggregate state, background relayer publishes after commit). Direct `eventBus.publish()` without outbox from within a command handler is a blocking review failure.
- **[HIGH]** Audit log read access must be limited to a dedicated `PAYROLL_AUDITOR` role; routine roles (clerk, manager, HR admin) must not have read access to the audit log for separation of duties. `SUPER_ADMIN` is read-only by default on audit log.
- **[HIGH]** No role — including `SUPER_ADMIN` — may have UPDATE or DELETE access to `audit_log`. The only writer is the `@AuditLog()` interceptor running within a command transaction.
- **[HIGH]** PII fields in `before_json` / `after_json` must be redacted through the `SENSITIVE_FIELDS` interceptor before insertion, or encrypted per-subject (crypto-shredding) so audit entries can be made GDPR-erasure-compliant.
- **[HIGH]** Audit entries must record: actor_id, actor_role, tenant_id, command_name, before/after JSON, ip_address, user_agent, created_at. Missing any of these is a blocking review failure.
- **[MEDIUM]** Outbox rows must be archived after their delivery retention (default 90 days) to cold storage, not deleted — archive preserves the chain for long-term compliance.
- **[MEDIUM]** Canonical JSON serialization for hash computation must be deterministic (sorted keys, ISO-8601 UTC timestamps, no whitespace) and covered by golden tests.
- **[MEDIUM]** Every `@AuditLog()`-decorated command must have a unit test asserting that a command invocation produces exactly one audit entry with expected fields.

Research: `docs/research/hr-expert/2026-04-08-cqrs-audit-log-interceptor-payroll.md`
