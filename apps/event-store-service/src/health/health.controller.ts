import { StandardHealthController } from '@aquaculture/backend-common/health';
import type { ReadinessResponse } from '@aquaculture/backend-common/health';
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Response } from 'express';
import { DataSource } from 'typeorm';

import { assertEventStoreTenantScopePolicy } from '../guards/event-store-service-identity.guard';

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

  protected override async getAdditionalChecks(): Promise<Record<string, 'ok' | 'error'>> {
    return {
      tenant_scope_policy: this.checkTenantScopePolicy(),
      no_active_rls_bypass: await this.checkNoActiveRlsBypass(),
      ledger_position_trigger: await this.checkExists(`
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_assign_stored_event_global_position'
          AND NOT tgisinternal
      `),
      stored_events_append_only: await this.checkTrigger('trg_stored_events_append_only'),
      snapshots_immutable: await this.checkTrigger('trg_snapshots_immutable'),
      event_streams_no_delete: await this.checkTrigger('trg_event_streams_no_delete'),
      stored_events_force_rls: await this.checkForcedRls('stored_events'),
      event_streams_force_rls: await this.checkForcedRls('event_streams'),
      snapshots_force_rls: await this.checkForcedRls('snapshots'),
      projection_checkpoints_force_rls: await this.checkForcedRls('projection_checkpoints'),
      projection_rebuilds_force_rls: await this.checkForcedRls('projection_rebuilds'),
      stored_events_policy: await this.checkTenantPolicy('stored_events'),
      event_streams_policy: await this.checkTenantPolicy('event_streams'),
      snapshots_policy: await this.checkTenantPolicy('snapshots'),
      projection_checkpoints_policy: await this.checkTenantPolicy('projection_checkpoints'),
      projection_rebuilds_policy: await this.checkTenantPolicy('projection_rebuilds'),
      projection_rebuilds_table: await this.checkExists(`
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'event_store'
          AND table_name = 'projection_rebuilds'
      `),
      tenant_aggregate_version_index: await this.checkExists(`
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'event_store'
          AND indexname = 'IDX_stored_events_tenant_aggregate_version'
      `),
      tenant_stream_version_index: await this.checkExists(`
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'event_store'
          AND indexname = 'IDX_stored_events_tenant_stream_version'
      `),
      producer_idempotency_index: await this.checkExists(`
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'event_store'
          AND indexname = 'IDX_stored_events_tenant_producer_event'
      `),
      immutable_snapshot_index: await this.checkExists(`
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'event_store'
          AND indexname = 'IDX_snapshots_tenant_aggregate_version'
      `),
    };
  }

  @Get('ready')
  override async readiness(@Res() res: Response): Promise<void> {
    const checks: ReadinessResponse['checks'] = {
      database: await this.checkDatabase(),
    };
    Object.assign(checks, await this.getAdditionalChecks());
    const hasError = Object.values(checks).some((value) => value === 'error');
    const body: ReadinessResponse = {
      status: hasError ? 'not_ready' : 'ok',
      checks,
    };
    res.status(hasError ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK).json(body);
  }

  private checkTenantScopePolicy(): 'ok' | 'error' {
    try {
      assertEventStoreTenantScopePolicy();
      return 'ok';
    } catch {
      return 'error';
    }
  }

  private async checkExists(sql: string): Promise<'ok' | 'error'> {
    try {
      const rows = (await this.dataSource.query(sql)) as unknown[];
      return rows.length > 0 ? 'ok' : 'error';
    } catch {
      return 'error';
    }
  }

  private async checkNoActiveRlsBypass(): Promise<'ok' | 'error'> {
    try {
      const rows = (await this.dataSource.query(`
        SELECT current_setting('app.bypass_rls', true) AS bypass
      `)) as Array<{ bypass?: string | null }>;
      return rows[0]?.bypass === 'on' ? 'error' : 'ok';
    } catch {
      return 'error';
    }
  }

  private async checkTrigger(triggerName: string): Promise<'ok' | 'error'> {
    return this.checkExists(`
      SELECT 1
      FROM pg_trigger
      WHERE tgname = '${triggerName}'
        AND NOT tgisinternal
    `);
  }

  private async checkForcedRls(tableName: string): Promise<'ok' | 'error'> {
    return this.checkExists(`
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'event_store'
        AND c.relname = '${tableName}'
        AND c.relrowsecurity
        AND c.relforcerowsecurity
    `);
  }

  private async checkTenantPolicy(tableName: string): Promise<'ok' | 'error'> {
    return this.checkExists(`
      SELECT 1
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'event_store'
        AND c.relname = '${tableName}'
        AND p.polname = 'tenant_isolation_policy'
        AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.current_tenant%'
        AND pg_get_expr(p.polqual, p.polrelid) LIKE '%tenantId%'
        AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%app.current_tenant%'
        AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%tenantId%'
    `);
  }
}
