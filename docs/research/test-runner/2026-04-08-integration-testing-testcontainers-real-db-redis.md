# Research: Integration Testing with Testcontainers (Real PostgreSQL + Redis)

**Topic:** Testcontainers pattern, real PostgreSQL + Redis fixtures, isolation, cleanup, vs mocks-everything (London school) debate
**Date:** 2026-04-08
**Agent:** test-runner

## Sources

- [Testcontainers Node.js Documentation - node.testcontainers.org](https://node.testcontainers.org/)
- [Testcontainers Modules: PostgreSQL - testcontainers.com/modules/postgresql](https://testcontainers.com/modules/postgresql/)
- [Testcontainers Modules: Redis - testcontainers.com/modules/redis](https://testcontainers.com/modules/redis/)
- [Testcontainers Best Practices - testcontainers.com/guides/working-with-jvm-link-jdbc-driver](https://testcontainers.com/guides/)
- [Martin Fowler: Integration Test - martinfowler.com/bliki/IntegrationTest.html](https://martinfowler.com/bliki/IntegrationTest.html)
- [Martin Fowler: TestDouble - martinfowler.com/bliki/TestDouble.html](https://martinfowler.com/bliki/TestDouble.html)
- [Martin Fowler: Mocks Aren't Stubs - martinfowler.com/articles/mocksArentStubs.html](https://martinfowler.com/articles/mocksArentStubs.html)
- [Google Testing Blog: Test Sizes - testing.googleblog.com/2010/12/test-sizes.html](https://testing.googleblog.com/2010/12/test-sizes.html)
- [Google Testing Blog: Hermetic Servers - testing.googleblog.com/2012/10/hermetic-servers.html](https://testing.googleblog.com/2012/10/hermetic-servers.html)
- [Google Testing Blog: Just Say No to More End-to-End Tests - testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html](https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html)
- [ThoughtWorks Tech Radar: Testcontainers - thoughtworks.com/radar/tools/testcontainers](https://www.thoughtworks.com/radar/tools/testcontainers)
- [Kent C. Dodds: Write Tests. Not Too Many. Mostly Integration. - kentcdodds.com/blog/write-tests](https://kentcdodds.com/blog/write-tests)
- [Test Containers Reuse - testcontainers.com/guides/reusing-containers](https://testcontainers.com/guides/reusing-containers/)

## Key Findings

### 1. Why testcontainers over in-memory or shared dev DB
- In-memory PostgreSQL substitutes (pg-mem, mock-pg) implement only a subset of SQL — they silently accept queries that fail in real Postgres (e.g., partition syntax, search_path semantics, advisory locks, `FOR UPDATE SKIP LOCKED`, JSONB operators, pgvector). For the aqua-saas platform, every one of these features is in active use, so an in-memory DB will pass tests that fail in production.
- A shared dev DB destroys test isolation: parallel tests trip on each other's rows, fixtures must use unguessable IDs, cleanup races leave orphan data, and any developer ad-hoc query corrupts the suite. Testcontainers gives every test run a fresh, hermetic Postgres instance that dies with the JVM/Node process.
- Testcontainers Node.js (`@testcontainers/postgresql`, `@testcontainers/redis`) starts a Docker container per test run with measured cold start ~2-4 seconds for Postgres 15, ~500ms for Redis 7. Once running, queries hit a real database with the real protocol, real planner, real index behavior.
- Hermetic principle (Google Testing Blog): a test that depends on external state is not a unit or integration test, it is a flaky test waiting to fail. Testcontainers lets integration tests be hermetic without sacrificing realism.

### 2. Container lifecycle strategies
- **Per-test container**: cleanest isolation, slowest. Cold-start a new Postgres for every `it()` block. Acceptable only for slow-changing schemas with <10 tests per file. Wallclock cost: minutes per file.
- **Per-file container**: most common pattern. Spin up Postgres in `beforeAll`, drop it in `afterAll`. Inside the file, isolate via transaction rollback (every test runs in a transaction that is rolled back in `afterEach`) or via `TRUNCATE ... RESTART IDENTITY` of all touched tables.
- **Per-suite (shared) container**: spin up once per Jest worker process and reuse across all files in that worker. Fastest. Requires careful per-test cleanup discipline. Use `testcontainers` reuse mode (`withReuse()`) on local dev to avoid container churn during watch mode.
- **Globally shared container in CI**: requires a sidecar service in GitHub Actions (`services: postgres:`), not testcontainers. Avoids the Docker-in-Docker overhead but loses the per-run hermetic guarantee. Acceptable when the test suite uses transaction rollback or schema-per-test isolation rigorously.

### 3. Fixture isolation patterns
- **Transaction rollback** (preferred for read-heavy tests): each test starts a transaction, runs queries, rolls back. Pro: zero data leakage, fast. Con: cannot test code paths that themselves manage transactions (e.g., outbox pattern, savepoints, distributed transactions, `LISTEN/NOTIFY`).
- **TRUNCATE between tests**: `TRUNCATE table1, table2 RESTART IDENTITY CASCADE` in `afterEach`. Pro: works for code that owns its own transactions. Con: must enumerate all touched tables (or truncate the entire schema), slower than rollback (~50-100ms per truncate).
- **Schema-per-test**: `CREATE SCHEMA test_<random>` in `beforeEach`, drop in `afterEach`. Maximally isolated. Required for testing tenant search_path code (which itself manipulates schemas). Cost: ~200ms per test for schema create/drop on Postgres 15.
- **Database-per-worker**: each Jest worker connects to a uniquely named database within the same Postgres container. `CREATE DATABASE test_worker_<id>` once, all tests in that worker share it, drop on worker exit. Combines container reuse with worker-level isolation.

### 4. Migrations and schema state
- Integration tests must run against the same schema as production. The test bootstrap MUST execute the migration runner against the test database before any test runs — never `synchronize: true` (TypeORM auto-schema), never hand-written SQL.
- Migration tests are a separate concern: a "schema state" test asserts that running all migrations produces a specific structure (column types, indexes, FKs, partition definitions). These tests catch migration drift between dev and prod environments.
- Seeding: integration tests should seed minimal fixtures (one tenant, one user, one channel) via the same DAO/repository code that production uses. Inserting via raw SQL bypasses entity hooks and produces incorrect baseline state.
- Tenant-scoped tests (the aqua-saas case): the test bootstrap must `CREATE SCHEMA tenant_<hash>` and run tenant-scoped migrations into it, then `SET search_path = tenant_<hash>, farm, public` inside each test transaction. Skipping this = false negatives on multi-tenant code.

### 5. Redis fixtures and isolation
- Redis testcontainers start in <500ms. Per-worker reuse is straightforward: each worker uses a unique Redis logical DB number (`SELECT 0..15`) for isolation. Beyond 16 workers, use a Redis prefix per worker.
- `FLUSHDB` between tests is acceptable but expensive on large datasets. Prefer per-test key prefixing (`test:<test-name>:*`) and bulk delete via `SCAN + DEL` in `afterEach`.
- Redis Streams, Pub/Sub, and Lua scripts behave differently from in-memory mocks. Testing rate limiters, idempotency keys, and presence requires real Redis — `ioredis-mock` lacks SCAN, EXPIRE jitter, and WAIT semantics.
- For tests that exercise expiry behavior (`SET ... EX 10`), use `redis-mock`'s time-travel API or `redis.debug('sleep')` (Redis 7+) — never `setTimeout` waits longer than 100ms (flake source).

### 6. The London-school vs Detroit-school debate (mock-everything vs real-deps)
- **London school (mockist):** every collaborator is mocked at the unit boundary. Tests are isolated, fast, fragile to refactoring (a method rename breaks 50 tests). Strong on TDD discipline, weak on detecting integration bugs (because the mocks were written by the same person who wrote the implementation, they share blind spots).
- **Detroit school (classicist):** test the unit + its real collaborators end-to-end. Slower, more robust, better at catching integration bugs. Martin Fowler's "Mocks Aren't Stubs" distinguishes the two and concludes that the right balance depends on whether your unit is a "command" (state mutation) or a "query" (computation).
- **Modern consensus (Kent C. Dodds, ThoughtWorks):** "Write tests. Not too many. Mostly integration." Unit tests for pure logic, integration tests (with real DB and Redis via testcontainers) for command handlers and queries, very few E2E tests for critical user flows. Mocking the database in command handler tests produces tests that pass when the SQL is wrong.
- **Specific aqua-saas guidance:** for CQRS handlers that touch tenant-scoped Postgres + Redis idempotency + outbox pattern, integration tests with testcontainers are the only correct approach. Mocking the repository would mock away exactly the bugs that cause production incidents (search_path drift, missing tenant filter, race conditions on outbox).

### 7. Cleanup discipline
- Every integration test MUST guarantee teardown even on failure. Use `afterEach` and `afterAll` with explicit error swallowing — a teardown that throws masks the original test failure.
- Container teardown must handle SIGINT/SIGKILL (CI cancellation): testcontainers' Ryuk reaper container cleans up orphaned containers automatically on container exit. Disabling Ryuk (`TESTCONTAINERS_RYUK_DISABLED=true`) on a CI runner without alternative cleanup leaks containers indefinitely.
- Test data builders MUST be deterministic about IDs (use UUIDs generated per test, never sequential integers shared across tests) to prevent collision when parallelism increases.
- Outbox-pattern tests must explicitly drain the outbox (set all rows to PUBLISHED or TRUNCATE) in `afterEach` — leaving rows leaks state into the next test.

### 8. Parallelism limits
- Postgres on a laptop can serve ~50 concurrent connections comfortably; CI runners with 4 vCPUs hit lock contention at ~10-15 concurrent integration test workers. Tune `--maxWorkers=4` for CI integration runs, not the default `50%`.
- Each Jest worker should hold its own DB connection pool (`max: 5`); shared pools cause cross-worker query interleaving and false positives.
- Docker daemon throttling: testcontainers shares the host Docker socket. On a 4-core CI runner, more than 4 concurrent containers degrades startup time non-linearly. Use `pool: { min: 1, max: 1 }` semantics for test container instantiation.

## Security Concerns

- **Test container exposure:** by default, testcontainers binds containers to `0.0.0.0`. On a CI runner with a public IP, this exposes the test database to the internet for the duration of the run. Always use `withExposedPorts(...)` with `withNetworkMode('bridge')` and verify the bound interface is loopback.
- **Test fixtures contain PII:** seed data must use clearly-fake values (`tenant-test-<uuid>`, `user-test-<uuid>`) and never copy production PII into test fixtures. Real names, real emails, real phone numbers in test fixtures = compliance violation (GDPR-relevant data leaving production boundary).
- **Credentials in test config:** the test database password is often `test` or `password`. CI logs may print connection strings. Strip passwords from connection strings before logging, even in tests.
- **Docker socket access:** testcontainers requires `/var/run/docker.sock` access, which is equivalent to root on the host. On CI, use a rootless Docker setup or a sidecar Docker-in-Docker container, never mount the host socket directly into untrusted code.
- **Image trust:** `postgres:15-alpine` and `redis:7-alpine` are official images, but pinning by tag alone allows silent supply-chain compromise if the registry is breached. Pin by digest (`postgres@sha256:...`) for production CI.
- **Tenant data leakage in shared containers:** if two tests run in parallel against the same Postgres container without proper schema isolation, tenant data from test A may bleed into queries from test B. Use schema-per-test or transaction rollback rigidly — not just "usually."

## Performance Concerns

- **Cold start dominates short suites:** for a file with 5 tests, Postgres cold start (~3s) is 60-80% of wall time. Reuse the container across files via worker-scoped fixtures to amortize.
- **Container reuse vs CI cleanliness:** local dev should use `withReuse()` for sub-second iteration; CI should NOT use reuse (each CI run is hermetic, otherwise stale state corrupts subsequent runs).
- **Index creation cost:** integration tests that recreate the schema on every test pay index-build cost repeatedly. Use `DROP TABLE` only when necessary; prefer `TRUNCATE` to keep indexes warm.
- **Redis FLUSHALL is O(n):** flushing a Redis with 100k keys takes ~1s. Per-test cleanup must use targeted `DEL` with prefix scans, not `FLUSHALL`.
- **Migration runtime:** running all migrations on a fresh test database is the largest single cost. For 50+ migrations, this can be 5-10 seconds per worker startup. Cache the migrated database state as a Postgres template (`CREATE DATABASE test_xyz TEMPLATE test_template`) and create from template per test.
- **Shared Docker image cache:** CI runners must persist the Docker layer cache between runs (e.g., GitHub Actions `actions/cache` for `/var/lib/docker`) to avoid pulling Postgres image fresh on every run. Cold pulls add 30-60 seconds.
- **Connection pool exhaustion:** if 10 parallel workers each open 5 connections to the same Postgres container with default `max_connections=100`, you have 50 connections — fine. Scale to 20 workers and you hit the cap. Tune both `pool.max` and Postgres `max_connections` together.

## Architectural Implications for test-runner reviews

When auditing integration tests, verify:

1. **Real Postgres via testcontainers, not pg-mem or in-memory mocks** for any test touching SQL beyond simple SELECT. Mocked DB on tenant/CQRS handler tests = HIGH (false coverage).
2. **Tenant search_path is set per-transaction with `SET LOCAL`**, not session-level. Session-level search_path in tests = HIGH (does not match production transaction-pooled behavior).
3. **Migrations run against the test database before any test executes.** Tests against `synchronize: true`-derived schema = CRITICAL (does not match production schema).
4. **`afterEach` cleanup is rigid** (transaction rollback OR explicit truncate). Missing cleanup = HIGH (state leakage between tests).
5. **Outbox tests truncate the outbox table in `afterEach`.** Persistent outbox rows = MEDIUM (test order dependence).
6. **Container reuse disabled on CI** (`TESTCONTAINERS_REUSE_ENABLE=false` or no reuse flag). Reuse in CI = HIGH (state bleeding across runs).
7. **Connection pool sized per worker** (`max: 5` per worker), not shared across workers. Shared global pool = HIGH (false race conditions).
8. **No real names/emails in seed fixtures.** PII in fixtures = CRITICAL (compliance violation).
9. **Test images pinned by digest** in CI configs. Tag-only pinning = LOW (supply-chain risk).
10. **Per-worker Redis logical DB number** for parallel test isolation. Shared logical DB across workers = HIGH (key collision).
11. **Mock-everything (London school) avoided for command handler tests** that touch tenant-scoped repositories. Pure mockist tests on CQRS handlers = HIGH (mocks the bug).
12. **Hermetic test runs** — tests do not depend on external services (Sentinel Hub, OpenWeather, NATS production cluster). External deps in test path = CRITICAL (flaky + data leak risk).

## Domain Rule Additions for test-runner

- Integration tests touching SQL MUST use real Postgres via testcontainers (`@testcontainers/postgresql`). pg-mem and ioredis-mock are forbidden for code paths beyond pure-function mappers.
- Integration tests MUST set `search_path` per-transaction with `SET LOCAL`. Session-level `SET search_path` in tests is a HIGH finding (masks pooler bugs).
- Test bootstrap MUST run the production migration runner against the test database. `synchronize: true` is forbidden in test setup.
- Each Jest worker MUST hold an independent DB connection pool sized to `max: 5` and an independent Redis logical DB.
- `afterEach` MUST guarantee state cleanup via transaction rollback OR `TRUNCATE ... RESTART IDENTITY CASCADE` of all touched tables. Cleanup that throws is forbidden (use `try/catch` to swallow errors after logging).
- Test fixtures MUST NOT contain real PII. Seed values use UUID-derived, clearly-synthetic strings.
- Outbox-pattern tests MUST truncate the outbox table in `afterEach`. Persistent outbox state across tests = MEDIUM finding.
- Container images MUST be pinned by SHA digest in CI; tag-only pinning is a LOW finding.
- Testcontainers reuse mode (`withReuse()`) is FORBIDDEN in CI (ephemeral runners); permitted only for local watch mode.
- Tests MUST NOT mock the database when the unit under test is a CQRS command handler that touches tenant-scoped repositories — these handlers must be tested with real Postgres. Mocked-DB CQRS handler tests = HIGH finding.
- Network access from test code to external production services (Sentinel Hub, weather APIs, NATS prod cluster) is FORBIDDEN. Such access in tests = CRITICAL.
