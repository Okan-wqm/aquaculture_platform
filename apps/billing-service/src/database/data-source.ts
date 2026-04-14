import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['.env.local', '.env'] });

/**
 * TypeORM DataSource for the billing-service CLI.
 *
 * Used exclusively by `npm run typeorm -- migration:generate` /
 * `migration:create` / `migration:run` for operator tooling. The running
 * service does NOT read this DataSource — the app uses `TypeOrmModule.
 * forRootAsync` in `app.module.ts` and executes pending migrations
 * through `MigrationRunnerService` (from `@aquaculture/backend-common`)
 * at OnApplicationBootstrap.
 *
 * Keeping CLI and runtime configs co-located keeps the entity + migrations
 * paths in sync: both point at `src/billing/entities/*.entity.ts` and
 * `src/database/migrations/*.ts`. Divergence is a classic source of
 * "migration generated on staging, fails in production" incidents — we
 * avoid it by having one file define both paths.
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'billing_service',
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME ?? 'aquaculture',
  schema: process.env.DATABASE_SCHEMA ?? 'billing',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/*.ts'],
  // CLI runs migrations one-at-a-time by operator command; the runtime
  // service uses MigrationRunnerService which provides richer logging +
  // per-migration search_path pinning + hard-fail semantics.
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
