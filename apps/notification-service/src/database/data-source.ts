import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['.env.local', '.env'] });

/**
 * TypeORM DataSource for the notification-service CLI.
 *
 * Used by `npm run typeorm -- migration:*` operator tooling. The running
 * service uses MigrationRunnerService (wired in app.module.ts) which
 * executes migrations at OnApplicationBootstrap with search_path
 * pinning + per-migration transaction isolation.
 *
 * notification-service transitions from public → notification schema
 * during Phase 6/7 of the 2026-04-14 public-schema teardown:
 *   - P1 created the notification schema (00-init-schemas.sh).
 *   - P6 will move device_tokens there.
 *   - P7 will move notification_logs there.
 * Search_path is pinned to `notification` (falls through to public for
 * rows still in the old home), so this DataSource is forward-compatible.
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'notification_service',
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME ?? 'aquaculture',
  schema: 'notification',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/[0-9]*.ts'],
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
