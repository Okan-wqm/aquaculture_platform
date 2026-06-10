import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * AuthSchemaBootstrapService — ensures auth schema columns exist before any queries run.
 *
 * WHY: Auth-service uses synchronize=false in production. New columns added to entities
 * require explicit schema evolution. TypeORM migrations (migrationsRun) execute during
 * DataSource.initialize(), but webpack-bundled builds may not include migration files
 * in the dist/ output. This service provides a fallback mechanism that runs idempotent
 * ALTER TABLE statements at application startup, guaranteeing schema compatibility
 * regardless of the build system.
 *
 * PATTERN: Same approach as SourceSchemaBootstrapService in other services —
 * idempotent DDL statements that are safe to run on every startup and across replicas.
 */
@Injectable()
export class AuthSchemaBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(AuthSchemaBootstrapService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureSchemaColumns();
    } catch (error) {
      // Non-fatal: log and continue — service should start even if bootstrap fails
      this.logger.error('Schema bootstrap failed — some features may be unavailable', error);
    }
  }

  /**
   * Ensures all required columns exist in the auth schema.
   * Each statement uses IF NOT EXISTS pattern for idempotent execution.
   */
  private async ensureSchemaColumns(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      // AccessType column — controls platform access (panel/mobile/both)
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'auth'
              AND table_name = 'users'
              AND column_name = 'accessType'
          ) THEN
            ALTER TABLE auth.users ADD COLUMN "accessType" varchar(20) DEFAULT 'BOTH';
            RAISE NOTICE 'Added accessType column to auth.users';
          END IF;
        END $$;
      `);

      // WHY: Existing mobile_user_settings rows have JSONB without the new feature keys
      // (transfer, schedule, attendance, leave, tasks). This backfill merges defaults
      // into existing rows so current users get the new features immediately.
      // Uses jsonb_build_object + || merge — idempotent, won't overwrite explicit settings.
      await queryRunner.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'auth' AND table_name = 'mobile_user_settings'
          ) THEN
            UPDATE auth.mobile_user_settings
            SET allowed_features = allowed_features || jsonb_build_object(
              'transfer', true,
              'schedule', true,
              'attendance', true,
              'leave', true,
              'tasks', true,
              'feeding', true
            )
            WHERE NOT (allowed_features ? 'transfer');
          END IF;
        END $$;
      `);

      this.logger.log('Auth schema bootstrap completed successfully');
    } finally {
      await queryRunner.release();
    }
  }
}
