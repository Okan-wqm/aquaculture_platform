/**
 * DeleteParamEquipmentHandler
 *
 * Removes a line from a unit's manual-entry plan. The source row is unbound,
 * not deleted (FARM-HIGH-373): what was planned at a point on a past date
 * stays answerable, and the live-row uniques let the line be added again. A
 * sensor channel source is ended with unbindParameterChannel, which also
 * promotes its backup.
 *
 * @module WaterQuality/Handlers
 */
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource, IsNull } from 'typeorm';

import { DeleteParamEquipmentCommand } from '../commands/delete-param-equipment.command';
import { WaterQualityParamEquipment } from '../entities/water-quality-param-equipment.entity';
import { lockParameterConfig, unbindSources } from '../services/parameter-sources';
import { runSourceTransaction } from '../services/source-transaction';

@Injectable()
@CommandHandler(DeleteParamEquipmentCommand)
export class DeleteParamEquipmentHandler
  implements ICommandHandler<DeleteParamEquipmentCommand, boolean>
{
  private readonly logger = new Logger(DeleteParamEquipmentHandler.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(command: DeleteParamEquipmentCommand): Promise<boolean> {
    const { tenantId, mappingId, userId } = command;

    await runSourceTransaction(this.dataSource, tenantId, async (queryRunner) => {
      const sources = tenantManagerRepo(queryRunner.manager, WaterQualityParamEquipment, tenantId);
      const found = await sources.findOne({ where: { id: mappingId, unboundAt: IsNull() } });
      if (found === null) {
        throw new NotFoundException(
          `Param-equipment mapping '${mappingId}' not found for this tenant`,
        );
      }
      if (found.channelKey !== null) {
        throw new BadRequestException(
          'This is a sensor channel source; end it with unbindParameterChannel',
        );
      }
      await lockParameterConfig(queryRunner.manager, tenantId, found.parameterConfigId);
      const line = await sources.findOne({
        where: { id: mappingId, unboundAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      if (line === null) {
        throw new NotFoundException(
          `Param-equipment mapping '${mappingId}' not found for this tenant`,
        );
      }
      await unbindSources(queryRunner.manager, tenantId, [line.id], userId);
    });

    this.logger.log(JSON.stringify({ event: 'parameter_plan_line_removed', tenantId, mappingId }));
    return true;
  }
}
