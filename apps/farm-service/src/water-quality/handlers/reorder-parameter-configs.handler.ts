/**
 * ReorderParameterConfigsHandler
 *
 * Reorders water quality parameter configurations by updating displayOrder
 * for each config based on its position in the orderedIds array.
 * Uses a transaction for atomicity.
 *
 * @module WaterQuality/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { ReorderParameterConfigsCommand } from '../commands/reorder-parameter-configs.command';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { ParameterConfigCacheService } from '../services/parameter-config-cache.service';

@Injectable()
@CommandHandler(ReorderParameterConfigsCommand)
export class ReorderParameterConfigsHandler
  implements ICommandHandler<ReorderParameterConfigsCommand, WaterQualityParameterConfig[]>
{
  private readonly logger = new Logger(ReorderParameterConfigsHandler.name);

  constructor(
    @InjectRepository(WaterQualityParameterConfig)
    private readonly configRepository: Repository<WaterQualityParameterConfig>,
    private readonly dataSource: DataSource,
    private readonly configCache: ParameterConfigCacheService,
  ) {}

  async execute(
    command: ReorderParameterConfigsCommand,
  ): Promise<WaterQualityParameterConfig[]> {
    const { tenantId, orderedIds } = command;

    this.logger.log(
      `Reordering ${orderedIds.length} parameter configs for tenant ${tenantId}`,
    );

    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await queryRunner.manager.update(
          WaterQualityParameterConfig,
          { id: orderedIds[i], tenantId },
          { displayOrder: i + 1 },
        );
      }
    });

    this.configCache.invalidate(tenantId);

    // Return updated configs sorted by displayOrder
    const updatedConfigs = await this.configRepository.find({
      where: { tenantId, id: In(orderedIds) },
      order: { displayOrder: 'ASC' },
    });

    this.logger.log(
      `Reordered ${updatedConfigs.length} parameter configs for tenant ${tenantId}`,
    );

    return updatedConfigs;
  }
}
