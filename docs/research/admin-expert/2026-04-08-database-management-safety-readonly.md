# Research: Database Management Safety & Production Read-Only Enforcement

**Topic:** Production DB explorer read-only enforcement, migration allowlist, SQL injection in admin tools, schema operation tenant isolation
**Date:** 2026-04-08
**Agent:** admin-expert

## Sources

- [SQL Injection Prevention Cheat Sheet — OWASP](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html)
- [Database Security Cheat Sheet — OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Database_Security_Cheat_Sheet.html)
- [Injection Prevention Cheat Sheet — OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Injection_Prevention_Cheat_Sheet.html)
- [A05:2025 Injection — OWASP Top 10](https://owasp.org/Top10/2025/A05_2025-Injection/)
- [PostgreSQL Documentation: Predefined Roles](https://www.postgresql.org/docs/current/predefined-roles.html)
- [Managing PostgreSQL users and roles — AWS Database Blog](https://aws.amazon.com/blogs/database/managing-postgresql-users-and-roles/)
- [Multi Tenant Security Cheat Sheet — OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html)

## Key Findings

### 1. Admin DB access must run as a distinct, least-privileged role — not the app role
OWASP Database Security Cheat Sheet and the AWS guidance agree: DBA or admin-type access should not be assigned to application accounts. The master user should never be used by the application. For the admin-api-service DB explorer specifically, this means:
- A dedicated PostgreSQL role, e.g., `admin_explorer_readonly`, created with only `CONNECT`, schema `USAGE`, and `SELECT` permissions.
- The backend MUST switch connection pools based on the endpoint — the DB explorer endpoints use the read-only pool; migration endpoints use a separate, migration-role pool.
- Granting the application's service role SELECT is not sufficient; the role MUST be separate so even a compromised explorer endpoint cannot write.

### 2. PostgreSQL predefined roles that map directly to the platform's needs
From the PostgreSQL docs:
- `pg_read_all_data` — SELECT on all tables + USAGE on all schemas. Does NOT bypass row-level security. Ideal for the DB explorer read-only role.
- `pg_monitor` — statistics, configuration, monitoring views. Ideal for the database monitoring dashboard.
- `pg_read_all_stats`, `pg_read_all_settings`, `pg_stat_scan_tables` — granular monitoring subsets.
- `pg_read_server_files`, `pg_execute_server_program`, `pg_write_server_files` — **must NEVER be granted** to admin tool roles; they bypass database-level permission checks and can be used to gain superuser-level access.

### 3. Read-only enforcement must be defense-in-depth (not just a UI hint)
A read-only guarantee at the application layer alone is insufficient because:
- Direct SQL input (the point of a DB explorer) can contain multiple statements.
- A parser bug or bypass in the "is this read-only?" check becomes an instant write primitive.

Defense in depth for the DB explorer:
1. **Frontend:** hide write controls, but never trust this layer.
2. **Application layer:** parse the SQL and reject any statement whose top-level command is not `SELECT` / `EXPLAIN` / `SHOW`. Reject multi-statement payloads. Reject CTEs with `INSERT`/`UPDATE`/`DELETE`/`MERGE` inside.
3. **Transaction layer:** open the connection with `SET TRANSACTION READ ONLY` before executing user SQL.
4. **Role layer:** the underlying PostgreSQL role has no write grants at all. This is the only layer that is actually enforced by the database engine.
5. **Timeout layer:** `SET LOCAL statement_timeout = '5s'` to prevent runaway queries.
6. **Row limit layer:** wrap the user query in a `LIMIT` cap (e.g., 1000 rows) to prevent accidental memory blowup and data exfiltration of entire tables.

### 4. SQL injection in admin tools: admin UI is NOT a safe zone
OWASP A05:2025 and the SQL Injection Prevention cheat sheet both emphasize: "admin interfaces" are not exempt from SQL injection rules. Even though only SUPER_ADMIN can reach the DB explorer, the explorer itself forwards arbitrary strings to the database. Threat model:
- A compromised SUPER_ADMIN account (phished credentials) becomes a data exfiltration tool for every tenant.
- Stored XSS in any admin-rendered field (e.g., tenant name) can ride on a SUPER_ADMIN session to trigger admin-privileged DB queries.
- Indirect injection: admin tools that take a "table name" or "column name" parameter and concatenate into SQL are vulnerable. Use identifier validation against an allowlist pulled from `information_schema`, not regex.

### 5. Migrations must run from an allowlist, not from user input
OWASP and AWS both enforce the principle of least functionality. For migration endpoints:
- No endpoint may accept arbitrary SQL and execute it as a migration.
- The set of migrations is the file-system list discovered by the migration runner at deploy time. The admin endpoint only chooses from that allowlist (e.g., `apply next pending migration`, `show migration history`).
- Migration operations MUST run as a role separate from both the app role and the read-only explorer role: e.g., `migrator` with DDL grants scoped to specific schemas.
- Migration operations MUST be tenant-schema-aware: applying a migration to one tenant's schema must never affect another's.

### 6. Backup and restore: audit + dual control
OWASP Database Security guidance and practical PAM patterns converge on:
- Backups and restores must log who initiated, what tenant/scope was affected, and the size/rows restored.
- Restore operations (destructive) should require dual control — a second SUPER_ADMIN approval before execution, similar to a cold-storage withdrawal pattern.
- Restore targets a staging DB, not production. Selective restore into production should be a manual DBA operation, not a web admin UI action.

### 7. Schema operations must respect tenant isolation
The platform uses `search_path`-based schema-per-tenant isolation. Schema operations from the admin panel must:
- Validate that the target schema belongs to the target tenant (cross-reference the `tenants` registry before running).
- Never accept a schema name string directly from the request — always resolve via tenant ID.
- Never allow `public` as a target schema for tenant operations (the platform already enforces this for farm/db writes per recent commits; admin tool endpoints must apply the same guard).
- `DROP SCHEMA CASCADE` requires explicit confirmation and is audited as a CRITICAL event.

## Security Concerns

- **Write bypass via CTE:** `WITH x AS (INSERT INTO ... RETURNING *) SELECT * FROM x` starts with `WITH`/`SELECT` but performs a write. A naive "starts with SELECT" parser is bypassed. Parse the AST, not the prefix.
- **Multi-statement injection:** `SELECT 1; DROP TABLE ...` — many drivers permit multi-statement queries. Disable them at the driver level AND reject at the parser level.
- **Information_schema exfiltration:** even read-only, the DB explorer can enumerate every tenant's schema structure and sample rows. This is effectively a cross-tenant data read primitive. Enforce a tenant-scoped view: the explorer should only show the tenant selected by the admin, not all tenants simultaneously.
- **Identifier injection:** `SELECT * FROM "${tableName}"` where `tableName` is user input concatenated into a quoted identifier is still injectable (backtick/quote injection). Use parameterized identifiers where available; otherwise validate against `information_schema` and quote with a safe helper.
- **Role grant drift:** a migration that `GRANT ALL ON SCHEMA ... TO admin_explorer_readonly` accidentally promotes the read-only role. Grant audits must run in CI; the explorer role's grants must match a canonical allowlist.
- **Statement logging leaking PII:** if the DB explorer logs every query to stdout, user data from `WHERE email = '...'` clauses ends up in log files. Log the query text with bind parameter redaction.

## Performance Concerns

- Unbounded `SELECT *` against a 10M-row table by a curious admin can lock pages and trigger I/O storms. Always wrap user queries in `SET statement_timeout` (5s default) and `LIMIT` (1000 rows default).
- Explain analyze on an unbounded query can be as expensive as running the query itself. Disallow `EXPLAIN ANALYZE` in production or gate it behind a "heavy query" allowlist.
- Connection pool separation (readonly vs. migrator vs. app) increases pool count; pool sizing must be tuned to keep total connections under PostgreSQL's `max_connections`.

## Architectural Implications for admin-expert reviews

When reviewing `database-management/*` controllers and services, enforce:
1. Separate DB roles for explorer (read-only), migrator (DDL), and monitoring (pg_monitor). No sharing with the app role.
2. DB explorer endpoints pin their query connection to the read-only pool and open the session with `SET TRANSACTION READ ONLY`.
3. SQL parser validates top-level command, multi-statement absence, and CTE contents before execution.
4. Row-limit wrapping (`LIMIT 1000` default) and `statement_timeout` on every user query.
5. Migration endpoints expose only an allowlist of known migrations discovered at deploy time; no arbitrary SQL input.
6. Migration endpoints resolve the target schema from a tenant UUID, never accept a schema name from the client.
7. Every backup/restore operation writes an audit row including initiator, scope, byte count, and result; restores require dual control.
8. Every schema operation (CREATE/DROP/ALTER) is audited as a CRITICAL severity event and requires the caller to be SUPER_ADMIN AND out of any active impersonation session.
9. Explorer queries must be logged with bind parameters redacted; PII in raw queries must be masked before persistence.
10. `public` schema is never a valid target for tenant-scoped operations from admin endpoints.
11. The explorer UI must show tenant context prominently; cross-tenant data in a single result set is forbidden.

## Domain Rule Additions for admin-expert

- Database explorer endpoints MUST use a dedicated PostgreSQL role with only CONNECT/USAGE/SELECT grants (e.g., via `pg_read_all_data` membership); the application service role MUST NOT be used.
- Read-only enforcement MUST use defense-in-depth: (1) SQL parser top-level validation, (2) multi-statement rejection, (3) CTE write rejection, (4) `SET TRANSACTION READ ONLY`, (5) role without write grants, (6) statement timeout, (7) row limit wrapper. All seven layers required.
- Migration endpoints MUST select from a deploy-time allowlist of known migration identifiers; accepting arbitrary SQL is a CRITICAL finding.
- Migration operations MUST resolve target schema from tenant UUID via the tenant registry; accepting schema names directly is a CRITICAL finding.
- Backup/restore operations MUST log initiator, scope, result, and byte count; restore to production MUST require dual SUPER_ADMIN control.
- Schema operations (CREATE/DROP/ALTER) MUST be audited as CRITICAL events and rejected if the caller is inside an active impersonation session.
- DB explorer result logs MUST redact bind parameters before persistence; raw WHERE-clause values with PII are log-injection/PII-leak findings.
- `information_schema` queries from the admin explorer MUST be tenant-scoped; returning cross-tenant schema listings is a CRITICAL finding.
- `pg_read_server_files`, `pg_execute_server_program`, `pg_write_server_files` MUST NEVER be granted to any admin-tool role.
- All identifier substitutions (table/column/schema names) MUST be validated against `information_schema` allowlists; string concatenation into quoted identifiers is forbidden.
