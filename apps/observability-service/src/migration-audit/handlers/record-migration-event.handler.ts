import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommandHandler, type ICommandHandler } from '@platform/cqrs';

import {
  hmacTenantHash,
  sanitizePgError,
} from '@aquaculture/backend-common';

import { RecordMigrationEventCommand } from '../commands/record-migration-event.command';
import { MigrationEventRepository } from '../repositories/migration-event.repository';
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

    let errorDetail: Record<string, unknown> | null = null;
    if (p.error !== undefined && p.error !== null) {
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

    this.logger.debug(
      `migration-audit: ${p.serviceName} ${p.eventType} ${p.migrationName}${tenantIdHash ? ` tenant=${tenantIdHash.slice(0, 12)}…` : ''}`,
    );
    return saved;
  }
}
