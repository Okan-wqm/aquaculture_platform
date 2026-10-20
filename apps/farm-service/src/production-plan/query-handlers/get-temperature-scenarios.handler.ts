/**
 * GetTemperatureScenariosQuery handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { GetTemperatureScenariosQuery } from '../queries/get-temperature-scenarios.query';
import { TemperatureScenario } from '../entities/temperature-scenario.entity';
import { TemperatureScenarioPoint } from '../entities/temperature-scenario-point.entity';

@QueryHandler(GetTemperatureScenariosQuery)
export class GetTemperatureScenariosHandler implements IQueryHandler<GetTemperatureScenariosQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetTemperatureScenariosQuery) {
    const { tenantId, siteId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const scenarios = await queryRunner.manager.find(TemperatureScenario, {
        where: { tenantId, siteId, isDeleted: false },
        order: { createdAt: 'DESC' },
      });
      if (scenarios.length === 0) return [];

      const points = await queryRunner.manager.find(TemperatureScenarioPoint, {
        where: { tenantId },
        order: { date: 'ASC' },
      });
      const byScenario = new Map<string, { date: string; celsius: number }[]>();
      for (const point of points) {
        const list = byScenario.get(point.scenarioId) ?? [];
        list.push({ date: point.date, celsius: point.celsius });
        byScenario.set(point.scenarioId, list);
      }

      return scenarios.map((scenario) => ({
        id: scenario.id,
        siteId: scenario.siteId,
        name: scenario.name,
        source: scenario.source,
        points: byScenario.get(scenario.id) ?? [],
        createdAt: scenario.createdAt,
      }));
    });
  }
}
