/**
 * UpdateParameterConfigHandler
 *
 * Updates an existing water quality parameter configuration.
 * Validates existence and code uniqueness when code is changed.
 *
 * Runs behind the parameter's lock like every write to its sources or meaning
 * (FARM-HIGH-373, plan D8). While a sensor channel is bound, the code and the
 * unit cannot change and the parameter cannot be deactivated: the channel was
 * accepted for this meaning (plan Q8). Once measurements recorded values under
 * the code, code and unit are fixed for good (plan D7). A code change must keep a declared
 * quantity valid. The database refuses a second active config of one
 * measured quantity (409).
 *
 * @module WaterQuality/Handlers
 */
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Not } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { UpdateParameterConfigCommand } from '../commands/update-parameter-config.command';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { declarableQuantitiesOfParameter } from '../data/parameter-quantities';
import { ParameterConfigCacheService } from '../services/parameter-config-cache.service';
import { parameterHasMeasurements } from '../services/parameter-meaning';
import { liveChannelSourceCount, lockParameterConfig } from '../services/parameter-sources';
import { runSourceTransaction } from '../services/source-transaction';

@Injectable()
@CommandHandler(UpdateParameterConfigCommand)
export class UpdateParameterConfigHandler
  implements ICommandHandler<UpdateParameterConfigCommand, WaterQualityParameterConfig>
{
  private readonly logger = new Logger(UpdateParameterConfigHandler.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configCache: ParameterConfigCacheService,
  ) {}

  async execute(command: UpdateParameterConfigCommand): Promise<WaterQualityParameterConfig> {
    const { tenantId, configId, payload } = command;

    this.logger.log(`Updating parameter config ${configId} for tenant ${tenantId}`);

    const saved = await runSourceTransaction(this.dataSource, tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const config = await lockParameterConfig(manager, tenantId, configId);
      const configs = tenantManagerRepo(manager, WaterQualityParameterConfig, tenantId);

      // If code is being changed, check uniqueness of new code
      if (payload.code !== undefined && payload.code !== config.code) {
        const codeConflict = await configs.findOne({
          where: { code: payload.code, id: Not(configId) },
        });
        if (codeConflict) {
          throw new ConflictException(
            `Parameter config with code '${payload.code}' already exists for this tenant`,
          );
        }
        if (
          config.declaredQuantity !== null &&
          !declarableQuantitiesOfParameter(payload.code).includes(config.declaredQuantity)
        ) {
          throw new BadRequestException(
            `A '${payload.code}' parameter cannot record the declared ${config.declaredQuantity}; ` +
              'clear the declaration first',
          );
        }
      }

      const meaningChanges =
        (payload.code !== undefined && payload.code !== config.code) ||
        (payload.unit !== undefined && payload.unit !== config.unit);
      if (meaningChanges && (await parameterHasMeasurements(manager, tenantId, config.code))) {
        throw new ConflictException(
          `Measurements already record '${config.code}' in ${config.unit}; its code and unit are ` +
            'fixed. Create a new parameter for the new meaning.',
        );
      }
      const deactivates = payload.isActive === false && config.isActive;
      if (
        (meaningChanges || deactivates) &&
        (await liveChannelSourceCount(manager, tenantId, config.id)) > 0
      ) {
        throw new ConflictException(
          'A sensor channel is bound to this parameter; unbind it before changing its code, ' +
            'unit or activity',
        );
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

      return configs.save(config);
    });

    this.configCache.invalidate(tenantId);

    this.logger.log(`Parameter config ${configId} updated for tenant ${tenantId}`);

    return saved;
  }
}
