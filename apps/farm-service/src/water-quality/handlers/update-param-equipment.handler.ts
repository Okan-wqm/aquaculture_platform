/**
 * UpdateParamEquipmentHandler
 *
 * Edits a live line of a unit's manual-entry plan: cadence, alert switch,
 * whether it is in the plan, notes. A sensor channel source has none of
 * these (its cadence and alerts are the channel's) and is changed through
 * the binding commands; a plan line takes no sensor.
 *
 * @module WaterQuality/Handlers
 */
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource, IsNull } from 'typeorm';

import { UpdateParamEquipmentCommand } from '../commands/update-param-equipment.command';
import { WaterQualityParamEquipment } from '../entities/water-quality-param-equipment.entity';
import { lockParameterConfig } from '../services/parameter-sources';
import { runSourceTransaction } from '../services/source-transaction';

@Injectable()
@CommandHandler(UpdateParamEquipmentCommand)
export class UpdateParamEquipmentHandler
  implements ICommandHandler<UpdateParamEquipmentCommand, WaterQualityParamEquipment>
{
  private readonly logger = new Logger(UpdateParamEquipmentHandler.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(command: UpdateParamEquipmentCommand): Promise<WaterQualityParamEquipment> {
    const { tenantId, mappingId, payload } = command;
    if (payload.sensorId !== undefined && payload.sensorId !== null) {
      throw new BadRequestException(
        'A plan line takes no sensor; bind a sensor channel with bindParameterChannel',
      );
    }

    const saved = await runSourceTransaction(this.dataSource, tenantId, async (queryRunner) => {
      const sources = tenantManagerRepo(queryRunner.manager, WaterQualityParamEquipment, tenantId);
      const found = await sources.findOne({ where: { id: mappingId, unboundAt: IsNull() } });
      if (found === null) {
        throw new NotFoundException(`Param-equipment mapping '${mappingId}' not found for this tenant`);
      }
      if (found.channelKey !== null) {
        throw new BadRequestException(
          'This is a sensor channel source; change it with the channel binding commands',
        );
      }
      await lockParameterConfig(queryRunner.manager, tenantId, found.parameterConfigId);
      const line = await sources.findOne({
        where: { id: mappingId, unboundAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      if (line === null) {
        throw new NotFoundException(`Param-equipment mapping '${mappingId}' not found for this tenant`);
      }
      if (payload.monitoringFrequency !== undefined) {
        line.monitoringFrequency = payload.monitoringFrequency;
      }
      if (payload.alertEnabled !== undefined) {
        line.alertEnabled = payload.alertEnabled;
      }
      if (payload.isActive !== undefined) {
        line.isActive = payload.isActive;
      }
      if (payload.notes !== undefined) {
        line.notes = payload.notes;
      }
      return sources.save(line);
    });

    this.logger.log(JSON.stringify({ event: 'parameter_plan_line_updated', tenantId, mappingId }));
    return saved;
  }
}
