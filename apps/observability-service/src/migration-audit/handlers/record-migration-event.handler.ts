import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { CommandHandler, type ICommandHandler } from '@platform/cqrs';
import { Repository } from 'typeorm';

import { hmacTenantHash, sanitizePgError } from '@aquaculture/backend-common/utils';

import { RecordMigrationEventCommand } from '../commands/record-migration-event.command';
import { MigrationEventRepository } from '../repositories/migration-event.repository';
import { MigrationBackfillProgressEntity } from '../../database/entities/migration-backfill-progress.entity';
import type { MigrationEventEntity } from '../../database/entities/migration-event.entity';

/**
 * RecordMigrationEventHandler — persists a db-migrate / drift event with
 * mandatory sanitization + HMAC pseudonymisation applied. This is the
 * ONLY path into `observability.migration_events`; the repository
 * insert is package-private (module scope) so no alternate write site
 * can bypass the PII contract.
 *
 * Contract:
 *   1. error_detail → sanitizePgError() → assertNoPgRowLeak() guards.
 *   2. tenantSchema cleartext → HMAC via per-env pepper. If pepper is
 *      unset and a tenantSchema was provided, fail-closed (throw).
 *   3. environment defaults to AQUA_ENV or 'development'.
 *   4. occurredAt defaults to now() when omitted.
 *
 * The handler must never log the cleartext tenantSchema — only the
 * hashed form appears in logs.
 */
@Injectable()
@CommandHandler(RecordMigrationEventCommand)
export class RecordMigrationEventHandler
  implements ICommandHandler<RecordMigrationEventCommand, MigrationEventEntity>
{
  private readonly logger = new Logger(RecordMigrationEventHandler.name);

  constructor(
    private readonly repo: MigrationEventRepository,
    private readonly configService: ConfigService,
    @InjectRepository(MigrationBackfillProgressEntity)
    private readonly progressRepo: Repository<MigrationBackfillProgressEntity>,
  ) {}

  async execute(
    command: RecordMigrationEventCommand,
  ): Promise<MigrationEventEntity> {
    const p = command.payload;

    let tenantIdHash: string | null = null;
    if (p.tenantSchema !== undefined && p.tenantSchema !== null) {
      // hmacTenantHash throws in production when TENANT_HASH_PEPPER is
      // unset — fail-closed semantics live inside the utility (ADR-022).
      // Dev falls back to a documented deterministic default so local
      // tests are reproducible without vault provisioning.
      tenantIdHash = hmacTenantHash(p.tenantSchema);
    }

    // Caller may EITHER pass `error` (raw) for sanitization, OR
    // `errorDetail` (already-sanitized — NATS consumer path). Both is
    // ambiguous — throw rather than silently ignoring one.
    if (p.error !== undefined && p.errorDetail !== undefined) {
      throw new Error(
        '[RecordMigrationEventHandler] payload carries BOTH error and errorDetail — ambiguous. Supply exactly one.',
      );
    }

    let errorDetail: Record<string, unknown> | null = null;
    if (p.errorDetail !== undefined) {
      // Pre-sanitized — persist verbatim. NATS publisher already
      // scrubbed via sanitizePgError before crossing the wire.
      errorDetail = {
        sqlState: p.errorDetail.sqlState,
        template: p.errorDetail.template,
        constraintName: p.errorDetail.constraintName,
        relation: p.errorDetail.relation,
        ...(p.errorDetail.columns !== undefined
          ? { columns: p.errorDetail.columns }
          : {}),
      };
    } else if (p.error !== undefined && p.error !== null) {
      // sanitizePgError strips row-leak patterns (Key (ssn)=(...), Failing
      // row contains (...)) and runs the secondary maskPii() backstop.
      // Persisted fields expose SQLSTATE + constraint + relation +
      // columns but NEVER row values (see SanitizedPgError contract).
      const sanitized = sanitizePgError(p.error);
      errorDetail = {
        sqlState: sanitized.sqlState,
        template: sanitized.template,
        constraintName: sanitized.constraintName,
        relation: sanitized.relation,
        columns: sanitized.columns,
      };
    }

    const environment =
      p.environment ??
      this.configService.get<string>('AQUA_ENV', 'development');

    const saved = await this.repo.insert({
      occurredAt: p.occurredAt ?? new Date(),
      serviceName: p.serviceName,
      migrationName: p.migrationName,
      eventType: p.eventType,
      tenantIdHash,
      driftClassId: p.driftClassId ?? null,
      durationMs: p.durationMs ?? null,
      errorDetail,
      environment,
    });

    // R6 runtime gate feed: every successful MIGRATION apply (not
    // every event type; validator_* / start / skipped / failed do
    // not count) writes an UPSERT row to migration_backfill_progress.
    // Contract-phase @ExpandContract migrations read this truth
    // before executing their up() body. Keeping the write inside the
    // handler means it is automatic for every service that already
    // routes applied events through the CQRS bus — no new
    // integration per service.
    //
    // Tenant fan-out events (tenantSchema present) are the SAME
    // logical migration applying to a tenant clone, not a distinct
    // migration to backfill. We gate the progress write to
    // source-schema events (tenantSchema absent) so dependency
    // lookup stays environment-scoped, not per-tenant.
    if (p.eventType === 'applied' && p.tenantSchema === undefined) {
      // ON CONFLICT DO NOTHING via a raw INSERT. TypeORM save() would
      // UPDATE on conflict which would overwrite the original
      // timestamp — we keep the FIRST successful apply's timestamp,
      // always.
      await this.progressRepo.query(
        `INSERT INTO observability.migration_backfill_progress
           (migration_name, environment, service_name, applied_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (migration_name, environment) DO NOTHING`,
        [
          p.migrationName,
          environment,
          p.serviceName,
          (p.occurredAt ?? new Date()).toISOString(),
        ],
      );
    }

    this.logger.debug(
      `migration-audit: ${p.serviceName} ${p.eventType} ${p.migrationName}${tenantIdHash ? ` tenant=${tenantIdHash.slice(0, 12)}…` : ''}`,
    );
    return saved;
  }
}
