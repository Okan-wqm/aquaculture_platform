import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['.env.local', '.env'] });

/**
 * TypeORM DataSource for the hydroponics-service CLI.
 *
 * Used by `npm run typeorm -- migration:*` operator tooling. The
 * running service uses SchemaVersionGate (wired in app.module.ts).
 *
 * hydroponics-service owns the `hydroponics` schema (tenant-scoped
 * per ADR-011). Per-tenant entities OMIT `schema:` (search_path tenant
 * routing handles placement); cross-tenant entities (outbox, audit)
 * DECLARE `schema:` explicitly.
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'hydroponics_service',
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME ?? 'aquaculture',
  schema: 'hydroponics',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/[0-9]*.ts'],
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
