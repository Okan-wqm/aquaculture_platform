# Research: Audit Log Immutability, CRLF Injection, PII Masking & Compliance

**Topic:** Append-only audit tables, CRLF injection in logs, PII masking, query RBAC on audit, retention, SOC2/ISO27001
**Date:** 2026-04-08
**Agent:** admin-expert

## Sources

- [A09:2025 Security Logging and Alerting Failures — OWASP Top 10](https://owasp.org/Top10/2025/A09_2025-Security_Logging_and_Alerting_Failures/)
- [Logging Cheat Sheet — OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [Logging Vocabulary Cheat Sheet — OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html)
- [Log Injection — OWASP Community](https://owasp.org/www-community/attacks/Log_Injection)
- [CRLF Injection — OWASP Foundation](https://owasp.org/www-community/vulnerabilities/CRLF_Injection)
- [CWE-117: Improper Output Neutralization for Logs](https://cwe.mitre.org/data/definitions/117.html)
- [NIST SP 800-53 Rev 5 (AU-2, AU-3, AU-9, AU-10, AU-11)](https://csrc.nist.gov/CSRC/media/Projects/risk-management/800-53%20Downloads/800-53r5/SP_800-53_v5_1-derived-OSCAL.pdf)
- [SOC 2 CC7.2 Explained — ISMS.online](https://www.isms.online/soc-2/controls/system-operations-cc7-2-explained/)
- [PCI DSS v4.0 Requirement 10 — Audit Logging](https://www.pcisecuritystandards.org/document_library/)
- [ISO/IEC 27001:2022 Annex A.8.15 (Logging)](https://www.iso.org/standard/27001)

## Key Findings

### 1. Audit integrity requires append-only, not "strong permissions"
OWASP Top 10 A09 and NIST SP 800-53 AU-9 are explicit: audit trails require *integrity controls* that prevent tampering or deletion, such as append-only database tables. Common implementation approaches:
- PostgreSQL table with a `BEFORE UPDATE` and `BEFORE DELETE` trigger that raises an exception.
- Separate PostgreSQL role that owns the audit table; the application's normal role can only `INSERT`.
- Hash-chain pattern: each row contains a `prev_hash` of the previous row, making retrospective insertion detectable.
- Offsite mirror (S3 Object Lock / Glacier Vault Lock) for tamper-evident archival beyond the retention window.

For the platform, the minimum bar is: application role has INSERT-only, a DBA-only role has SELECT, and UPDATE/DELETE are blocked by trigger. Hash chaining is recommended but optional.

### 2. Log injection (CWE-117) via CRLF is a real vulnerability in structured logs
OWASP and Veracode both describe the attack: an attacker inserts `\r\n` into a user-controlled field that flows into a log line, forging a new log entry or confusing log parsers. Scenarios in admin tools:
- Username field: `admin\nLOG: SUPER_ADMIN logged in successfully`
- Tenant name containing newlines.
- JSON-formatted logs where attacker closes the JSON object and injects a new one.

Prevention:
- **Structured logging only (JSON):** NestJS `Logger` is fine as long as log sinks serialize with a library that escapes control characters, not with naive string interpolation.
- **Encode before emit:** any user-supplied field written into a log line must go through JSON-safe encoding that escapes `\r`, `\n`, `\t`, and non-printable characters.
- **Length limits:** cap per-field log length to prevent log flooding.
- **Library trust boundary:** avoid writing user input into the log message *template* — pass it as a metadata field that the logging library escapes.

Concrete rule for the platform: `Logger.log('User ' + username + ' did X')` is a CRLF injection vector. `Logger.log('user action', { username, action: 'X' })` is safe because the logger escapes the metadata.

### 3. PII masking in audit logs: mandatory, not optional
NIST, OWASP, and SOC2 CC6.1 all require that logs not become a secondary PII store. Platform rules:
- Never log raw email, phone, or full name. Use a stable hash (`sha256(normalized_email)`) or redact (`j***@example.com`).
- Never log authentication secrets: passwords, session tokens, JWTs, webhook secrets, API keys. Blocklist these field names in a central log sanitizer.
- Never log full request bodies for endpoints that accept credentials.
- Regulatory specifics:
  - **GDPR Article 32:** pseudonymization of PII required where feasible.
  - **PCI DSS Req 3:** never store PAN in logs.
  - **HIPAA:** PHI in logs must be encrypted at rest with audited access.

### 4. Query RBAC on the audit log itself
Reading the audit log is itself a sensitive operation. Access rules:
- **SUPER_ADMIN:** may read platform-wide audit with filters.
- **TENANT_ADMIN:** may read only audit rows scoped to their own tenant.
- **MODULE_MANAGER / MODULE_USER:** no audit read access.
- **Reading the audit log generates an audit row** (meta-audit). This is the "who watches the watchers" rule and is mandatory for SOC2 and ISO27001 access reviews.
- Audit-log queries must NOT return cross-tenant rows even to SUPER_ADMIN without an explicit cross-tenant flag AND an audit write for that query.

### 5. Retention policy aligned to compliance
Retention windows cited in the sources:
- **PCI DSS 10.7:** at least 12 months, 90 days immediately queryable.
- **SOC2 CC7.2:** "appropriate retention" typically interpreted as 12 months online + archived for longer.
- **HIPAA:** 6 years.
- **GDPR:** no absolute number, but must match documented RoPA and not exceed purpose limitation.
- **ISO 27001 A.8.15:** documented retention based on legal/contractual requirements.

Platform minimum: **13 months online, 7 years archived** (covers HIPAA and SOC2 with margin). Tenant-configurable override for stricter jurisdictions.

Automated pruning must:
- Run as a scheduled job with audit of its own operation.
- Archive to immutable storage before deletion.
- Never delete audit rows inside the active window, even under retention pressure.

### 6. Audit event coverage (what must be logged)
NIST SP 800-53 AU-2 requires the organization to define an auditable event list. For the admin-expert scope, the non-negotiable list is:
- **Authentication:** login success/failure, MFA challenge issued/verified, password change, session termination.
- **Impersonation:** start, terminate, mode toggle, every action inside an active session (dual identity).
- **Cross-tenant access:** every `X-Act-As-Tenant` request.
- **Tenant lifecycle:** state transitions, purge, archival.
- **Billing:** plan change, refund, void, subscription status change.
- **Database management:** every DDL, every migration, every backup/restore, every explorer query (metadata only, not the result set).
- **User management:** role changes, permission grants/revocations, user creation/deletion.
- **Configuration:** changes to global settings, email templates, IP allowlists, tenant configs.
- **Audit-log access:** every query against the audit table.

### 7. Time sync and trusted clock
Audit timestamps are worthless if the system clock drifts. NIST SP 800-53 AU-8 requires clock synchronization with an authoritative source. Platform rule:
- All audit timestamps in UTC, ISO 8601 with microsecond precision.
- All database nodes and application nodes sync to the same NTP source (or cloud provider's managed time service).
- Audit rows include a server-generated timestamp — never trust client-side timestamps.

### 8. Alerting on audit anomalies
OWASP A09 treats failure to alert as a Top 10 category. Platform must alert on:
- Burst of failed auth attempts against one user (credential stuffing).
- A single SUPER_ADMIN touching > N tenants in < 1 hour (anomaly).
- Impersonation sessions in write mode initiated outside business hours.
- Refunds above threshold.
- Audit table write failures (silent data loss).
- Audit table UPDATE/DELETE attempts (intrusion indicator).

## Security Concerns

- **Trigger bypass via superuser:** `BEFORE UPDATE` triggers can be bypassed by the PostgreSQL superuser. Application must not run as superuser. Superuser access must be restricted to a break-glass account stored in a sealed credential vault.
- **Log injection via JSON assembly errors:** a log library that concatenates JSON strings naively can be injected if user input contains `"}` sequences. Always use a proven JSON serializer.
- **Stack trace PII leakage:** exception messages from ORM libraries often include row values. Sanitize exception messages before logging.
- **Audit query performance turning into information leak:** if the audit search endpoint returns results without proper RBAC filtering, a TENANT_ADMIN might enumerate other tenants' events via crafted filters. Always apply tenant scope at the query builder level, never via client-controlled WHERE clause.
- **Retention policy race:** if pruning runs during an active investigation, evidence may be destroyed. Add a "legal hold" flag that pins rows from pruning.
- **Structured log field explosion:** adversarial actors can add unique query parameters to generate high-cardinality log fields and explode log storage costs. Enforce field-name allowlists in the log pipeline.
- **Audit table as write DoS target:** if every request writes N audit rows and the audit table is shared across tenants, high-volume tenants starve others. Partition the audit table by month and by tenant hash bucket.

## Performance Concerns

- INSERT-only pattern with no updates plays well with PostgreSQL; BRIN indexes on timestamp are more efficient than BTREE for append-only tables.
- Monthly partitioning of the audit table is recommended: simplifies pruning (DROP PARTITION) and keeps indexes small.
- Hash chaining adds per-insert overhead (read previous row, compute hash, write). Batch inserts from the outbox amortize this.
- Audit queries should use read replicas. The primary audit write path must not compete with long-running admin audit searches.
- Full-text search on audit log metadata is expensive; use GIN indexes on JSONB metadata columns only for fields the UI actually filters by.

## Architectural Implications for admin-expert reviews

When reviewing `audit/*` and security monitoring code, enforce:
1. The audit table(s) have `BEFORE UPDATE` and `BEFORE DELETE` triggers that RAISE EXCEPTION.
2. The application service role has only INSERT privilege on audit tables; SELECT is a separate role used by a dedicated audit-read service.
3. All audit writes use structured JSON metadata; no string-concatenated log messages.
4. A central log sanitizer blocklist strips passwords, tokens, secrets, and masks PII before persistence.
5. All audit records include: actor_user_id, actor_role, tenant_id (or `_PLATFORM_` for platform-wide), event_type, resource_type, resource_id, ip, user_agent, request_id, timestamp_utc, result.
6. Reading the audit log produces a meta-audit row in the same table.
7. Audit-read endpoints enforce RBAC at the query-builder level, never via client-controlled filters.
8. Retention pruning runs as a scheduled job, honors a `legal_hold` flag, archives to immutable storage before deletion, and audits its own operation.
9. Audit tables are partitioned by month; indexes are BRIN on timestamp, BTREE on actor/tenant.
10. Alert rules exist for: failed-auth bursts, SUPER_ADMIN cross-tenant anomaly, write-mode impersonation off-hours, audit table UPDATE/DELETE attempts, audit write failures.
11. Timestamps are server-generated UTC; client timestamps are logged separately as `client_timestamp` but never used as the canonical time.
12. CRLF/control-character encoding is verified in the logging helper; reviewers must reject code that interpolates user input into log message strings.
13. Audit tables are exempt from the platform's standard write guards but subject to their own stricter invariants (no UPDATE/DELETE).

## Domain Rule Additions for admin-expert

- Audit tables MUST enforce append-only via `BEFORE UPDATE` and `BEFORE DELETE` triggers; UPDATE/DELETE from application code is a CRITICAL finding.
- The application service role MUST have INSERT-only on audit tables; SELECT MUST be granted via a separate role used by a dedicated audit-read path.
- User-supplied values MUST be passed as structured metadata to the NestJS Logger, never interpolated into the log message template (CRLF log injection prevention).
- A central log sanitizer MUST strip passwords, tokens, session IDs, JWTs, webhook secrets, and API keys from all log output, and MUST mask PII (email hashed, phone masked, names redacted).
- Audit records MUST include: actor_user_id, actor_role, tenant_id, event_type, resource_type, resource_id, ip, user_agent, request_id, server_timestamp_utc, result.
- Reading the audit log MUST emit a meta-audit row; "who watches the watchers" is mandatory for SOC2/ISO27001.
- TENANT_ADMIN audit-read queries MUST be scoped at the query-builder level to their own tenant; cross-tenant filters from client input are CRITICAL findings.
- Audit retention pruning MUST honor a `legal_hold` flag, archive to immutable storage before deletion, and audit its own operation.
- Audit tables MUST be partitioned by month with BRIN indexes on timestamp for query performance.
- Alert rules MUST exist for failed-auth bursts, SUPER_ADMIN cross-tenant anomalies, write-mode impersonation off-hours, audit write failures, and audit tamper attempts.
- Server-generated UTC timestamps MUST be the canonical audit time; client timestamps are optional metadata only.
- The platform retention window MUST be at least 13 months online plus 7 years archived unless superseded by stricter tenant-specific requirements.
- Audit tables MUST be exempt from the standard write guards but MUST have their own tamper-evident invariants enforced by triggers.
