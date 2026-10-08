/**
 * BulkMapParamsEquipmentHandler
 *
 * Puts several parameters into a unit's manual-entry plan at once: one manual
 * source per parameter at the unit's representative location, skipping those
 * already planned there and parameters the tenant does not have. The unit is
 * classified once (a tank is a tank point). One transaction; each parameter
 * is locked before its line is written, in a fixed order so two bulk maps
 * cannot deadlock on each other.
 *
 * @module WaterQuality/Handlers
 */
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource, In, IsNull } from 'typeorm';

import { BulkMapParamsEquipmentCommand } from '../commands/bulk-map-params-equipment.command';
import {
  MonitoringFrequency,
  WaterQualityParamEquipment,
} from '../entities/water-quality-param-equipment.entity';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { resolveMeasurementUnit } from '../services/measurement-unit';
import {
  liveAtLocation,
  liveAtPoint,
  pointColumns,
  representativeLocation,
  unitPoint,
} from '../services/parameter-sources';
import { runSourceTransaction } from '../services/source-transaction';

@Injectable()
@CommandHandler(BulkMapParamsEquipmentCommand)
export class BulkMapParamsEquipmentHandler
  implements ICommandHandler<BulkMapParamsEquipmentCommand, WaterQualityParamEquipment[]>
{
  private readonly logger = new Logger(BulkMapParamsEquipmentHandler.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(command: BulkMapParamsEquipmentCommand): Promise<WaterQualityParamEquipment[]> {
    const { tenantId, payload, userId } = command;
    const { equipmentId, parameterConfigIds } = payload;
    const frequency = payload.monitoringFrequency ?? MonitoringFrequency.ON_DEMAND;

    return runSourceTransaction(this.dataSource, tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const unit = await resolveMeasurementUnit(manager, equipmentId, tenantId);
      if (unit === null) {
        throw new NotFoundException(`Unit '${equipmentId}' not found for this tenant`);
      }
      const point = unitPoint(unit);
      const location = representativeLocation(point);
      const configs =
        parameterConfigIds.length === 0
          ? []
          : await tenantManagerRepo(manager, WaterQualityParameterConfig, tenantId).find({
              where: { id: In([...new Set(parameterConfigIds)]) },
              order: { id: 'ASC' },
              lock: { mode: 'pessimistic_write' },
            });
      const sources = tenantManagerRepo(manager, WaterQualityParamEquipment, tenantId);
      let created = 0;
      for (const config of configs) {
        const planned = await sources.findOne({
          where: { ...liveAtLocation(config.id, location), channelKey: IsNull() },
        });
        if (planned !== null) {
          continue;
        }
        await sources.save({
          tenantId,
          parameterConfigId: config.id,
          ...pointColumns(point),
          position: location.position,
          depthM: location.depthM,
          monitoringFrequency: frequency,
          alertEnabled: true,
          boundBy: userId,
        });
        created += 1;
      }
      this.logger.log(
        JSON.stringify({
          event: 'parameter_plan_bulk_mapped',
          tenantId,
          unitId: unit.id,
          created,
          skipped: parameterConfigIds.length - created,
        }),
      );
      return sources.find({
        where: { ...liveAtPoint(point), channelKey: IsNull() },
        relations: ['parameterConfig'],
        order: { createdAt: 'ASC' },
      });
    });
  }
}
