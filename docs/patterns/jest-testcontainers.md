# Jest Testcontainers — Shared Container per Suite File, Schema per Test

**Status**: Canonical pattern (Plan v3 R9 CRITICAL — Phase 1 harness prereq)
**Applies to**: `libs/migration-harness/` (Phase 1), any future lib that uses `testcontainers` for Postgres-backed tests

## TL;DR

- One PG testcontainer per Jest suite file (NOT per test, NOT per Jest run)
- Per-test isolation via `CREATE SCHEMA test_<uuid>` + `DROP SCHEMA CASCADE`
- `globalSetup` pulls + verifies the image only; does NOT start a container
- `beforeAll` starts the container; `afterAll` tears it down
- Container lifetime ~30-60s spans all tests in the file — 20+ tests per file for amortization
- Budget: single migration test <30s end-to-end

## The Problem — per-test container blows the SLO

Testcontainers' `new PostgreSqlContainer().start()` typically takes 15-30s on a cold image cache. For `timescale/timescaledb-ha:pg16` (what aqua uses) it's ~15s warm, ~45s cold.

If each `test(...)` or `describe(...)` starts its own container:
- 10 tests in a file × 15s warm startup = 150s JUST for container boot
- 20 tests × 15s = 300s → CI worker timeout / developer patience gone
- Plan v3's "single migration test <30s" SLO only achievable with shared-container

## The Pattern

### File-level: suite-wide container via beforeAll

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { randomBytes } from 'node:crypto';

let container: StartedPostgreSqlContainer;
let dataSource: DataSource;

beforeAll(async () => {
  // Runs ONCE per Jest spec file. Expensive — amortise across all tests.
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('harness')
    .withUsername('harness')
    .withPassword('harness')
    .withCommand(['postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off']) // test-only speedups
    .start();

  dataSource = new DataSource({
    type: 'postgres',
    host: container.getHost(),
    port: container.getPort(),
    username: container.getUsername(),
    password: container.getPassword(),
    database: container.getDatabase(),
    entities: [], // each test registers what it needs
    synchronize: false,
  });
  await dataSource.initialize();
}, 60_000); // explicit long timeout for cold image pull

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
  if (container) await container.stop();
}, 30_000);
```

### Per-test: ephemeral schema

```ts
function ephemeralSchemaName(): string {
  return `test_${randomBytes(8).toString('hex')}`; // test_abcdef1234567890
}

async function withEphemeralSchema<T>(
  fn: (schema: string, qr: QueryRunner) => Promise<T>,
): Promise<T> {
  const schema = ephemeralSchemaName();
  const qr = dataSource.createQueryRunner();
  try {
    await qr.query(`CREATE SCHEMA "${schema}"`);
    await qr.query(`SET LOCAL search_path TO "${schema}"`);
    return await fn(schema, qr);
  } finally {
    // ALWAYS drop — even on test failure; otherwise container fills up with orphaned schemas
    await qr.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await qr.release();
  }
}

it('my test', async () => {
  await withEphemeralSchema(async (schema, qr) => {
    await qr.query(`CREATE TABLE "${schema}".thing (id uuid PRIMARY KEY)`);
    // ... migration + assertions
  });
});
```

### Why NOT globalSetup for the container

Jest `globalSetup` / `globalTeardown` run ONCE per Jest invocation. On the surface that seems ideal: one container for the entire test run, maximum amortization.

In practice:
- Test files run in parallel workers by default. Jest's `globalSetup` output isn't easily accessible in worker processes without explicit IPC.
- When workers try to share a single container, connection pool contention + transaction ordering becomes non-deterministic. Test flake.
- Container lifetime spanning the entire run means `container.stop()` waits until all tests complete; a hang in one file leaks the container until Jest's kill signal.

Per-file shared container + per-worker containers in parallel is simpler and faster in practice.

### globalSetup responsibility: image pre-pull ONLY

```ts
// jest.global-setup.ts
import { GenericContainer } from 'testcontainers';

module.exports = async () => {
  // Pull the image once to warm every worker's Docker cache.
  // Actual container startup happens per-spec-file in beforeAll.
  const g = new GenericContainer('timescale/timescaledb-ha:pg16');
  await g.start().then((c) => c.stop()); // pull-only pattern
};
```

Optional. Saves cold-pull time on the FIRST beforeAll per worker but adds Jest run overhead. Enable when cold-cache CI runs show >5% overhead on pull alone.

## Budget Math

Typical spec file with the pattern:
- Container boot: 15s (warm image cache, aqua's CI pre-pull via GHA cache keyed on image digest)
- 15 tests × 1-2s each (CREATE SCHEMA + fixture + migration + DROP SCHEMA): ~25s
- Total: ~40s per spec file

With 10 migration spec files running in parallel (default 2-4 workers):
- Serial: 400s
- 4 workers parallel: ~100s

This fits the ~2-min affected-target budget on typical PRs that touch 2-3 services.

## Pitfalls

### Schema name collision across parallel tests in the same file

`randomBytes(8)` gives 16-char hex → 2^64 space; collision probability negligible for test-scale run counts. If you see flaky tests with "schema already exists", check that `afterEach`/`finally` always drops.

### ACCESS EXCLUSIVE locks on shared catalogs

Even with per-test schemas, `ALTER TYPE ADD VALUE`, `CREATE TYPE`, `CREATE EXTENSION` take locks on `pg_type` / `pg_extension` — shared catalogs. Two tests in parallel within the same container doing enum ops WILL serialise, not parallelise.

For the migration harness this is usually fine (migrations are themselves serialising operations). For tests that just CRUD against isolated schemas, no issue.

### Image pinning for supply-chain

Per plan v3 R30, pin the exact image SHA (not caret range):

```ts
new PostgreSqlContainer('timescale/timescaledb-ha:pg16@sha256:b3d038d0a0757df8a5ec0a94ba68d9ad57b0e16100a024cf4b370c77ad5645f7')
```

The SHA matches `infrastructure/docker/postgres.Dockerfile` / `docker-compose.droplet.yml` — tests run against the same PG the droplet does. Image drift between test + prod = silent false positives.

## Example: the HR-drift regression harness spec

The plan's Phase 1 proof-of-concept is `libs/migration-harness/src/__tests__/hr-drift-regression.spec.ts`. It:

1. Boots ONE container in `beforeAll` (~15s)
2. For each of 4 tests (partial-index drift, EXCLUDE constraint drift, CHECK constraint drift, nullability drift):
   - CREATE SCHEMA `test_<uuid>`
   - Seed HR entity shape WITHOUT the drift fix applied
   - Inject the specific drift class
   - Run `bringToEntityShape(qr, {schema, entities: HR_ENTITIES})`
   - Assert `DriftReport.total === 0` via `expectNoDriftAgainst`
   - DROP SCHEMA CASCADE
3. afterAll tears container down

Total wall-clock: ~25s for 4 tests + ~15s container = <45s — well under PR-gate budget.

This is the reproducible-in-<60s-locally guarantee that ends the 5-commit HR-drift loop: any future drift class gets a seed + assert in this spec file and is caught at PR time, not at droplet deploy time.

## References

- testcontainers-node docs: https://node.testcontainers.org/
- Plan v3 §Phase 1 — kickoff checklist R9
- Plan v3 §R22 — Nx generator command for `libs/migration-harness`
- Plan v3 §R30 — supply-chain hardening (image SHA pin, npm audit)
