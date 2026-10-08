/**
 * BindParameterChannelHandler
 *
 * Makes a sensor channel a source of a water-quality parameter at a point
 * (FARM-HIGH-373, plan rev2 §5 and D8):
 *
 * 1. Tenant read: the parameter (active) and the point (live) exist — 404
 *    before the sensor service is asked anything.
 * 2. Outside any database connection: the directory describes the channel
 *    (503 when it cannot — fail closed).
 * 3. Tenant transaction: the parameter row FOR UPDATE (every write to a
 *    parameter's sources or meaning takes it), its meaning unchanged since
 *    step 1 (409), the point FOR SHARE (a concurrent delete waits, then closes
 *    this source), the shared rule plus placement (400 with problem codes),
 *    the priority rules (409/400), insert (unique → 409), audit row.
 *
 * Nothing about the channel is stored but its key: the next read asks again.
 *
 * @module WaterQuality/Handlers
 */
import { runInTenantRead, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { ChannelBindingRefusedError } from '../../common/errors/farm-errors';
import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { BindParameterChannelCommand } from '../commands/bind-parameter-channel.command';
import { WaterQualityParamEquipment } from '../entities/water-quality-param-equipment.entity';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import {
  assertParameterUnchanged,
  assessChannel,
  priorityConflict,
  quantitySnapshot,
} from '../services/channel-binding-rules';
import { assertLivePoint } from '../services/measurement-point-lookup';
import { auditSourceChange } from '../services/parameter-source-audit';
import {
  liveChannelSourcesAt,
  lockParameterConfig,
  pointColumns,
} from '../services/parameter-sources';
import { SensorChannelDirectory } from '../services/sensor-channel-directory.service';
import { runSourceTransaction } from '../services/source-transaction';

@Injectable()
@CommandHandler(BindParameterChannelCommand)
export class BindParameterChannelHandler
  implements ICommandHandler<BindParameterChannelCommand, WaterQualityParamEquipment>
{
  private readonly logger = new Logger(BindParameterChannelHandler.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly directory: SensorChannelDirectory,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(command: BindParameterChannelCommand): Promise<WaterQualityParamEquipment> {
    const { tenantId, payload, userId } = command;
    const { parameterConfigId, location, channel, priority } = payload;

    const snapshot = await runInTenantRead(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner) => {
        const config = await tenantManagerRepo(
          queryRunner.manager,
          WaterQualityParameterConfig,
          tenantId,
        ).findOne({ where: { id: parameterConfigId, isActive: true } });
        if (config === null) {
          throw new NotFoundException(`No active parameter '${parameterConfigId}' in this tenant`);
        }
        await assertLivePoint(queryRunner.manager, tenantId, location.point, 'lookup');
        return quantitySnapshot(config);
      },
    );

    const description = await this.directory.describeOne(tenantId, channel);

    const bound = await runSourceTransaction(this.dataSource, tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const config = await lockParameterConfig(manager, tenantId, parameterConfigId);
      assertParameterUnchanged(config, snapshot);
      await assertLivePoint(manager, tenantId, location.point, 'locked');
      const problems = await assessChannel(manager, tenantId, config, location.point, description);
      if (problems.length > 0) {
        throw new ChannelBindingRefusedError(problems);
      }
      const live = await liveChannelSourcesAt(manager, tenantId, parameterConfigId, location);
      const conflict = priorityConflict(live, channel, priority);
      if (conflict !== null) {
        throw conflict;
      }
      const source = await tenantManagerRepo(manager, WaterQualityParamEquipment, tenantId).save({
        tenantId,
        parameterConfigId,
        ...pointColumns(location.point),
        position: location.position,
        depthM: location.depthM,
        sensorId: channel.sensorId,
        channelKey: channel.channelKey,
        priority,
        isActive: true,
        monitoringFrequency: null,
        alertEnabled: null,
        boundBy: userId,
      });
      await auditSourceChange(this.auditLog, manager, {
        tenantId,
        userId,
        operation: 'bindParameterChannel',
        action: AuditAction.CREATE,
        before: null,
        after: source,
      });
      return source;
    });

    this.logger.log(
      JSON.stringify({ event: 'parameter_channel_bound', tenantId, sourceId: bound.id, priority }),
    );
    return bound;
  }
}
