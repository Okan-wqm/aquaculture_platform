# Research: Tenant Isolation Test Coverage in Multi-Tenant Systems

**Topic:** Testing tenant scoping (tenantId / search_path), cross-tenant access denial, SUPER_ADMIN impersonation audit, RLS policies in DB
**Date:** 2026-04-08
**Agent:** test-runner

## Sources

- [PostgreSQL Row-Level Security - postgresql.org/docs/current/ddl-rowsecurity.html](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL CREATE POLICY - postgresql.org/docs/current/sql-createpolicy.html](https://www.postgresql.org/docs/current/sql-createpolicy.html)
- [PostgreSQL Schemas - postgresql.org/docs/current/ddl-schemas.html](https://www.postgresql.org/docs/current/ddl-schemas.html)
- [PostgreSQL Search Path - postgresql.org/docs/current/runtime-config-client.html#GUC-SEARCH-PATH](https://www.postgresql.org/docs/current/runtime-config-client.html)
- [Martin Fowler: Multi-tenancy - martinfowler.com/articles/patterns-of-distributed-systems/multi-tenancy.html](https://martinfowler.com/articles/patterns-of-distributed-systems/)
- [Google Testing Blog: Testing on the Toilet: Test Behavior, Not Implementation - testing.googleblog.com/2013/08/testing-on-toilet-test-behavior-not.html](https://testing.googleblog.com/2013/08/testing-on-toilet-test-behavior-not.html)
- [Google Testing Blog: Test Sizes - testing.googleblog.com/2010/12/test-sizes.html](https://testing.googleblog.com/2010/12/test-sizes.html)
- [AWS DevOps Blog: Multi-tenant SaaS data isolation - aws.amazon.com/blogs/devops](https://aws.amazon.com/blogs/devops/)
- [AWS Builders Library: Multi-tenant SaaS Patterns](https://aws.amazon.com/builders-library/)
- [ThoughtWorks Tech Radar: Multi-tenant SaaS - thoughtworks.com/radar](https://www.thoughtworks.com/radar)
- [Testcontainers PostgreSQL - testcontainers.com/modules/postgresql](https://testcontainers.com/modules/postgresql/)
- [OWASP Testing Guide: Authorization Testing](https://owasp.org/www-project-web-security-testing-guide/)
- [OWASP IDOR - owasp.org/www-community/attacks/Insecure_Direct_Object_Reference](https://owasp.org/www-community/attacks/)

## Key Findings

### 1. The three failure modes of tenant isolation
Multi-tenant systems fail in three patterns; tests must cover all three:
- **Missing tenant filter**: a query that does not include `WHERE tenant_id = ?` or `SET search_path = tenant_X` returns rows from all tenants. Symptom: tenant A sees tenant B's data.
- **Wrong tenant filter**: a query uses the wrong tenant ID (e.g., from the requested entity rather than the requesting user). Symptom: tenant A modifies tenant B's data.
- **Cached / pooled tenant context**: a database connection retains the previous tenant's `search_path` after returning to the pool. Symptom: intermittent cross-tenant data leak under load.

A test suite that proves the happy path (each tenant sees their own data) but does not actively probe the three failure modes is incomplete and gives false confidence.

### 2. Per-handler test pattern: positive + negative + cross-tenant
Every handler that touches tenant-scoped data needs at minimum three tests:
- **Positive**: tenant A user requests their own data → returns tenant A data correctly.
- **Negative**: tenant A user requests an entity ID that does not exist for tenant A (could be tenant B's ID) → returns NotFound, not the cross-tenant entity.
- **Cross-tenant probe**: tenant A user explicitly requests tenant B's resource ID → returns 404 (NOT 403, which would confirm the resource exists). The distinction matters: 403 leaks existence, 404 does not.

The "404 not 403" rule is critical for IDOR prevention. A handler that returns 403 when the resource exists but belongs to another tenant is leaking information. Tests must explicitly assert 404, not "any error."

### 3. Search-path isolation tests (aqua-saas pattern)
- aqua-saas uses `SET search_path = tenant_<hash>, farm, public` per transaction. Tests must verify:
  - The search_path is set BEFORE any query in the transaction.
  - The search_path uses `SET LOCAL`, not `SET SESSION` (LOCAL is transaction-scoped, SESSION leaks across transactions in a pooler).
  - The search_path is RESET (or the connection returned to the pool releases LOCAL state automatically — `SET LOCAL` does this).
  - Tenant schema names match the regex `^tenant_[a-f0-9]{16}$` (or whatever the canonical regex is) before being interpolated into SQL — protecting against SQL injection via tenant ID.
- A pooler-level test: simulate two transactions on the same physical connection with different tenant IDs. Verify the second transaction does not see the first's search_path. This is the only test that catches `SET SESSION` bugs in the pooler — and it requires real PgBouncer, not testcontainers' Postgres alone.
- Pgbouncer in transaction-pooling mode is the production deployment. Integration tests SHOULD use a pgbouncer container in front of postgres to mirror the production connection behavior.

### 4. Row-Level Security (RLS) tests
- For services that use RLS (alternative to schema isolation), tests must verify:
  - The application connects with a NON-superuser, NON-BYPASSRLS role. Tests with a superuser DB user defeat RLS silently.
  - `SET LOCAL app.tenant_id = '<tenantId>'` is set per-transaction.
  - RLS policies on every tenant-scoped table reference `current_setting('app.tenant_id')` correctly.
  - Each table has separate USING and WITH CHECK policies (USING for SELECT/UPDATE/DELETE, WITH CHECK for INSERT/UPDATE).
  - Forced policies (`FORCE ROW LEVEL SECURITY`) prevent table owners from bypassing RLS.
- An RLS test that runs as a privileged user passes always — it tests nothing. The test setup MUST grant the test connection only the application role, never the migration role.
- Tests should explicitly attempt to break RLS: insert a row with a tenant_id different from `app.tenant_id` and assert the insert is rejected by WITH CHECK; update a row to change its tenant_id and assert the update is rejected; select with a different tenant context and assert empty result.

### 5. SUPER_ADMIN impersonation audit
- Aqua-saas has a SUPER_ADMIN role that can impersonate any tenant via `X-Act-As-Tenant` header. This is a privileged operation and MUST be audit-logged for compliance.
- Tests must verify:
  - SUPER_ADMIN with `X-Act-As-Tenant: <tenantId>` accesses that tenant's data successfully.
  - The audit log entry is written BEFORE the response is returned (not async fire-and-forget). A `recordAwait()` or equivalent synchronous audit pattern.
  - The audit log entry includes: SUPER_ADMIN user ID, target tenant ID, requested action, timestamp, IP address, request ID for correlation.
  - Non-SUPER_ADMIN users with the same header are REJECTED (privilege escalation prevention). If a regular user could set the header, they could impersonate any tenant.
  - Audit log entries are immutable (no UPDATE / DELETE) — verified by attempting to update an audit log row and asserting failure.
- A test that asserts SUPER_ADMIN can impersonate is positive; the test that asserts the audit log was written, and the test that asserts non-SUPER_ADMIN is rejected, are the security tests. Missing either is a CRITICAL finding.

### 6. Cross-tenant integration tests
- Unit tests cannot detect tenant scoping bugs in repository code (because the repository is mocked). Only integration tests against real Postgres with real schema isolation can.
- The canonical cross-tenant integration test:
  1. Create tenant A with schema `tenant_aaaa...`.
  2. Create tenant B with schema `tenant_bbbb...`.
  3. As tenant A user, insert a `Batch` row.
  4. As tenant B user (new transaction, new search_path), query `Batch` by the same ID — assert empty result.
  5. As tenant B user, attempt to update tenant A's `Batch` by ID — assert "not found" or "0 rows affected".
- This test runs against real Postgres in testcontainers (or against the test environment's real DB) and is the only ground-truth verification that tenant isolation works.
- Run this test against EVERY tenant-scoped repository, not just one as a smoke test. A `CrossTenantProbe` integration suite that iterates over all tenant-scoped entities is the systemic test.

### 7. NATS/Redis tenant scoping tests
- Tenant data also flows through NATS subjects and Redis keys. Tests must verify:
  - NATS subjects are tenant-prefixed (`tenants/<tenantId>/farm/batch.created`). A subject without tenant prefix on tenant data = CRITICAL.
  - Redis keys are tenant-namespaced (`tenant:<tenantId>:cache:batch:<id>`). Direct Redis access without prefix = CRITICAL.
  - Redis idempotency keys are scoped per-tenant (`msg:<tenantId>:idem:<key>`).
  - NATS subscribers verify the tenant prefix matches the requesting tenant context before processing.
- Tests should attempt to publish/consume on a NATS subject without tenant prefix and assert the subscriber rejects it.
- Cache key collision test: tenant A and tenant B both cache an entity with ID `batch-1`. The Redis keys must be different (`tenant:A:batch:batch-1` vs `tenant:B:batch:batch-1`). Reading tenant A's cache from a tenant B context must miss.

### 8. CrossTenantProbe watchdog
- aqua-saas runs a `CrossTenantProbe` background job that periodically attempts cross-tenant queries and alerts on success. Tests must verify:
  - The probe runs on schedule (interval, not on-demand).
  - The probe uses a known "honey-pot" record in tenant A and verifies tenant B context cannot read it.
  - The probe FAILS CLOSED on isolation breach: it pages on-call, blocks deploys, raises a Prometheus metric.
  - The probe itself is tenant-scoped — it does not use a privileged DB role that bypasses isolation (otherwise it would never fail).
- A probe that exists but is not tested is shelfware. The probe's failure path must have its own test.

### 9. SUPER_ADMIN test fixtures
- Test fixtures for SUPER_ADMIN must be cleanly separated from regular tenant fixtures. Mixing them risks tests inadvertently using SUPER_ADMIN context for what should be tenant-scoped operations, masking authorization bugs.
- Tests must include: SUPER_ADMIN can list all tenants; SUPER_ADMIN cannot impersonate without `X-Act-As-Tenant`; SUPER_ADMIN audit log entries are written before response; non-SUPER_ADMIN with the header is rejected with 403.
- The audit log assertion is critical: tests that mock the audit log mask the very compliance gap they should detect. Use a real audit log table in integration tests.

### 10. GraphQL federation and tenant scoping
- Each subgraph must independently verify tenant context. Trusting the gateway router blindly is a privilege escalation vector. Tests for each resolver must cover:
  - Resolver receives forwarded user context, extracts tenant ID, scopes query to that tenant.
  - Resolver rejects requests where the requesting tenant context does not match the resource's tenant.
  - `__resolveReference` handlers (used by federation entity resolution) verify tenant ownership before returning.
- A common federation bug: a resolver returns an entity by ID without checking tenant. The router has already authenticated the user; the resolver assumes the router did the tenant check; neither did. Result: cross-tenant data leak via federation entity reference.

### 11. Tenant context in NestJS request scope
- aqua-saas uses `@Inject(REQUEST)` and `Scope.REQUEST` providers to access the current tenant context per HTTP request.
- Tests must verify that:
  - The tenant context is set before any handler/resolver code runs (verified by middleware order tests).
  - The tenant context is cleared/regenerated per request (no leak between requests on the same Node process).
  - REQUEST-scoped providers don't cache tenant data across requests (a SINGLETON-scoped DataLoader on tenant data = CRITICAL — tests must verify Scope.REQUEST is used).

## Security Concerns

- **False positives are common:** a test that uses the same tenant ID for both fixture creation and verification trivially passes. Tests MUST use distinct tenant IDs and verify cross-tenant denial explicitly.
- **Test runner bypassing isolation:** if the test runner connects to Postgres as a superuser or migration role, RLS policies and search_path restrictions don't apply. Test connections MUST use the application role, with no extra privileges.
- **Schema name interpolation:** if a test passes `tenant_id = "abc'; DROP TABLE users;--"` and the application interpolates it into SQL, the test should fail with a clear error (regex validation), not silently execute SQL injection. The test for the SQL injection guard is itself a security test.
- **Audit log mocking:** tests that mock the audit log cannot detect missing audit entries. Audit log assertions MUST use the real audit table.
- **Test fixtures with weak tenant separation:** if test fixtures share data across tenants (e.g., a global "default tenant" used by every test), tests cannot detect cross-tenant bugs because they lack the cross-tenant scenario. Enforce per-test tenant fixtures.
- **Regression suite for prior tenant leaks:** every confirmed tenant leak incident must produce a regression test in the cross-tenant probe suite. Skipping this allows the same bug to recur.
- **TENANT_SCHEMA_REGEX bypass:** tests must verify that schema names not matching the regex are REJECTED, not just slow-pathed. A regex check that logs a warning but proceeds is a CRITICAL finding.

## Performance Concerns

- **Per-tenant test fixtures are slow:** creating a new tenant schema per test is ~200ms on Postgres 15. For a 100-test file, that is 20 seconds of pure setup. Reuse tenant schemas within a file via beforeAll, isolate via transaction rollback within tests.
- **Cross-tenant probe parallelism:** running cross-tenant probes against every entity in parallel can swamp the test DB. Serialize the probe suite to a single worker.
- **PgBouncer in tests:** running PgBouncer as a sidecar to Postgres in tests doubles the container startup cost (~5 seconds total). Worth it for tests of search_path leakage; not worth it for general tenant tests.
- **Audit log assertion cost:** querying the audit log table after every action is O(n) on table size. Use bounded test runs and clean the audit log per test.
- **RLS overhead in tests:** RLS adds ~10-20% query latency. This is real and reflects production cost; test suites should not artificially disable RLS for speed.

## Architectural Implications for test-runner reviews

When auditing tenant isolation tests, verify:

1. **Every tenant-scoped handler has cross-tenant negative tests:** tenant A requests tenant B's ID → 404. Missing = HIGH.
2. **`404 not 403` enforcement:** tests assert 404 when cross-tenant access denied, not generic error. 403 = HIGH (existence leak).
3. **Search_path tests use `SET LOCAL`:** tests verify `SET LOCAL` not `SET SESSION`. Wrong scope = CRITICAL.
4. **PgBouncer pooler test exists:** a test runs through pgbouncer and verifies search_path does not leak across transactions on the same connection. Missing = HIGH (production-only bug class).
5. **Test connections use application role**, never superuser/migration. Privileged test role = CRITICAL (defeats RLS and search_path restrictions).
6. **`CrossTenantProbe` integration suite** runs against every tenant-scoped entity. Missing or limited probe = HIGH.
7. **SUPER_ADMIN audit log assertions** use real audit table, not mocks. Mocked audit log on impersonation tests = CRITICAL (compliance gap masking).
8. **Non-SUPER_ADMIN rejection of `X-Act-As-Tenant`** explicitly tested. Missing = CRITICAL (privilege escalation gap).
9. **NATS subject tenant prefix** verified in subscriber tests. Subject without prefix = CRITICAL.
10. **Redis key tenant namespace** verified in cache tests. Direct Redis access without prefix = CRITICAL.
11. **Per-test tenant fixtures**, not shared "default tenant." Shared tenant across tests = HIGH (cannot detect cross-tenant bugs).
12. **TENANT_SCHEMA_REGEX validation tests:** tests pass invalid schema names and assert rejection. Missing = HIGH (SQL injection risk).
13. **Federation `__resolveReference` tenant check tests:** every resolver tested for cross-tenant entity resolution attempts. Missing = HIGH.
14. **REQUEST-scoped DataLoader tests:** verify DataLoader is recreated per request, not shared singleton. Singleton DataLoader on tenant data = CRITICAL.
15. **Regression tests for confirmed tenant leaks:** every past incident has a corresponding test in the regression suite. Missing = HIGH (incident recurrence risk).

## Domain Rule Additions for test-runner

- Every tenant-scoped command/query handler MUST have tests covering: positive same-tenant access, negative cross-tenant access (returns 404 not 403), and tenant-context-missing rejection. Missing any = HIGH finding.
- Cross-tenant denial tests MUST assert `404 NOT FOUND`, not 403 or generic error. 403 on cross-tenant = HIGH (existence leak).
- Search_path tests MUST verify `SET LOCAL` semantics, not `SET SESSION`. Wrong scope in test or production = CRITICAL.
- Integration test suite MUST include a pgbouncer-pooler test that validates search_path does not leak across transactions on the same physical connection. Missing = HIGH.
- Test database connections MUST use the application (non-superuser, non-BYPASSRLS) role. Test connections with elevated privileges = CRITICAL (defeats RLS / search_path restrictions).
- A `CrossTenantProbe` integration suite MUST exist and cover EVERY tenant-scoped entity. Missing entities = HIGH per missing entity.
- SUPER_ADMIN impersonation tests MUST assert audit log persistence using the REAL audit table (not mocks). Mocked audit log = CRITICAL.
- SUPER_ADMIN impersonation audit log entries MUST be written synchronously via `recordAwait()` (or equivalent guaranteed-write pattern) BEFORE the response is returned. Async fire-and-forget = CRITICAL.
- Non-SUPER_ADMIN users with `X-Act-As-Tenant` header MUST be rejected. A test for this rejection = MANDATORY.
- NATS subject tenant prefix MUST be tested in every subscriber test. Subject prefix bypass test missing = HIGH.
- Redis key tenant namespacing MUST be tested in every cache/idempotency test. Direct Redis access without namespace = CRITICAL.
- Test fixtures MUST create per-test tenant data, not share a "default tenant" across tests. Shared tenant fixtures = HIGH (cannot detect cross-tenant bugs).
- TENANT_SCHEMA_REGEX validation tests MUST exist: tests that pass malformed schema names (`tenant_'; DROP TABLE--`, `tenant_../etc/passwd`, etc.) and assert rejection. Missing = HIGH.
- GraphQL federation `__resolveReference` resolvers MUST have tests for cross-tenant entity resolution attempts. Resolver returns null/throws on tenant mismatch. Missing = HIGH.
- DataLoader instances on tenant-scoped data MUST be tested for `Scope.REQUEST` lifetime. Singleton DataLoader = CRITICAL.
- Every confirmed tenant leak incident MUST produce a regression test in the cross-tenant probe suite within one sprint. Recurring incidents without regression test = SYSTEMIC (architectural issue).
- REQUEST-scoped providers holding tenant context MUST be tested for per-request isolation (no leak between requests on the same Node process). Missing test = HIGH.
