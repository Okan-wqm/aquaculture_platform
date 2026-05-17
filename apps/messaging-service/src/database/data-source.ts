import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['.env.local', '.env'] });

/**
 * TypeORM DataSource for the messaging-service CLI.
 *
 * Used by `npm run typeorm -- migration:*` operator tooling. The running
 * service uses MessagingMigrationRunnerService (wired in app.module.ts)
 * which executes migrations at OnApplicationBootstrap with search_path
 * pinning and per-migration transaction isolation.
 *
 * messaging-service is a schema-per-tenant service: source tables live
 * in the `messaging` schema; `CREATE TABLE LIKE INCLUDING ALL` provisions
 * a copy into each `tenant_<uuid>` schema at tenant onboarding. Migrations
 * target the source schema — TenantSchemaSyncService replicates the
 * resulting structure outward to all existing tenant schemas.
 *
 * Migration files currently live at `src/migrations/` (not
 * `src/database/migrations/`) due to historical layout. Both paths are
 * accepted by the glob below so future additions under either location
 * are discoverable by the CLI. The runtime service reads migrations via
 * explicit class-ref imports in app.module.ts (webpack bundles them into
 * main.js), so this CLI glob is CLI-only and does not affect runtime.
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'messaging_service',
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME ?? 'aquaculture',
  schema: 'messaging',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/migrations/[0-9]*.ts', 'src/database/migrations/[0-9]*.ts'],
  migrationsTableName: 'migrations',
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
