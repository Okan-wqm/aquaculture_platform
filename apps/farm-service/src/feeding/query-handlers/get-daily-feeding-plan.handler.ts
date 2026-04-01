/**
 * GetDailyFeedingPlanHandler
 *
 * Handles GetDailyFeedingPlanQuery and returns the daily feeding plan
 * for a given site. Aggregates data from active feeding programs,
 * their tank assignments, and daily execution records.
 *
 * @module Feeding/QueryHandlers
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import {
  GetDailyFeedingPlanQuery,
  DailyFeedingPlanResult,
  TankFeedingPlan,
} from '../queries/get-daily-feeding-plan.query';
import { FeedingProgram } from '../entities/feeding-program.entity';
import { FeedingProgramTank } from '../entities/feeding-program-tank.entity';
import { DailyFeedingExecution } from '../entities/daily-feeding-execution.entity';
import { Site } from '../../site/entities/site.entity';

/**
 * Query handler for daily feeding plans.
 * Fetches active feeding programs for a site, calculates planned amounts
 * per equipment (tank/pond/cage), and compares with actual execution data.
 */
@Injectable()
@QueryHandler(GetDailyFeedingPlanQuery)
export class GetDailyFeedingPlanHandler
  implements IQueryHandler<GetDailyFeedingPlanQuery, DailyFeedingPlanResult>
{
  constructor(
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    @InjectRepository(FeedingProgram)
    private readonly programRepository: Repository<FeedingProgram>,
    @InjectRepository(FeedingProgramTank)
    private readonly programTankRepository: Repository<FeedingProgramTank>,
    @InjectRepository(DailyFeedingExecution)
    private readonly executionRepository: Repository<DailyFeedingExecution>,
  ) {}

  /**
   * Execute the daily feeding plan query.
   * Returns planned vs actual feeding data for all equipment at the given site.
   */
  async execute(query: GetDailyFeedingPlanQuery): Promise<DailyFeedingPlanResult> {
    const { tenantId, siteId, date } = query;

    // Validate site exists
    const site = await this.siteRepository.findOne({
      where: { id: siteId, tenantId },
    });
    if (!site) {
      throw new NotFoundException(`Site ${siteId} not found`);
    }

    // Get active feeding programs for this site
    const programs = await this.programRepository.find({
      where: { tenantId, siteId, isDeleted: false },
    });
    const activePrograms = programs.filter((p) => p.status === ('active' as never));

    // Get program tank assignments
    const programIds = activePrograms.map((p) => p.id);
    let programTanks: FeedingProgramTank[] = [];
    if (programIds.length > 0) {
      programTanks = await this.programTankRepository
        .createQueryBuilder('pt')
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
      executions = await this.executionRepository
        .createQueryBuilder('ex')
        .where('ex.tenantId = :tenantId', { tenantId })
        .andWhere('ex.feedingProgramId IN (:...programIds)', { programIds })
        .andWhere('ex.executionDate = :dateStr', { dateStr })
        .getMany();
    }

    // Build tank plans with planned vs actual from execution JSONB data
    const tankPlans: TankFeedingPlan[] = [];
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

      // Get current feed info from program tank or first feed assignment
      const firstAssignment = program.feedAssignments?.[0];
      const feedId = pt.currentFeedId ?? firstAssignment?.feedId ?? '';
      const feedName = pt.currentFeedCode ?? firstAssignment?.feedName ?? '';

      // Get fish/weight info from the latest execution calculations
      const latestCalc = equipmentExecs.length > 0
        ? equipmentExecs[equipmentExecs.length - 1]?.calculations
        : undefined;

      tankPlans.push({
        tankId: pt.equipmentId,
        tankCode: pt.equipmentCode,
        tankName: pt.equipmentName,
        batchId: '',
        batchNumber: '',
        speciesName: '',
        currentQuantity: latestCalc?.fishCount ?? 0,
        avgWeightG: latestCalc?.avgWeightG ?? 0,
        biomassKg: latestCalc?.biomassKg ?? 0,
        feedId,
        feedName,
        plannedAmountKg: plannedKg,
        feedingRatePercent: latestCalc?.feedingRatePercent ?? 0,
        mealsPerDay: equipmentExecs.length,
        amountPerMealKg: equipmentExecs.length > 0 ? plannedKg / equipmentExecs.length : 0,
        completedMeals,
        actualAmountTodayKg: actualKg,
        remainingAmountKg: Math.max(0, plannedKg - actualKg),
      });

      totalPlannedKg += plannedKg;
      totalActualKg += actualKg;
    }

    const completionPercent =
      totalPlannedKg > 0 ? Math.round((totalActualKg / totalPlannedKg) * 100) : 0;

    return {
      date,
      siteId,
      siteName: site.name,
      totalPlannedKg,
      totalActualKg,
      totalVarianceKg: totalActualKg - totalPlannedKg,
      variancePercent:
        totalPlannedKg > 0
          ? Math.round(((totalActualKg - totalPlannedKg) / totalPlannedKg) * 100)
          : 0,
      completionPercent,
      tankPlans,
    };
  }
}
