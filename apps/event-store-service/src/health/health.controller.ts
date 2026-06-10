import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  StandardHealthController,
  type ReadinessResponse,
} from '@aquaculture/backend-common/health';
import { DataSource } from 'typeorm';
import { Response } from 'express';

/**
 * Event Store Service Health Controller
 * Extends the standard health controller with consistent K8s probe format.
 */
@Controller('health')
export class HealthController extends StandardHealthController {
  constructor(
    @InjectDataSource()
    dataSource: DataSource,
  ) {
    super(dataSource);
    this.serviceName = 'event-store-service';
  }

  @Get('ready')
  override async readiness(@Res() res: Response): Promise<void> {
    const checks: Record<string, 'ok' | 'error'> = {
      database: await this.checkDatabase(),
      ...(await this.eventStoreReadinessChecks()),
    };
    const hasError = Object.values(checks).some((value) => value === 'error');
    const body: ReadinessResponse = {
      status: hasError ? 'not_ready' : 'ok',
      checks: checks as ReadinessResponse['checks'],
    };

    res
      .status(hasError ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK)
      .json(body);
  }

  private async eventStoreReadinessChecks(): Promise<Record<string, 'ok' | 'error'>> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      await queryRunner.query(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const [schemaObjects] = await queryRunner.query(`
        SELECT
          to_regclass('event_store.stored_events') IS NOT NULL AS stored_events,
          to_regclass('event_store.append_idempotency') IS NOT NULL AS append_idempotency,
          to_regclass('event_store.ledger_cursors') IS NOT NULL AS ledger_cursors,
          to_regclass('event_store.projection_checkpoints') IS NOT NULL AS projection_checkpoints
      `);
      const [schemaIntegrity] = await queryRunner.query(`
        WITH trigger_state AS (
          SELECT count(*)::int AS installed
          FROM pg_trigger
          WHERE tgrelid = 'event_store.stored_events'::regclass
            AND tgname IN (
              'TRG_stored_events_append_only_update',
              'TRG_stored_events_append_only_delete',
              'TRG_stored_events_append_only_truncate'
            )
            AND NOT tgisinternal
        ),
        rls_state AS (
          SELECT count(*)::int AS forced
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'event_store'
            AND c.relname IN (
              'stored_events',
              'event_streams',
              'snapshots',
              'projection_checkpoints',
              'projection_inbox',
              'append_idempotency'
            )
            AND c.relrowsecurity
            AND c.relforcerowsecurity
        ),
        cursor_state AS (
          SELECT CASE
            WHEN (SELECT "nextPosition" FROM "event_store"."ledger_cursors" WHERE "name" = 'global')
              >= COALESCE((SELECT max("globalPosition") FROM "event_store"."stored_events"), 0)
            THEN 1 ELSE 0
          END AS valid
        )
        SELECT
          (SELECT installed FROM trigger_state) = 3 AS append_only_triggers,
          (SELECT forced FROM rls_state) = 6 AS forced_rls,
          (SELECT valid FROM cursor_state) = 1 AS cursor_valid
      `);
      const [projectionState] = await queryRunner.query(`
        SELECT
          count(*) FILTER (WHERE status = 'faulted')::int AS faulted,
          count(*) FILTER (
            WHERE status = 'running'
              AND "leaseOwner" IS NOT NULL
              AND (
                "heartbeatAt" IS NULL
                OR "heartbeatAt" < now() - interval '5 minutes'
                OR "leaseExpiresAt" < now()
              )
          )::int AS stale
        FROM "event_store"."projection_checkpoints"
      `);
      const [lagState] = await queryRunner.query(`
        WITH tenant_max_event AS (
          SELECT "tenantId", COALESCE(max("globalPosition"), 0)::bigint AS max_position
          FROM "event_store"."stored_events"
          GROUP BY "tenantId"
        )
        SELECT count(*)::int AS lagged
        FROM "event_store"."projection_checkpoints" checkpoint
        JOIN tenant_max_event max_event ON max_event."tenantId" = checkpoint."tenantId"
        WHERE checkpoint.status = 'running'
          AND (max_event.max_position - checkpoint."position") > $1
      `, [Number(process.env['EVENT_STORE_PROJECTION_READY_LAG_LIMIT'] ?? 10_000)]);

      await queryRunner.commitTransaction();

      return {
        schema: Object.values(schemaObjects ?? {}).every(Boolean) ? 'ok' : 'error',
        appendOnly: schemaIntegrity?.append_only_triggers ? 'ok' : 'error',
        rls: schemaIntegrity?.forced_rls ? 'ok' : 'error',
        ledgerCursor: schemaIntegrity?.cursor_valid ? 'ok' : 'error',
        projectionFaults: Number(projectionState?.faulted ?? 0) === 0 ? 'ok' : 'error',
        projectionHeartbeat: Number(projectionState?.stale ?? 0) === 0 ? 'ok' : 'error',
        projectionLag: Number(lagState?.lagged ?? 0) === 0 ? 'ok' : 'error',
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.warn(
        `Event-store readiness check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        schema: 'error',
        appendOnly: 'error',
        rls: 'error',
        ledgerCursor: 'error',
        projectionFaults: 'error',
        projectionHeartbeat: 'error',
        projectionLag: 'error',
      };
    } finally {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      await queryRunner.release();
    }
  }
}
