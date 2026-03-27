/**
 * CreateParameterConfigHandler
 *
 * Creates a new water quality parameter configuration for a tenant.
 * Validates code uniqueness per tenant before persisting.
 *
 * @module WaterQuality/Handlers
 */
import { Injectable, ConflictException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { CreateParameterConfigCommand } from '../commands/create-parameter-config.command';
import { WaterQualityParameterConfig, ParameterDataType, ParameterGroup } from '../entities/water-quality-parameter-config.entity';

@Injectable()
@CommandHandler(CreateParameterConfigCommand)
export class CreateParameterConfigHandler
  implements ICommandHandler<CreateParameterConfigCommand, WaterQualityParameterConfig>
{
  private readonly logger = new Logger(CreateParameterConfigHandler.name);

  constructor(
    @InjectRepository(WaterQualityParameterConfig)
    private readonly configRepository: Repository<WaterQualityParameterConfig>,
  ) {}

  async execute(command: CreateParameterConfigCommand): Promise<WaterQualityParameterConfig> {
    const { tenantId, payload } = command;

    this.logger.log(`Creating parameter config "${payload.code}" for tenant ${tenantId}`);

    // Check code uniqueness per tenant
    const existing = await this.configRepository.findOne({
      where: { tenantId, code: payload.code },
    });

    if (existing) {
      throw new ConflictException(
        `Parameter config with code '${payload.code}' already exists for this tenant`,
      );
    }

    const config = this.configRepository.create({
      tenantId,
      code: payload.code,
      name: payload.name,
      unit: payload.unit,
      dataType: (payload.dataType as ParameterDataType) ?? ParameterDataType.NUMBER,
      precision: payload.precision ?? 2,
      group: (payload.group as ParameterGroup) ?? ParameterGroup.BASIC,
      optimalMin: payload.optimalMin,
      optimalMax: payload.optimalMax,
      warningMin: payload.warningMin,
      warningMax: payload.warningMax,
      criticalMin: payload.criticalMin,
      criticalMax: payload.criticalMax,
      speciesLimits: payload.speciesLimits as WaterQualityParameterConfig['speciesLimits'],
      enumValues: payload.enumValues,
      chartColor: payload.chartColor ?? '#3b82f6',
      icon: payload.icon,
      displayOrder: payload.displayOrder ?? 0,
      isVisible: payload.isVisible ?? true,
      isRequired: payload.isRequired ?? false,
      isActive: payload.isActive ?? true,
      chartAxisGroup: payload.chartAxisGroup ?? 'left',
      templateSource: payload.templateSource,
    });

    const saved = await this.configRepository.save(config);

    this.logger.log(
      `Parameter config "${saved.code}" created with ID ${saved.id} for tenant ${tenantId}`,
    );

    return saved;
  }
}
