import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['.env.local', '.env'] });

/**
 * TypeORM CLI DataSource for the sensor-service.
 *
 * # Why this file exists
 *
 * Used by `npm run typeorm -- migration:*` operator tooling. The running
 * service uses TypeORM's built-in migration runner (DATABASE_SYNC env
 * var gating per app.module.ts) at OnApplicationBootstrap. This CLI
 * data-source is for operator-only paths — `migration:show`,
 * `migration:revert`, post-incident schema inspection.
 *
 * # Why schema: 'sensor'
 *
 * sensor-service owns the `sensor` schema and ships TimescaleDB
 * hypertables (sensor_metrics, continuous aggregates). The schema-per-
 * tenant pattern applies for sensor metadata; hypertables themselves
 * live in the source schema with tenant_id partitioning.
 *
 * Closes: docs/reviews/data-expert/2026-04-28-core-platform-review.md#DATA-MEDIUM-005
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'sensor_service',
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME ?? 'aquaculture',
  schema: 'sensor',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/*.ts'],
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
