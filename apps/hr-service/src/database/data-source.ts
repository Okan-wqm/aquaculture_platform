import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['.env.local', '.env'] });

/**
 * TypeORM DataSource for the hr-service CLI.
 *
 * Used by `npm run typeorm -- migration:*` operator tooling. The running
 * service uses HrMigrationRunnerService (wired in app.module.ts).
 *
 * hr-service is schema-per-tenant — source tables in the hr schema are
 * replicated to each tenant_<uuid> schema at onboarding via
 * TenantSchemaSyncService. Migrations target the source.
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'hr_service',
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME ?? 'aquaculture',
  schema: 'hr',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/[0-9]*.ts'],
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
