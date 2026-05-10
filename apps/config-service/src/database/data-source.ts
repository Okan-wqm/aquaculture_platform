import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['.env.local', '.env'] });

/**
 * TypeORM DataSource for the config-service CLI.
 *
 * Used by `npm run typeorm -- migration:*` operator tooling. The running
 * service uses MigrationRunnerService (wired in app.module.ts) which
 * executes migrations at OnApplicationBootstrap with search_path
 * pinning + per-migration transaction isolation.
 *
 * config-service owns the `config` schema (per ADR-011 schema-per-service).
 * Every entity declares `@Entity('<table>', { schema: 'config' })` and
 * every migration body is schema-qualified to `config.<table>`. This CLI
 * DataSource targets `schema: 'config'` so `migration:show` /
 * `migration:revert` and the runtime runner (app.module.ts) read the
 * same `config.typeorm_migrations` ledger.
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-CRITICAL-069
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'config_service',
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME ?? 'aquaculture',
  schema: 'config',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/*.ts'],
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
