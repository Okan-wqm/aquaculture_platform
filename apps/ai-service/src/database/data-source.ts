import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['.env.local', '.env'] });

/**
 * TypeORM DataSource for the ai-service CLI.
 *
 * Used by `npm run typeorm -- migration:*` operator tooling. The running
 * service uses AiMigrationRunnerService (wired in app.module.ts).
 *
 * ai-service follows the schema-per-tenant pattern: source tables live
 * in the `ai` schema; CREATE TABLE LIKE INCLUDING ALL provisions a copy
 * into each tenant_<uuid> schema at tenant onboarding.
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'ai_service',
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME ?? 'aquaculture',
  schema: 'ai',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/*.ts'],
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
