/**
 * ReplaceParameterChannelHandler
 *
 * Swaps the channel of a live channel source in one transaction (a probe
 * exchanged, a channel re-wired): the old source is unbound and the new one
 * bound at the same parameter, place and priority, so the parameter is never
 * without a source and never has two primaries. The new channel passes the
 * same rule a bind does; the old one is not asked about — it may be gone,
 * which is often why it is being replaced.
 *
 * @module WaterQuality/Handlers
 */
import { runInTenantRead, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { ChannelBindingRefusedError } from '../../common/errors/farm-errors';
import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { ReplaceParameterChannelCommand } from '../commands/replace-parameter-channel.command';
import { WaterQualityParamEquipment } from '../entities/water-quality-param-equipment.entity';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import {
  assertParameterUnchanged,
  assessChannel,
  quantitySnapshot,
} from '../services/channel-binding-rules';
import { assertLivePoint } from '../services/measurement-point-lookup';
import { auditSourceChange } from '../services/parameter-source-audit';
import {
  findLiveChannelSource,
  liveChannelSourcesAt,
  locationOf,
  lockParameterConfig,
  pointColumns,
  unbindSources,
} from '../services/parameter-sources';
import { SensorChannelDirectory } from '../services/sensor-channel-directory.service';
import { runSourceTransaction } from '../services/source-transaction';

@Injectable()
@CommandHandler(ReplaceParameterChannelCommand)
export class ReplaceParameterChannelHandler
  implements ICommandHandler<ReplaceParameterChannelCommand, WaterQualityParamEquipment>
{
  private readonly logger = new Logger(ReplaceParameterChannelHandler.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly directory: SensorChannelDirectory,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(command: ReplaceParameterChannelCommand): Promise<WaterQualityParamEquipment> {
    const { tenantId, sourceId, channel, userId } = command;

    const seen = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const source = await findLiveChannelSource(queryRunner.manager, tenantId, sourceId);
      if (source.sensorId === channel.sensorId && source.channelKey === channel.channelKey) {
        throw new BadRequestException('The source already reads this channel');
      }
      const config = await tenantManagerRepo(
        queryRunner.manager,
        WaterQualityParameterConfig,
        tenantId,
      ).findOneOrFail({ where: { id: source.parameterConfigId } });
      return { parameterConfigId: source.parameterConfigId, snapshot: quantitySnapshot(config) };
    });

    const description = await this.directory.describeOne(tenantId, channel);

    const replacement = await runSourceTransaction(
      this.dataSource,
      tenantId,
      async (queryRunner) => {
        const manager = queryRunner.manager;
        const config = await lockParameterConfig(manager, tenantId, seen.parameterConfigId);
        assertParameterUnchanged(config, seen.snapshot);
        const found = await findLiveChannelSource(manager, tenantId, sourceId);
        const location = locationOf(found);
        // One lock order everywhere: parameter, then point, then source rows —
        // the order a point delete takes too (point, then sources).
        await assertLivePoint(manager, tenantId, location.point, 'locked');
        const live = await liveChannelSourcesAt(manager, tenantId, config.id, location);
        const old = live.find((candidate) => candidate.id === sourceId);
        if (old === undefined) {
          throw new ConflictException('The source was unbound meanwhile; nothing was replaced');
        }
        if (
          live.some(
            (candidate) =>
              candidate.sensorId === channel.sensorId &&
              candidate.channelKey === channel.channelKey,
          )
        ) {
          throw new ConflictException('This channel is already a source of the parameter here');
        }
        const problems = await assessChannel(
          manager,
          tenantId,
          config,
          location.point,
          description,
        );
        if (problems.length > 0) {
          throw new ChannelBindingRefusedError(problems);
        }
        await unbindSources(manager, tenantId, [old.id], userId);
        const created = await tenantManagerRepo(manager, WaterQualityParamEquipment, tenantId).save(
          {
            tenantId,
            parameterConfigId: config.id,
            ...pointColumns(location.point),
            position: location.position,
            depthM: location.depthM,
            sensorId: channel.sensorId,
            channelKey: channel.channelKey,
            priority: old.priority,
            isActive: true,
            monitoringFrequency: null,
            alertEnabled: null,
            boundBy: userId,
          },
        );
        await auditSourceChange(this.auditLog, manager, {
          tenantId,
          userId,
          operation: 'replaceParameterChannel',
          action: AuditAction.CREATE,
          before: old,
          after: created,
        });
        return created;
      },
    );

    this.logger.log(
      JSON.stringify({
        event: 'parameter_channel_replaced',
        tenantId,
        replacedSourceId: sourceId,
        sourceId: replacement.id,
      }),
    );
    return replacement;
  }
}
