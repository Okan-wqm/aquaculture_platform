/**
 * UpdateParameterConfigHandler
 *
 * Updates an existing water quality parameter configuration.
 * Validates existence and code uniqueness when code is changed.
 *
 * @module WaterQuality/Handlers
 */
import { Injectable, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { UpdateParameterConfigCommand } from '../commands/update-parameter-config.command';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { ParameterConfigCacheService } from '../services/parameter-config-cache.service';

@Injectable()
@CommandHandler(UpdateParameterConfigCommand)
export class UpdateParameterConfigHandler
  implements ICommandHandler<UpdateParameterConfigCommand, WaterQualityParameterConfig>
{
  private readonly logger = new Logger(UpdateParameterConfigHandler.name);

  constructor(
    @InjectRepository(WaterQualityParameterConfig)
    private readonly configRepository: Repository<WaterQualityParameterConfig>,
    private readonly configCache: ParameterConfigCacheService,
  ) {}

  async execute(command: UpdateParameterConfigCommand): Promise<WaterQualityParameterConfig> {
    const { tenantId, configId, payload } = command;

    this.logger.log(`Updating parameter config ${configId} for tenant ${tenantId}`);

    const config = await this.configRepository.findOne({
      where: { id: configId, tenantId },
    });

    if (!config) {
      throw new NotFoundException(
        `Parameter config with ID '${configId}' not found for this tenant`,
      );
    }

    // If code is being changed, check uniqueness of new code
    if (payload.code !== undefined && payload.code !== config.code) {
      const codeConflict = await this.configRepository.findOne({
        where: { tenantId, code: payload.code, id: Not(configId) },
      });

      if (codeConflict) {
        throw new ConflictException(
          `Parameter config with code '${payload.code}' already exists for this tenant`,
        );
      }
    }

    // Apply only defined fields from payload
    if (payload.code !== undefined) config.code = payload.code;
    if (payload.name !== undefined) config.name = payload.name;
    if (payload.unit !== undefined) config.unit = payload.unit;
    if (payload.dataType !== undefined) config.dataType = payload.dataType as WaterQualityParameterConfig['dataType'];
    if (payload.precision !== undefined) config.precision = payload.precision;
    if (payload.group !== undefined) config.group = payload.group as WaterQualityParameterConfig['group'];
    if (payload.optimalMin !== undefined) config.optimalMin = payload.optimalMin;
    if (payload.optimalMax !== undefined) config.optimalMax = payload.optimalMax;
    if (payload.warningMin !== undefined) config.warningMin = payload.warningMin;
    if (payload.warningMax !== undefined) config.warningMax = payload.warningMax;
    if (payload.criticalMin !== undefined) config.criticalMin = payload.criticalMin;
    if (payload.criticalMax !== undefined) config.criticalMax = payload.criticalMax;
    if (payload.speciesLimits !== undefined) config.speciesLimits = payload.speciesLimits as WaterQualityParameterConfig['speciesLimits'];
    if (payload.enumValues !== undefined) config.enumValues = payload.enumValues;
    if (payload.chartColor !== undefined) config.chartColor = payload.chartColor;
    if (payload.icon !== undefined) config.icon = payload.icon;
    if (payload.displayOrder !== undefined) config.displayOrder = payload.displayOrder;
    if (payload.isVisible !== undefined) config.isVisible = payload.isVisible;
    if (payload.isRequired !== undefined) config.isRequired = payload.isRequired;
    if (payload.isActive !== undefined) config.isActive = payload.isActive;
    if (payload.chartAxisGroup !== undefined) config.chartAxisGroup = payload.chartAxisGroup;
    if (payload.templateSource !== undefined) config.templateSource = payload.templateSource;

    const saved = await this.configRepository.save(config);

    this.configCache.invalidate(tenantId);

    this.logger.log(`Parameter config ${configId} updated for tenant ${tenantId}`);

    return saved;
  }
}
