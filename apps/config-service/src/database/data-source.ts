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
 * config-service currently shares the `public` schema with billing /
 * notification / alert / ai / event-store. Planned P6-P10 of the
 * 2026-04-14 public-schema teardown migrate the Configuration entity
 * (and any future config-service tables) into a dedicated `config`
 * schema so this DataSource should eventually update its `schema`
 * option accordingly. Until then, migrations target public.
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'gateway_service',
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME ?? 'aquaculture',
  schema: 'public',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/*.ts'],
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
