import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['.env.local', '.env'] });

/**
 * TypeORM CLI DataSource for the auth-service.
 *
 * # Why this file exists
 *
 * Used by `npm run typeorm -- migration:*` operator tooling. The running
 * service uses MigrationRunnerService (wired in app.module.ts) which
 * executes migrations at OnApplicationBootstrap. This CLI data-source is
 * for operator-only paths — `migration:show`, `migration:revert`,
 * post-incident schema inspection.
 *
 * # Why schema: 'auth'
 *
 * auth-service owns the `auth` schema (auth.users, auth.tenants,
 * auth.refresh_tokens, auth.audit_logs, ...). Cross-tenant by design —
 * every login resolves a tenant before any other context.
 *
 * Closes: docs/reviews/data-expert/2026-04-28-core-platform-review.md#DATA-MEDIUM-005
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'auth_service',
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME ?? 'aquaculture',
  schema: 'auth',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/migrations/*.ts'],
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
