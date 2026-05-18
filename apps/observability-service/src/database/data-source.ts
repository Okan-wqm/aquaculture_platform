import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['.env.local', '.env'] });

/**
 * TypeORM DataSource for the observability-service CLI.
 *
 * Used by `npm run typeorm -- migration:*` operator tooling. The
 * running service uses MigrationRunnerService/SchemaVersionGate (wired
 * in app.module.ts) which executes migrations at OnApplicationBootstrap.
 *
 * observability-service owns the `observability` schema (per ADR-011).
 * tenant_cost_rollup is a TimescaleDB hypertable — its create_hypertable()
 * call must be appended by hand to any baseline migration (TypeORM does
 * not emit hypertable DDL).
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'observability_service',
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME ?? 'aquaculture',
  schema: 'observability',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/[0-9]*.ts'],
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
