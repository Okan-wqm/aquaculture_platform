/**
 * Jest globalSetup for the messaging E2E suite (ORPHAN-HIGH-092 fix).
 *
 * The suite cancelled on ~50% of CI runs: the first spec's `beforeAll`
 * (DataSource.initialize waiting on a cold TimescaleDB-HA + `CREATE EXTENSION
 * vector` + partition bootstrap + full migration run) overran the 60s per-hook
 * `testTimeout` under cold-container load → "Exceeded timeout of 60000 ms for a
 * hook" → the job hit its wall-clock → silent `##[error]The operation was
 * canceled`. `pg_isready` (the workflow service healthcheck) returns ready
 * before the engine can service heavy DDL, so the boot wait landed inside the
 * hook budget.
 *
 * globalSetup runs ONCE before any test and is NOT bound by `testTimeout`, so it
 * absorbs the cold-start cost OUTSIDE the per-hook budget:
 *   - Tier-2 readiness gate: poll until Postgres actually services a query.
 *   - Tier-3 detectability + pre-warm: create the heavy extensions (esp.
 *     pgvector) here, loudly, failing explicitly rather than silently cancelling.
 *
 * IMPORTANT — this module is intentionally self-contained (only `pg`). Jest
 * loads globalSetup OUTSIDE jest-runtime, so its transitive `require`s bypass
 * `moduleNameMapper`/tsconfig-paths. Importing `e2e-setup` here drags in the
 * whole AppModule graph (→ `@aquaculture/backend-common/database`), which then
 * fails to resolve. The migration run therefore stays in `createE2eTestApp`'s
 * `beforeAll` — but now runs against an already-warm DB with extensions
 * pre-created, so it completes well within the 60s budget.
 */
import { Client } from 'pg';

const READINESS_BUDGET_MS = 120_000;
const READINESS_INTERVAL_MS = 2_000;

interface PgConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

function log(message: string): void {
  // globalSetup runs before the Nest app exists, so the structured Logger is
  // unavailable; stdout is the only channel (and the no-console lint rule does
  // not apply to process.stdout.write). Loud on purpose — Tier-3 detectability.
  process.stdout.write(`[e2e globalSetup] ${message}\n`);
}

function pgConfig(): PgConfig {
  return {
    host: process.env['DATABASE_HOST'] ?? 'localhost',
    port: Number(process.env['DATABASE_PORT'] ?? '5432'),
    user: process.env['DATABASE_USER'] ?? 'postgres',
    password: process.env['DATABASE_PASSWORD'] ?? 'postgres',
    database: process.env['DATABASE_NAME'] ?? 'aquaculture_e2e',
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until Postgres services a trivial query, or fail loudly after the budget. */
async function waitForPostgresReady(): Promise<void> {
  const deadline = Date.now() + READINESS_BUDGET_MS;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const client = new Client(pgConfig());
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      log(`Postgres ready after ${attempts} attempt(s).`);
      return;
    } catch (error) {
      try {
        await client.end();
      } catch {
        // connection never opened — nothing to close
      }
      if (Date.now() >= deadline) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `E2E Postgres not ready after ${READINESS_BUDGET_MS}ms / ` +
            `${attempts} attempts: ${reason}`,
        );
      }
      await sleep(READINESS_INTERVAL_MS);
    }
  }
}

/**
 * Pre-create the extensions the messaging migrations need. pgvector's first
 * `CREATE EXTENSION vector` is the slowest single DDL in the bootstrap; paying
 * it here (outside the hook budget) keeps the per-spec `beforeAll` migration
 * run fast. All `IF NOT EXISTS`, so the beforeAll re-issue is a no-op.
 */
async function prewarmExtensions(): Promise<void> {
  const client = new Client(pgConfig());
  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await client.query('CREATE EXTENSION IF NOT EXISTS "vector"');
    log('extensions pre-created (uuid-ossp, pgcrypto, vector).');
  } finally {
    await client.end();
  }
}

export default async function globalSetup(): Promise<void> {
  log('waiting for Postgres readiness…');
  await waitForPostgresReady();
  log('pre-warming extensions outside the per-hook budget…');
  await prewarmExtensions();
  log('DB warm; suite is ready.');
}
