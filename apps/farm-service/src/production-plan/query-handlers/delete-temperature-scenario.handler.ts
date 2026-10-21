/**
 * DeleteTemperatureScenarioQuery handler — soft delete (isDeleted), points
 * stay for audit and the interpolation simply stops offering the scenario.
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { DeleteTemperatureScenarioQuery } from '../queries/delete-temperature-scenario.query';
import { TemperatureScenario } from '../entities/temperature-scenario.entity';

@QueryHandler(DeleteTemperatureScenarioQuery)
export class DeleteTemperatureScenarioHandler
  implements IQueryHandler<DeleteTemperatureScenarioQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: DeleteTemperatureScenarioQuery) {
    const { tenantId, scenarioId } = query;
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const scenario = await queryRunner.manager.findOne(TemperatureScenario, {
        where: { id: scenarioId, tenantId },
      });
      if (!scenario || scenario.isDeleted) {
        throw new NotFoundException(`Sıcaklık senaryosu ${scenarioId} bulunamadı`);
      }
      scenario.isDeleted = true;
      scenario.deletedAt = new Date();
      await queryRunner.manager.save(TemperatureScenario, scenario);
      return true;
    });
  }
}
