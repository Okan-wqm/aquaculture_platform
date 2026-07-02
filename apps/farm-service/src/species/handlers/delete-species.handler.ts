/**
 * Delete Species Command Handler
 * @module Species/Handlers
 */
import {
  runInTenantTransaction,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, Logger, ConflictException } from '@nestjs/common';
import { DeleteSpeciesCommand } from '../commands/delete-species.command';
import { Species } from '../entities/species.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { AuditAction } from '../../database/entities/audit-log.entity';

@CommandHandler(DeleteSpeciesCommand)
export class DeleteSpeciesHandler
  implements ICommandHandler<DeleteSpeciesCommand, boolean>
{
  private readonly logger = new Logger(DeleteSpeciesHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
  ) {}

  async execute(command: DeleteSpeciesCommand): Promise<boolean> {
    const { tenantId, userId, id } = command;

    this.logger.log(`Deleting species: ${id} for tenant: ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const speciesRepo = tenantManagerRepo(queryRunner.manager, Species, tenantId);
      const batchRepo = tenantManagerRepo(queryRunner.manager, Batch, tenantId);

      // Find existing
      const existing = await speciesRepo.findOne({
        where: { id, tenantId },
      });

      if (!existing) {
        throw new NotFoundException(`Species with id "${id}" not found`);
      }

      // Check for active batches referencing this species
      const batchCount = await batchRepo.count({
        where: { tenantId, speciesId: id },
      });

      if (batchCount > 0) {
        throw new ConflictException(
          `Cannot delete species "${existing.scientificName}". It has ${batchCount} associated batch(es).`,
        );
      }

      // Soft delete - mark as deleted AND inactive
      existing.isDeleted = true;
      existing.deletedAt = new Date();
      existing.deletedBy = userId;
      existing.isActive = false;
      existing.updatedBy = userId;

      await speciesRepo.save(existing);

      // Audit log
      await this.auditLogService.log({
        tenantId,
        entityType: 'Species',
        entityId: id,
        action: AuditAction.SOFT_DELETE,
        userId,
        changes: {
          before: {
            scientificName: existing.scientificName,
            code: existing.code,
            isActive: true,
            isDeleted: false,
          },
          after: {
            isActive: false,
            isDeleted: true,
          },
        },
      });

      this.logger.log(`Species soft-deleted: ${id}`);

      return true;
    });
  }
}
