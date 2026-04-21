import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CommandHandler, type ICommandHandler } from '@platform/cqrs';
import { Repository } from 'typeorm';

import { hmacTenantHash } from '@aquaculture/backend-common';

import { MigrationEventEntity } from '../../database/entities/migration-event.entity';
import { EraseObservabilityTenantDataCommand } from '../commands/erase-observability-tenant-data.command';

export interface EraseObservabilityTenantDataResult {
  /** Number of rows that matched the HMAC hash. */
  readonly matchedCount: number;
  /** Number of rows actually deleted (0 when dryRun === true). */
  readonly deletedCount: number;
  /** HMAC tenant hash — for audit trail cross-reference. */
  readonly tenantIdHash: string;
  readonly dryRun: boolean;
}

/**
 * Observability consumer of the TenantErased cascade. HMACs the tenant
 * schema, counts matching rows, then (unless dryRun) issues a DELETE.
 *
 * The handler NEVER logs the cleartext schema — only the hash, and
 * only the first 12 chars so logs remain useful for correlation
 * without becoming a secondary exposure surface.
 */
@Injectable()
@CommandHandler(EraseObservabilityTenantDataCommand)
export class EraseObservabilityTenantDataHandler
  implements
    ICommandHandler<
      EraseObservabilityTenantDataCommand,
      EraseObservabilityTenantDataResult
    >
{
  private readonly logger = new Logger(EraseObservabilityTenantDataHandler.name);

  constructor(
    @InjectRepository(MigrationEventEntity)
    private readonly repo: Repository<MigrationEventEntity>,
  ) {}

  async execute(
    command: EraseObservabilityTenantDataCommand,
  ): Promise<EraseObservabilityTenantDataResult> {
    const { tenantSchema, dryRun = false } = command.payload;
    if (!tenantSchema || typeof tenantSchema !== 'string') {
      throw new TypeError(
        '[EraseObservabilityTenantData] tenantSchema must be a non-empty string',
      );
    }
    const tenantIdHash = hmacTenantHash(tenantSchema);
    const hashPrefix = `${tenantIdHash.slice(0, 12)}…`;

    const matchedCount = await this.repo.count({ where: { tenantIdHash } });

    if (dryRun) {
      this.logger.log(
        `dry-run erasure: tenant=${hashPrefix} — ${matchedCount} row(s) would be deleted`,
      );
      return {
        matchedCount,
        deletedCount: 0,
        tenantIdHash,
        dryRun: true,
      };
    }

    const deleteResult = await this.repo.delete({ tenantIdHash });
    const deletedCount = deleteResult.affected ?? 0;
    this.logger.log(
      `erasure executed: tenant=${hashPrefix} — ${deletedCount}/${matchedCount} row(s) deleted`,
    );
    return {
      matchedCount,
      deletedCount,
      tenantIdHash,
      dryRun: false,
    };
  }
}
