import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['.env.local', '.env'] });

/**
 * TypeORM CLI DataSource for the admin-api service.
 *
 * # Why this file exists
 *
 * Used by `npm run typeorm -- migration:*` operator tooling. The running
 * service uses TypeORM's built-in migration runner (admin-api opts in via
 * DATABASE_MIGRATIONS_RUN env var; see app.module.ts) which executes
 * migrations at OnApplicationBootstrap. This CLI data-source is for
 * operator-only paths — `migration:show`, `migration:revert`,
 * post-incident schema inspection.
 *
 * # Why migrationsRun: false
 *
 * Operator runs MUST be explicit; the CLI must never silently apply
 * pending migrations on a `migration:show` invocation. Application boot
 * is the only path that runs migrations.
 *
 * Closes: docs/reviews/data-expert/2026-04-28-core-platform-review.md#DATA-MEDIUM-005
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'admin_api_service',
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME ?? 'aquaculture',
  schema: 'admin',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/migrations/*.ts'],
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
