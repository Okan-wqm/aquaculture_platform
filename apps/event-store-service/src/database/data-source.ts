import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['.env.local', '.env'] });

/**
 * TypeORM CLI DataSource for the event-store-service.
 *
 * # Why this file exists
 *
 * Used by `npm run typeorm -- migration:*` operator tooling. The running
 * service uses TypeORM's built-in migration runner (DATABASE_MIGRATIONS_RUN
 * env var; see app.module.ts) at OnApplicationBootstrap. This CLI
 * data-source is for operator-only paths — `migration:show`,
 * `migration:revert`, post-incident schema inspection.
 *
 * # Why schema: 'event_store'
 *
 * event-store-service owns the `event_store` schema (stored_events
 * append-only ledger + projections). Cross-tenant by design (the
 * tenant-id column on stored_events maps each event to its tenant).
 *
 * Closes: docs/reviews/data-expert/2026-04-28-core-platform-review.md#DATA-MEDIUM-005
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'event_store_service',
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME ?? 'aquaculture',
  schema: 'event_store',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/migrations/*.ts'],
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
