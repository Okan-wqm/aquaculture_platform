/**
 * Read side of the parameter channel binding (FARM-HIGH-373).
 *
 * Problems are computed at read time with the bind's own rule (plan D12):
 * a channel disabled, re-declared, moved or deleted after it was bound shows
 * up here as the code the bind would refuse it with, and PR-4's reading
 * resolver skips such a source. The sensor service is asked outside any
 * database connection; when it cannot answer the read is a 503, never a guess.
 *
 * @module WaterQuality/QueryHandlers
 */
import { runInTenantRead, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IQueryHandler, QueryHandler } from '@platform/cqrs';
import type { SensorChannelDescription } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import {
  boundChannelStatus,
  type ChannelBindingCheck,
  type ParameterSourceStatus,
} from '../dto/parameter-source-status.response';
import { ParameterQuantityDeclaration } from '../entities/parameter-quantity-declaration.entity';
import { WaterQualityParamEquipment } from '../entities/water-quality-param-equipment.entity';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import {
  CheckParameterChannelBindingQuery,
  ListParameterQuantityDeclarationsQuery,
  ListParameterSourcesAtPointQuery,
} from '../queries/parameter-source-queries';
import { assessChannel, bindingProblems } from '../services/channel-binding-rules';
import { loadFarmPlacement } from '../services/channel-placement';
import { assertLivePoint } from '../services/measurement-point-lookup';
import { liveAtPoint, pointOf } from '../services/parameter-sources';
import { SensorChannelDirectory } from '../services/sensor-channel-directory.service';

@Injectable()
@QueryHandler(CheckParameterChannelBindingQuery)
export class CheckParameterChannelBindingHandler
  implements IQueryHandler<CheckParameterChannelBindingQuery, ChannelBindingCheck>
{
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly directory: SensorChannelDirectory,
  ) {}

  async execute(query: CheckParameterChannelBindingQuery): Promise<ChannelBindingCheck> {
    const { tenantId, target } = query;
    const config = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const found = await tenantManagerRepo(
        queryRunner.manager,
        WaterQualityParameterConfig,
        tenantId,
      ).findOne({ where: { id: target.parameterConfigId, isActive: true } });
      if (found === null) {
        throw new NotFoundException(
          `No active parameter '${target.parameterConfigId}' in this tenant`,
        );
      }
      await assertLivePoint(queryRunner.manager, tenantId, target.location.point, 'lookup');
      return found;
    });
    const description = await this.directory.describeOne(tenantId, target.channel);
    const problems = await runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
      assessChannel(queryRunner.manager, tenantId, config, target.location.point, description),
    );
    return { channel: boundChannelStatus(description), problems };
  }
}

@Injectable()
@QueryHandler(ListParameterSourcesAtPointQuery)
export class ListParameterSourcesAtPointHandler
  implements IQueryHandler<ListParameterSourcesAtPointQuery, ParameterSourceStatus[]>
{
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly directory: SensorChannelDirectory,
  ) {}

  async execute(query: ListParameterSourcesAtPointQuery): Promise<ParameterSourceStatus[]> {
    const { tenantId, point } = query;
    const sources = await runInTenantRead(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner) => {
        await assertLivePoint(queryRunner.manager, tenantId, point, 'lookup');
        return tenantManagerRepo(queryRunner.manager, WaterQualityParamEquipment, tenantId).find({
          where: liveAtPoint(point),
          relations: ['parameterConfig'],
          order: { parameterConfigId: 'ASC', position: 'ASC', priority: 'ASC', boundAt: 'ASC' },
        });
      },
    );
    const channels = sources.filter(
      (source): source is WaterQualityParamEquipment & { sensorId: string; channelKey: string } =>
        source.sensorId !== null && source.channelKey !== null,
    );
    const described = await this.directory.describe(
      tenantId,
      channels.map(({ sensorId, channelKey }) => ({ sensorId, channelKey })),
    );
    const farm = await runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
      loadFarmPlacement(queryRunner.manager, tenantId, described),
    );
    // The directory answers one description per key, in order.
    const byId = new Map<string, SensorChannelDescription>();
    channels.forEach((source, index) => {
      const description = described[index];
      if (description !== undefined) byId.set(source.id, description);
    });
    return sources.map((source) => {
      const description = byId.get(source.id);
      if (description === undefined) {
        // A manual source: nothing to describe.
        return { source, channel: null, problems: [] };
      }
      return {
        source,
        channel: boundChannelStatus(description),
        problems: bindingProblems(source.parameterConfig, pointOf(source), description, farm),
      };
    });
  }
}

@Injectable()
@QueryHandler(ListParameterQuantityDeclarationsQuery)
export class ListParameterQuantityDeclarationsHandler
  implements IQueryHandler<ListParameterQuantityDeclarationsQuery, ParameterQuantityDeclaration[]>
{
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(
    query: ListParameterQuantityDeclarationsQuery,
  ): Promise<ParameterQuantityDeclaration[]> {
    const { tenantId, parameterConfigId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
      tenantManagerRepo(queryRunner.manager, ParameterQuantityDeclaration, tenantId).find({
        where: { parameterConfigId },
        order: { declaredAt: 'DESC' },
      }),
    );
  }
}
