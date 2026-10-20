/**
 * CreateTemperatureScenarioQuery handler — fail-closed tenant boundary.
 * Validates that points are dated, ≥2, and strictly increasing by date (the
 * interpolation contract), then writes the scenario and its points in one
 * transaction.
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { CreateTemperatureScenarioQuery } from '../queries/create-temperature-scenario.query';
import {
  TemperatureScenario,
  TemperatureScenarioSource,
} from '../entities/temperature-scenario.entity';
import { TemperatureScenarioPoint } from '../entities/temperature-scenario-point.entity';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

@QueryHandler(CreateTemperatureScenarioQuery)
export class CreateTemperatureScenarioHandler
  implements IQueryHandler<CreateTemperatureScenarioQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: CreateTemperatureScenarioQuery) {
    const { tenantId, siteId, name, points, userId } = query;

    if (!name.trim()) throw new BadRequestException('Senaryo adı zorunlu');
    if (points.length < 2) {
      throw new BadRequestException('Sıcaklık senaryosu en az 2 tarihli nokta gerektirir');
    }
    const seen = new Set<string>();
    for (const point of points) {
      if (!DATE_RE.test(point.date)) {
        throw new BadRequestException(`Geçersiz tarih: ${point.date} (YYYY-MM-DD bekleniyor)`);
      }
      if (!Number.isFinite(point.celsius) || point.celsius < -5 || point.celsius > 45) {
        throw new BadRequestException(`Geçersiz sıcaklık: ${point.celsius} °C (-5..45)`);
      }
      if (seen.has(point.date)) {
        throw new BadRequestException(`Aynı tarih iki kez girildi: ${point.date}`);
      }
      seen.add(point.date);
    }
    const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const scenario = await queryRunner.manager.save(TemperatureScenario, {
        tenantId,
        siteId,
        name: name.trim(),
        source: TemperatureScenarioSource.MANUAL,
        isDeleted: false,
        createdBy: userId,
      } as TemperatureScenario);

      await queryRunner.manager.save(
        TemperatureScenarioPoint,
        sorted.map((point) => ({
          tenantId,
          scenarioId: scenario.id,
          date: point.date,
          celsius: point.celsius,
        })) as TemperatureScenarioPoint[],
      );

      return {
        id: scenario.id,
        siteId: scenario.siteId,
        name: scenario.name,
        source: scenario.source,
        points: sorted,
        createdAt: scenario.createdAt,
      };
    });
  }
}
