/**
 * GetDailyFeedingPlanHandler
 *
 * Handles GetDailyFeedingPlanQuery and returns the daily feeding plan
 * for a given site. Aggregates data from active feeding programs,
 * their tank assignments, and daily execution records.
 *
 * The returned shape MUST match the GraphQL DailyFeedingPlanResponse type:
 *   { date, siteId, plannedFeedings: PlannedFeeding[], totalPlannedKg, totalActualKg, completionPercent }
 *
 * @module Feeding/QueryHandlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import {
  GetDailyFeedingPlanQuery,
  DailyFeedingPlanResult,
} from '../queries/get-daily-feeding-plan.query';
import { FeedingProgram, FeedingProgramStatus } from '../entities/feeding-program.entity';
import { FeedingProgramTank } from '../entities/feeding-program-tank.entity';
import { DailyFeedingExecution } from '../entities/daily-feeding-execution.entity';
import { Site } from '../../site/entities/site.entity';

/**
 * Query handler for daily feeding plans.
 * Fetches active feeding programs for a site, calculates planned amounts
 * per equipment (tank/pond/cage), and compares with actual execution data.
 * Returns data in the shape expected by the DailyFeedingPlanResponse GraphQL type.
 */
@Injectable()
@QueryHandler(GetDailyFeedingPlanQuery)
export class GetDailyFeedingPlanHandler
  implements IQueryHandler<GetDailyFeedingPlanQuery, DailyFeedingPlanResult>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Execute the daily feeding plan query.
   *
   * Collects active feeding programs for the site, loads their tank/equipment
   * assignments, fetches execution records for the target date, and maps
   * everything into PlannedFeeding objects that match the GraphQL schema.
   *
   * @param query - Contains tenantId, siteId, date, and optional departmentId
   * @returns DailyFeedingPlanResult with plannedFeedings array (never null)
   */
  async execute(query: GetDailyFeedingPlanQuery): Promise<DailyFeedingPlanResult> {
    const { tenantId, siteId, date } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Validate site exists
      const site = await queryRunner.manager.findOne(Site, {
        where: { id: siteId, tenantId },
      });
      if (!site) {
        throw new NotFoundException(`Site ${siteId} not found`);
      }

      // Get active feeding programs for this site
      const programs = await queryRunner.manager.find(FeedingProgram, {
        where: { tenantId, siteId, isDeleted: false },
      });
      // Compared against the enum MEMBER, not the string it happens to hold today.
      // The cast made the comparison unverifiable: re-case or re-value
      // FeedingProgramStatus.ACTIVE and this filter would silently match nothing,
      // which is the P-30 failure shape (a swallowed query returning an empty set).
      const activePrograms = programs.filter((p) => p.status === FeedingProgramStatus.ACTIVE);

      // Get program tank assignments
      const programIds = activePrograms.map((p) => p.id);
      let programTanks: FeedingProgramTank[] = [];
      if (programIds.length > 0) {
        programTanks = await queryRunner.manager
          .createQueryBuilder(FeedingProgramTank, 'pt')
          .where('pt.tenantId = :tenantId', { tenantId })
          .andWhere('pt.feedingProgramId IN (:...programIds)', { programIds })
          .andWhere('pt.isActive = true')
          .getMany();
      }

      // Get today's executions (using executionDate column, type: date)
      const executionDate = new Date(date);
      executionDate.setHours(0, 0, 0, 0);
      const dateStr = executionDate.toISOString().split('T')[0];

      let executions: DailyFeedingExecution[] = [];
      if (programIds.length > 0) {
        executions = await queryRunner.manager
          .createQueryBuilder(DailyFeedingExecution, 'ex')
          .where('ex.tenantId = :tenantId', { tenantId })
          .andWhere('ex.feedingProgramId IN (:...programIds)', { programIds })
          .andWhere('ex.executionDate = :dateStr', { dateStr })
          .getMany();
      }

      // Build planned feedings matching GraphQL PlannedFeeding shape
      const plannedFeedings: DailyFeedingPlanResult['plannedFeedings'] = [];
      let totalPlannedKg = 0;
      let totalActualKg = 0;

      for (const pt of programTanks) {
        const program = activePrograms.find((p) => p.id === pt.feedingProgramId);
        if (!program) continue;

        // Find executions for this equipment
        const equipmentExecs = executions.filter(
          (e) => e.equipmentId === pt.equipmentId && e.feedingProgramId === pt.feedingProgramId,
        );

        // Sum planned and actual from execution JSONB fields
        const plannedKg = equipmentExecs.reduce(
          (sum, e) => sum + (e.calculations?.plannedFeedKg ?? 0),
          0,
        );
        const actualKg = equipmentExecs.reduce(
          (sum, e) => sum + (e.actualResults?.actualFeedGivenKg ?? 0),
          0,
        );
        const completedMeals = equipmentExecs.filter((e) => e.isCompleted()).length;
        const mealsPlanned = equipmentExecs.length;

        // Get current feed info from program tank or first feed assignment
        const firstAssignment = program.feedAssignments?.[0];
        const feedId = pt.currentFeedId ?? firstAssignment?.feedId ?? '';
        const feedName = pt.currentFeedCode ?? firstAssignment?.feedName ?? '';

        plannedFeedings.push({
          batchId: '',
          batchCode: '',
          tankId: pt.equipmentId,
          tankCode: pt.equipmentCode,
          feedId,
          feedName,
          plannedAmountKg: plannedKg,
          actualAmountKg: actualKg,
          mealsPlanned,
          mealsCompleted: completedMeals,
          isComplete: mealsPlanned > 0 && completedMeals >= mealsPlanned,
        });

        totalPlannedKg += plannedKg;
        totalActualKg += actualKg;
      }

      const completionPercent =
        totalPlannedKg > 0 ? Math.round((totalActualKg / totalPlannedKg) * 100) : 0;

      return {
        date,
        siteId,
        plannedFeedings,
        totalPlannedKg,
        totalActualKg,
        completionPercent,
      };
    });
  }
}
