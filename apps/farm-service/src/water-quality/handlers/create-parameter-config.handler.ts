import { colors } from '@aquaculture/shared-contracts';
/**
 * CreateParameterConfigHandler
 *
 * Creates a new water quality parameter configuration for a tenant.
 * Validates code uniqueness per tenant before persisting.
 *
 * @module WaterQuality/Handlers
 */
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Injectable, ConflictException, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { CreateParameterConfigCommand } from '../commands/create-parameter-config.command';
import { WaterQualityParameterConfig, ParameterDataType, ParameterGroup } from '../entities/water-quality-parameter-config.entity';
import { ParameterConfigCacheService } from '../services/parameter-config-cache.service';
import { runSourceTransaction } from '../services/source-transaction';

@Injectable()
@CommandHandler(CreateParameterConfigCommand)
export class CreateParameterConfigHandler
  implements ICommandHandler<CreateParameterConfigCommand, WaterQualityParameterConfig>
{
  private readonly logger = new Logger(CreateParameterConfigHandler.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configCache: ParameterConfigCacheService,
  ) {}

  async execute(command: CreateParameterConfigCommand): Promise<WaterQualityParameterConfig> {
    const { tenantId, payload } = command;

    this.logger.log(`Creating parameter config "${payload.code}" for tenant ${tenantId}`);

    // In the tenant transaction: the database refuses a second active config
    // of one measured quantity (409), and the trigger stamps its meaning.
    const saved = await runSourceTransaction(this.dataSource, tenantId, async (queryRunner) => {
      const configs = tenantManagerRepo(queryRunner.manager, WaterQualityParameterConfig, tenantId);
      // Check code uniqueness per tenant
      const existing = await configs.findOne({
        where: { code: payload.code },
      });

      if (existing) {
        throw new ConflictException(
          `Parameter config with code '${payload.code}' already exists for this tenant`,
        );
      }

      const config = configs.create({
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
        chartColor: payload.chartColor ?? colors.info[500],
        icon: payload.icon,
        displayOrder: payload.displayOrder ?? 0,
        isVisible: payload.isVisible ?? true,
        isRequired: payload.isRequired ?? false,
        isActive: payload.isActive ?? true,
        chartAxisGroup: payload.chartAxisGroup ?? 'left',
        templateSource: payload.templateSource,
      });

      return configs.save(config);
    });

    this.configCache.invalidate(tenantId);

    this.logger.log(
      `Parameter config "${saved.code}" created with ID ${saved.id} for tenant ${tenantId}`,
    );

    return saved;
  }
}
