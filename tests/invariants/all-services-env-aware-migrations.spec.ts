/**
 * Platform-wide invariant — INFRA-CRITICAL-020 propagation:
 *
 * Every service that runs `MigrationRunnerService` AND owns a source
 * schema MUST also pass `migrationsRunFromEnv: cs => DATABASE_MIGRATIONS_RUN==='true'`
 * to its `createServiceTypeOrmConfig` call so that E2E test harnesses
 * (which set DATABASE_MIGRATIONS_RUN=true) get TypeORM's built-in
 * runner to apply migrations at DataSource init — BEFORE the
 * `SourceSchemaBootstrapService` onApplicationBootstrap hook fires.
 *
 * # Why
 *
 * `SourceSchemaBootstrapService` (libs/backend-common) hard-fails (per
 * INFRA-CRITICAL-009) when the source schema is empty after bootstrap.
 * In production, `aqua-db-migrate` runs migrations BEFORE service
 * containers start, so the schema is populated by the time the service
 * boots. In E2E tests there is no such pre-stage — TypeORM must apply
 * migrations at DataSource init or the bootstrap hook crashes.
 *
 * The pattern landed in messaging-service first (commit 074c7807,
 * INFRA-CRITICAL-020) and was propagated to every other service in a
 * subsequent sweep. This invariant guards against regression — a future
 * service that ships without the migrationsRunFromEnv contract will
 * fail E2E on the first cold-start of the harness.
 *
 * The invariant scans for the literal `migrationsRunFromEnv` token and
 * fails closed when any app module drops that declaration.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const SERVICES_REQUIRING_ENV_AWARE_MIGRATIONS: readonly string[] = [
  'farm-service',
  'sensor-service',
  'hr-service',
  'messaging-service',
  'alert-engine',
  'billing-service',
  'notification-service',
  'config-service',
  'hydroponics-service',
  'ai-service',
  'admin-api-service',
  'event-store-service',
  'auth-service',
  'observability-service',
];

describe('INVARIANT (INFRA-CRITICAL-020 propagation): every service declares migration timing', () => {
  for (const service of SERVICES_REQUIRING_ENV_AWARE_MIGRATIONS) {
    it(`${service} satisfies the migrationsRunFromEnv contract`, () => {
      const path = resolve(REPO_ROOT, 'apps', service, 'src/app.module.ts');
      const src = readFileSync(path, 'utf8');

      if (!/migrationsRunFromEnv\s*:/.test(src)) {
        throw new Error(
          `${service}/src/app.module.ts: missing migrationsRunFromEnv declaration. ` +
            `Add the env-aware migration timing block (see messaging-service for the canonical shape) ` +
            `so E2E tests can run TypeORM's built-in migration runner before SourceSchemaBootstrapService fires.`,
        );
      }
    });
  }
});
