import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['.env.local', '.env'] });

/**
 * TypeORM DataSource for the alert-engine CLI.
 *
 * Used by `npm run typeorm -- migration:*` operator tooling. The running
 * service uses AlertMigrationRunnerService (wired in app.module.ts) which
 * executes migrations at OnApplicationBootstrap with search_path pinning
 * and per-migration transaction isolation.
 *
 * alert-engine follows the schema-per-tenant pattern: source tables live
 * in the `alert` schema; `CREATE TABLE LIKE INCLUDING ALL` provisions a
 * copy into each `tenant_<uuid>` schema at tenant onboarding. Migrations
 * target the source schema — TenantSchemaSyncService replicates the
 * resulting structure outward to all existing tenant schemas.
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'alert_service',
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME ?? 'aquaculture',
  schema: 'alert',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/[0-9]*.ts'],
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
