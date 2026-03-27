/**
 * DeleteParameterConfigHandler
 *
 * Soft-deletes a water quality parameter configuration by setting isActive=false.
 *
 * @module WaterQuality/Handlers
 */
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DeleteParameterConfigCommand } from '../commands/delete-parameter-config.command';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { ParameterConfigCacheService } from '../services/parameter-config-cache.service';

@Injectable()
@CommandHandler(DeleteParameterConfigCommand)
export class DeleteParameterConfigHandler
  implements ICommandHandler<DeleteParameterConfigCommand, boolean>
{
  private readonly logger = new Logger(DeleteParameterConfigHandler.name);

  constructor(
    @InjectRepository(WaterQualityParameterConfig)
    private readonly configRepository: Repository<WaterQualityParameterConfig>,
    private readonly configCache: ParameterConfigCacheService,
  ) {}

  async execute(command: DeleteParameterConfigCommand): Promise<boolean> {
    const { tenantId, configId } = command;

    this.logger.log(`Soft-deleting parameter config ${configId} for tenant ${tenantId}`);

    const config = await this.configRepository.findOne({
      where: { id: configId, tenantId },
    });

    if (!config) {
      throw new NotFoundException(
        `Parameter config with ID '${configId}' not found for this tenant`,
      );
    }

    config.isActive = false;

    await this.configRepository.save(config);

    this.configCache.invalidate(tenantId);

    this.logger.log(`Parameter config ${configId} soft-deleted for tenant ${tenantId}`);

    return true;
  }
}
