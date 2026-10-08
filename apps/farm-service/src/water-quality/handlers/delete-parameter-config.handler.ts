/**
 * DeleteParameterConfigHandler
 *
 * Soft-deletes a water quality parameter configuration by setting isActive=false.
 *
 * @module WaterQuality/Handlers
 */
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DeleteParameterConfigCommand } from '../commands/delete-parameter-config.command';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { ParameterConfigCacheService } from '../services/parameter-config-cache.service';
import { liveChannelSourceCount, lockParameterConfig } from '../services/parameter-sources';
import { runSourceTransaction } from '../services/source-transaction';

@Injectable()
@CommandHandler(DeleteParameterConfigCommand)
export class DeleteParameterConfigHandler
  implements ICommandHandler<DeleteParameterConfigCommand, boolean>
{
  private readonly logger = new Logger(DeleteParameterConfigHandler.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configCache: ParameterConfigCacheService,
  ) {}

  async execute(command: DeleteParameterConfigCommand): Promise<boolean> {
    const { tenantId, configId } = command;

    this.logger.log(`Soft-deleting parameter config ${configId} for tenant ${tenantId}`);

    await runSourceTransaction(this.dataSource, tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const config = await lockParameterConfig(manager, tenantId, configId);
      // A bound channel feeds this parameter: end it first (plan Q8).
      if ((await liveChannelSourceCount(manager, tenantId, config.id)) > 0) {
        throw new ConflictException(
          'A sensor channel is bound to this parameter; unbind it before deleting the parameter',
        );
      }
      config.isActive = false;
      await tenantManagerRepo(manager, WaterQualityParameterConfig, tenantId).save(config);
    });

    this.configCache.invalidate(tenantId);

    this.logger.log(`Parameter config ${configId} soft-deleted for tenant ${tenantId}`);

    return true;
  }
}
