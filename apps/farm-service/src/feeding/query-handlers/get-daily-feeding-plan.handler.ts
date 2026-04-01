/**
 * GetDailyFeedingPlanHandler
 *
 * Handles GetDailyFeedingPlanQuery and returns the daily feeding plan
 * for a given site. Aggregates data from active feeding programs,
 * their tank assignments, and today's execution records.
 *
 * @module Feeding/QueryHandlers
 */
import { Injectable, NotFoundException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import {
  GetDailyFeedingPlanQuery,
  DailyFeedingPlanResult,
  TankFeedingPlan,
} from '../queries/get-daily-feeding-plan.query';
import { FeedingProgram } from '../entities/feeding-program.entity';
import { FeedingProgramTank } from '../entities/feeding-program-tank.entity';
import { DailyFeedingExecution } from '../entities/daily-feeding-execution.entity';
import { Site } from '../../farm/entities/site.entity';

/**
 * Query handler for daily feeding plans.
 * Fetches active feeding programs for a site, calculates planned amounts
 * per tank, and compares with actual execution data for the given date.
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
   * Returns planned vs actual feeding data for all tanks at the given site.
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
      where: { tenantId, siteId, isActive: true },
      relations: ['feed'],
    });

    // Get program tank assignments
    const programIds = programs.map((p) => p.id);
    let programTanks: FeedingProgramTank[] = [];
    if (programIds.length > 0) {
      programTanks = await this.programTankRepository
        .createQueryBuilder('pt')
        .leftJoinAndSelect('pt.tank', 'tank')
        .leftJoinAndSelect('pt.batch', 'batch')
        .leftJoinAndSelect('batch.species', 'species')
        .where('pt.tenantId = :tenantId', { tenantId })
        .andWhere('pt.feedingProgramId IN (:...programIds)', { programIds })
        .andWhere('pt.isActive = true')
        .getMany();
    }

    // Get today's executions
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    let executions: DailyFeedingExecution[] = [];
    if (programIds.length > 0) {
      executions = await this.executionRepository.find({
        where: {
          tenantId,
          feedingDate: Between(startOfDay, endOfDay),
        },
      });
    }

    // Build tank plans with planned vs actual
    const tankPlans: TankFeedingPlan[] = [];
    let totalPlannedKg = 0;
    let totalActualKg = 0;

    for (const pt of programTanks) {
      const program = programs.find((p) => p.id === pt.feedingProgramId);
      if (!program) continue;

      const tankExecutions = executions.filter(
        (e) => e.tankId === pt.tankId && e.feedingProgramId === pt.feedingProgramId,
      );

      const plannedKg = pt.dailyAmountKg ?? 0;
      const actualKg = tankExecutions.reduce(
        (sum, e) => sum + (e.actualAmountKg ?? 0),
        0,
      );
      const completedMeals = tankExecutions.filter((e) => e.isCompleted).length;

      tankPlans.push({
        tankId: pt.tankId,
        tankCode: pt.tank?.code ?? '',
        tankName: pt.tank?.name ?? '',
        batchId: pt.batchId ?? '',
        batchNumber: pt.batch?.batchNumber ?? '',
        speciesName: pt.batch?.species?.commonName ?? '',
        currentQuantity: pt.batch?.currentQuantity ?? 0,
        avgWeightG: pt.batch?.avgWeight ?? 0,
        biomassKg: pt.batch?.biomassKg ?? 0,
        feedId: program.feedId ?? '',
        feedName: program.feed?.name ?? '',
        plannedAmountKg: plannedKg,
        feedingRatePercent: program.feedingRatePercent ?? 0,
        mealsPerDay: program.mealsPerDay ?? 0,
        amountPerMealKg: program.mealsPerDay ? plannedKg / program.mealsPerDay : 0,
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
