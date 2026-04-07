import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

/**
 * MigrationRunnerService
 *
 * Runs pending TypeORM migrations on the source schema (farm) AFTER
 * SourceSchemaBootstrapService has finished its `synchronize()` pass.
 *
 * WHY OnApplicationBootstrap (and not OnModuleInit):
 *   `OnApplicationBootstrap` fires after every module's `OnModuleInit`.
 *   `SourceSchemaBootstrapService` runs in `OnModuleInit` and may
 *   create the base tables via `synchronize()`. Running migrations
 *   before that on a fresh DB would fail (`relation does not exist`).
 *   Sequencing via lifecycle phases gives a deterministic ordering
 *   without coupling this service to backend-common internals.
 *
 * SECURITY: In production, `DATABASE_MIGRATIONS_RUN=false` is forbidden.
 * Schema migrations are mandatory for at-least-once schema delivery.
 *
 * @see Phase 0 of farm domain real-time visibility plan
 */
@Injectable()
export class MigrationRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MigrationRunnerService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const enabled =
      this.configService.get('DATABASE_MIGRATIONS_RUN', 'true') === 'true';
    const isProduction =
      this.configService.get('NODE_ENV') === 'production';

    if (!enabled && isProduction) {
      // SECURITY: hard-fail boundary — production MUST run migrations.
      throw new Error(
        'SECURITY: DATABASE_MIGRATIONS_RUN must not be false in production. ' +
          'Schema migrations are mandatory for safe rollouts.',
      );
    }

    if (!enabled) {
      this.logger.warn(
        'Skipping migrations because DATABASE_MIGRATIONS_RUN=false (non-production only)',
      );
      return;
    }

    this.logger.log('Running pending migrations on source schema...');

    try {
      const applied = await this.dataSource.runMigrations({
        transaction: 'each',
      });

      if (applied.length > 0) {
        this.logger.log(
          `Applied ${applied.length} migration(s): ${applied
            .map((m) => m.name)
            .join(', ')}`,
        );
      } else {
        this.logger.log('No pending migrations');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Migration runner failed on source schema: ${message}`,
        stack,
      );
      // Re-throw — failed migrations indicate a deployment problem and the
      // service must not start with an inconsistent schema.
      throw error;
    }
  }
}
