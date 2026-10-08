/**
 * GetUnitMeasurementPlanHandler
 *
 * The entry forms (farm RecordTab, BulkRecordTab, AquaMobil) ask here what to
 * show for a unit; the answer is measurementPlan(), the rule the validator
 * applies to the same unit, so a form never asks for less or more than the
 * server requires.
 *
 * @module WaterQuality/QueryHandlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IQueryHandler, QueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { UnitMeasurementPlan } from '../dto/unit-measurement-plan.response';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { GetUnitMeasurementPlanQuery } from '../queries/get-unit-measurement-plan.query';
import { mappedCodesForUnit, measurementPlan } from '../services/measurement-plan';

@Injectable()
@QueryHandler(GetUnitMeasurementPlanQuery)
export class GetUnitMeasurementPlanHandler
  implements IQueryHandler<GetUnitMeasurementPlanQuery, UnitMeasurementPlan>
{
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(query: GetUnitMeasurementPlanQuery): Promise<UnitMeasurementPlan> {
    const { tenantId, unitId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const configs = await queryRunner.manager.find(WaterQualityParameterConfig, {
        where: { tenantId, isActive: true },
        order: { displayOrder: 'ASC' },
      });
      const plan = measurementPlan(
        configs,
        await mappedCodesForUnit(queryRunner.manager, tenantId, unitId),
      );
      return {
        planned: plan.planned,
        entries: plan.entries.map(({ config, required }) => ({ parameter: config, required })),
      };
    });
  }
}
