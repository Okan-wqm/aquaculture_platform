import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['.env.local', '.env'] });

/**
 * TypeORM CLI DataSource for the farm-service.
 *
 * # Why this file exists
 *
 * Used by `npm run typeorm -- migration:*` operator tooling. The running
 * service uses MigrationRunnerService (wired in app.module.ts) which
 * executes migrations at OnApplicationBootstrap with search_path pinning.
 * This CLI data-source is for operator-only paths — `migration:show`,
 * `migration:revert`, post-incident schema inspection.
 *
 * # Why schema: 'farm'
 *
 * farm-service owns the `farm` schema and follows the schema-per-tenant
 * pattern: source tables live in `farm`; per-tenant migrations fan out
 * to `tenant_<uuid>` schemas via the migration ledger (post-W0.G the
 * boot-time DDL path was removed — every per-tenant DDL change ships
 * via a migration with explicit fan-out).
 *
 * Closes: docs/reviews/data-expert/2026-04-28-core-platform-review.md#DATA-MEDIUM-005
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'farm_service',
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME ?? 'aquaculture',
  schema: 'farm',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/[0-9]*.ts'],
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
