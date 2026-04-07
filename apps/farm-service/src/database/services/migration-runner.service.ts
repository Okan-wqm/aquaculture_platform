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

    // ── Pre-step: assert search_path before TypeORM opens migration txns ──
    // Phase 11.1 (commit d257fd69) makes TenantConnectionBootstrap re-assert
    // `SET search_path TO "farm", public` on every non-request pool
    // checkout, so by the time `runMigrations()` grabs its QueryRunner the
    // connection should already be on the right schema. This extra pre-step
    // is belt-and-suspenders: it acquires ONE more fresh QueryRunner, sets
    // search_path explicitly, logs the observed `current_schema()` so any
    // future regression is visible in the deploy log, and releases the
    // runner before TypeORM takes over. On a correctly-patched pool this
    // reasserts an already-correct value; on a misconfigured pool it
    // surfaces the drift loudly.
    const preRunner = this.dataSource.createQueryRunner();
    try {
      await preRunner.connect();
      await preRunner.query(`SET search_path TO "farm", public`);
      const schemaRow: Array<{ schema: string }> = await preRunner.query(
        `SELECT current_schema() AS schema`,
      );
      const observedSchema = schemaRow[0]?.schema ?? '<unknown>';
      this.logger.log(
        `MigrationRunner pre-step — search_path pinned to "farm", public; observed current_schema() = "${observedSchema}".`,
      );
      if (observedSchema !== 'farm') {
        this.logger.warn(
          `Expected current_schema() to be "farm" after SET search_path, got "${observedSchema}". ` +
            `This indicates the farm schema does not exist yet — SourceSchemaBootstrap should have created it before this runner ran. ` +
            `Proceeding anyway; the migrations themselves each SET search_path defensively.`,
        );
      }
    } finally {
      await preRunner.release();
    }

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
