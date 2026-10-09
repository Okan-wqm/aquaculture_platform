/**
 * CreateParamEquipmentHandler
 *
 * Adds a parameter to a unit's manual-entry plan: a manual source of the
 * parameter at the unit's representative location. The unit is classified
 * once (measurement-unit.ts), so a tank — whose id lives in `tanks`, not in
 * `equipment` — becomes a tank point instead of a 404. A sensor channel is
 * bound through bindParameterChannel, never through a plan line.
 *
 * Runs in the tenant transaction behind the parameter's lock, like every
 * other write to its sources.
 *
 * @module WaterQuality/Handlers
 */
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource, IsNull } from 'typeorm';

import { CreateParamEquipmentCommand } from '../commands/create-param-equipment.command';
import {
  MonitoringFrequency,
  WaterQualityParamEquipment,
} from '../entities/water-quality-param-equipment.entity';
import { resolveMeasurementUnit } from '../services/measurement-unit';
import {
  liveAtLocation,
  lockParameterConfig,
  pointColumns,
  representativeLocation,
  unitPoint,
} from '../services/parameter-sources';
import { runSourceTransaction } from '../services/source-transaction';

@Injectable()
@CommandHandler(CreateParamEquipmentCommand)
export class CreateParamEquipmentHandler
  implements ICommandHandler<CreateParamEquipmentCommand, WaterQualityParamEquipment>
{
  private readonly logger = new Logger(CreateParamEquipmentHandler.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(command: CreateParamEquipmentCommand): Promise<WaterQualityParamEquipment> {
    const { tenantId, payload, userId } = command;
    if (payload.sensorId !== undefined && payload.sensorId !== null) {
      throw new BadRequestException(
        'A plan line takes no sensor; bind a sensor channel with bindParameterChannel',
      );
    }

    const saved = await runSourceTransaction(this.dataSource, tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      await lockParameterConfig(manager, tenantId, payload.parameterConfigId);
      const unit = await resolveMeasurementUnit(manager, payload.equipmentId, tenantId);
      if (unit === null) {
        throw new NotFoundException(`Unit '${payload.equipmentId}' not found for this tenant`);
      }
      const location = representativeLocation(unitPoint(unit));
      const sources = tenantManagerRepo(manager, WaterQualityParamEquipment, tenantId);
      const existing = await sources.findOne({
        where: { ...liveAtLocation(payload.parameterConfigId, location), channelKey: IsNull() },
      });
      if (existing !== null) {
        throw new ConflictException(
          `Parameter '${payload.parameterConfigId}' is already in the plan of unit '${unit.id}'`,
        );
      }
      return sources.save({
        tenantId,
        parameterConfigId: payload.parameterConfigId,
        ...pointColumns(location.point),
        position: location.position,
        depthM: location.depthM,
        monitoringFrequency: payload.monitoringFrequency ?? MonitoringFrequency.ON_DEMAND,
        alertEnabled: payload.alertEnabled ?? true,
        notes: payload.notes ?? null,
        boundBy: userId,
      });
    });

    this.logger.log(
      JSON.stringify({ event: 'parameter_plan_line_added', tenantId, sourceId: saved.id }),
    );
    return saved;
  }
}
