/**
 * UnbindParameterChannelHandler
 *
 * Ends a channel source (FARM-HIGH-373). The row is unbound, not deleted, so
 * what fed the parameter at the point on a past date stays answerable. When
 * the primary ends, the backup at the same place is promoted in the same
 * transaction (plan Q9): the parameter keeps a source without a gap, and the
 * unique "one primary" index never sees two.
 *
 * Runs behind the parameter's lock like every write to its sources.
 *
 * @module WaterQuality/Handlers
 */
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { UnbindParameterChannelCommand } from '../commands/unbind-parameter-channel.command';
import type { ParameterChannelUnbinding } from '../dto/parameter-source-status.response';
import {
  ChannelSourcePriority,
  WaterQualityParamEquipment,
} from '../entities/water-quality-param-equipment.entity';
import { auditSourceChange } from '../services/parameter-source-audit';
import {
  findLiveChannelSource,
  liveChannelSourcesAt,
  locationOf,
  lockParameterConfig,
  unbindSources,
} from '../services/parameter-sources';
import { runSourceTransaction } from '../services/source-transaction';

@Injectable()
@CommandHandler(UnbindParameterChannelCommand)
export class UnbindParameterChannelHandler
  implements ICommandHandler<UnbindParameterChannelCommand, ParameterChannelUnbinding>
{
  private readonly logger = new Logger(UnbindParameterChannelHandler.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(command: UnbindParameterChannelCommand): Promise<ParameterChannelUnbinding> {
    const { tenantId, sourceId, userId } = command;

    const result = await runSourceTransaction(this.dataSource, tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const found = await findLiveChannelSource(manager, tenantId, sourceId);
      await lockParameterConfig(manager, tenantId, found.parameterConfigId);
      const live = await liveChannelSourcesAt(
        manager,
        tenantId,
        found.parameterConfigId,
        locationOf(found),
      );
      const source = live.find((candidate) => candidate.id === sourceId);
      if (source === undefined) {
        throw new NotFoundException(`No live parameter source '${sourceId}' in this tenant`);
      }
      await unbindSources(manager, tenantId, [source.id], userId);
      const sources = tenantManagerRepo(manager, WaterQualityParamEquipment, tenantId);
      const unbound = await sources.findOneOrFail({ where: { id: source.id } });
      await auditSourceChange(this.auditLog, manager, {
        tenantId,
        userId,
        operation: 'unbindParameterChannel',
        action: AuditAction.UPDATE,
        before: source,
        after: unbound,
      });

      const backup = live.find((candidate) => candidate.priority === ChannelSourcePriority.BACKUP);
      if (source.priority !== ChannelSourcePriority.PRIMARY || backup === undefined) {
        return { unbound, promoted: null };
      }
      const before = { ...backup };
      backup.priority = ChannelSourcePriority.PRIMARY;
      const promoted = await sources.save(backup);
      await auditSourceChange(this.auditLog, manager, {
        tenantId,
        userId,
        operation: 'promoteParameterChannel',
        action: AuditAction.UPDATE,
        before,
        after: promoted,
      });
      return { unbound, promoted };
    });

    this.logger.log(
      JSON.stringify({
        event: 'parameter_channel_unbound',
        tenantId,
        sourceId,
        promotedSourceId: result.promoted?.id ?? null,
      }),
    );
    return result;
  }
}
