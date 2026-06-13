/**
 * Jest globalSetup for the messaging E2E suite (ORPHAN-HIGH-092 fix).
 *
 * The suite was cancelling on ~50% of CI runs: the heavy one-time bootstrap
 * (DataSource.initialize waiting on a cold TimescaleDB-HA + `CREATE EXTENSION
 * vector` + partition bootstrap + full migration run) ran inside the FIRST
 * spec's `beforeAll`, under the 60s per-hook `testTimeout`. Under cold-container
 * CI load it exceeded 60s → "Exceeded timeout of 60000 ms for a hook" → the job
 * hit its wall-clock → silent `##[error]The operation was canceled`.
 *
 * globalSetup runs ONCE before any test and is NOT bound by `testTimeout` (only
 * by the job's `timeout-minutes`), so:
 *   - Tier-2 (automatic readiness gate): poll Postgres until it actually accepts
 *     queries — TimescaleDB-HA's `pg_isready` healthcheck returns ready before
 *     the engine can service heavy DDL, so the workflow service gate is not
 *     sufficient on its own.
 *   - Tier-3 (split boot out of the hook budget + detectable): run the migration
 *     bootstrap here, loudly, with an explicit failure instead of a silent
 *     cancel. The per-spec `createE2eTestApp` call to the same memoised function
 *     is then a fast, idempotent no-op.
 */
import { Client } from 'pg';

import { ensureMessagingSourceMigrationsApplied } from './e2e-setup';

const READINESS_BUDGET_MS = 120_000;
const READINESS_INTERVAL_MS = 2_000;

function log(message: string): void {
  // globalSetup runs before the Nest app exists, so the structured Logger is
  // unavailable; stdout is the only channel (and the no-console lint rule does
  // not apply to process.stdout.write). Loud on purpose — Tier-3 detectability.
  process.stdout.write(`[e2e globalSetup] ${message}\n`);
}

function pgConfig(): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
} {
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
  let lastError: unknown;

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
      lastError = error;
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

export default async function globalSetup(): Promise<void> {
  log('waiting for Postgres readiness…');
  await waitForPostgresReady();
  log('applying messaging source migrations (once, outside the per-hook budget)…');
  await ensureMessagingSourceMigrationsApplied();
  log('messaging source migrations applied; suite is ready.');
}
