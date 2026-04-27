import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CommandHandler, type ICommandHandler } from '@platform/cqrs';
import { Between, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { hmacTenantHash } from '@aquaculture/backend-common/utils';

import { MigrationEventEntity } from '../../database/entities/migration-event.entity';
import { ExportObservabilityTenantDataCommand } from '../commands/export-observability-tenant-data.command';

export interface ExportedMigrationEvent {
  readonly occurredAt: Date;
  readonly serviceName: string;
  readonly migrationName: string;
  readonly eventType: string;
  readonly driftClassId: string | null;
  readonly durationMs: number | null;
  readonly environment: string;
  /** Whether the event carried structured error metadata. */
  readonly hadError: boolean;
}

export interface ExportObservabilityTenantDataResult {
  readonly tenantIdHash: string;
  readonly count: number;
  readonly events: readonly ExportedMigrationEvent[];
  readonly exportedAt: string;
}

/**
 * GDPR Art 15 (access) + Art 20 (portability) — returns the tenant's
 * migration_events rows in a structured shape the DSAR orchestrator
 * pipes into the caller's preferred export.
 *
 * Does NOT return error_detail JSONB directly — that column has already
 * passed sanitizePgError at ingest time, but returning it in a DSAR
 * export doubles the exposure surface. Instead we expose a boolean
 * `hadError` so the tenant knows an error occurred without revealing
 * the (already-sanitized) message. Operators with audit access can
 * look up the raw row by (tenantIdHash, occurredAt) if needed.
 */
@Injectable()
@CommandHandler(ExportObservabilityTenantDataCommand)
export class ExportObservabilityTenantDataHandler
  implements
    ICommandHandler<
      ExportObservabilityTenantDataCommand,
      ExportObservabilityTenantDataResult
    >
{
  private readonly logger = new Logger(
    ExportObservabilityTenantDataHandler.name,
  );

  constructor(
    @InjectRepository(MigrationEventEntity)
    private readonly repo: Repository<MigrationEventEntity>,
  ) {}

  async execute(
    command: ExportObservabilityTenantDataCommand,
  ): Promise<ExportObservabilityTenantDataResult> {
    const { tenantSchema, fromOccurredAt, toOccurredAt } = command.payload;
    if (!tenantSchema || typeof tenantSchema !== 'string') {
      throw new TypeError(
        '[ExportObservabilityTenantData] tenantSchema must be a non-empty string',
      );
    }
    const tenantIdHash = hmacTenantHash(tenantSchema);

    const occurredAtFilter =
      fromOccurredAt && toOccurredAt
        ? Between(fromOccurredAt, toOccurredAt)
        : fromOccurredAt
          ? MoreThanOrEqual(fromOccurredAt)
          : toOccurredAt
            ? LessThanOrEqual(toOccurredAt)
            : undefined;

    const rows = await this.repo.find({
      where: {
        tenantIdHash,
        ...(occurredAtFilter ? { occurredAt: occurredAtFilter } : {}),
      },
      order: { occurredAt: 'ASC' },
    });

    const events: ExportedMigrationEvent[] = rows.map((r) => ({
      occurredAt: r.occurredAt,
      serviceName: r.serviceName,
      migrationName: r.migrationName,
      eventType: r.eventType,
      driftClassId: r.driftClassId,
      durationMs: r.durationMs,
      environment: r.environment,
      hadError: r.errorDetail !== null,
    }));

    this.logger.log(
      `dsar export: tenant=${tenantIdHash.slice(0, 12)}… — ${events.length} event(s)`,
    );

    return {
      tenantIdHash,
      count: events.length,
      events,
      exportedAt: new Date().toISOString(),
    };
  }
}
