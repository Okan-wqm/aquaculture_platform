/**
 * Öğün yürütme GraphQL yüzeyi (Faz 5).
 *
 * Authz (plan NFR): `feedingDayPlans` okuması üç rol (MODULE_USER site-filtreli
 * — atanmadığı sitenin planını GÖREMEZ); `recordMealFeeding`/`skipMeal` üç rol
 * AMA yazma tx'i İÇİNDE `resolveTankSiteId` + `assertSiteAssignment`
 * fail-closed koşar (SEC-HIGH-051 — rol kapısı UX, site kapısı güvenlik).
 *
 * Bu resolver CQRS bus'ı ATLAMAZ-ihlal etmez: mutasyonlar tek yazma servisi
 * `MealExecutionService`'e (Controller → Service deseni; feeding-program
 * resolver emsali), okuma `runInTenantRead` sorgusuna gider.
 *
 * @module FeedingProtocol/Resolvers
 */
import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import {
  Roles,
  Role,
  CurrentTenant,
  CurrentUser,
  roleHasPermission,
} from '@aquaculture/backend-common/decorators';
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { mobileCommandEnvelopeFromInput } from '@aquaculture/backend-common/mobile-command';

import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { FeedingDayPlan } from '../entities/feeding-day-plan.entity';
import { FeedingMeal } from '../entities/feeding-meal.entity';
import { MealExecutionService } from '../services/meal-execution.service';
import { MealFeedingResultView } from '../dto/meal-execution.results';
import {
  CorrectMealPourInput,
  RecordMealFeedingInput,
  SkipMealInput,
} from '../dto/meal-execution.inputs';

interface CallerClaims {
  sub: string;
  roles: Role[];
  assignedSiteIds?: string[];
}

@UseGuards(GqlAuthGuard)
@Resolver(() => FeedingDayPlan)
export class MealExecutionResolver {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly mealExecutionService: MealExecutionService,
  ) {}

  /**
   * Gün planları + öğünleri (MealBoard/mobil kaynağı). Öğünler TEK toplu
   * sorguyla yüklenir (plan başına sorgu YOK); MODULE_USER yalnız atandığı
   * sitelerin planlarını görür (site-filtre fail-closed: ataması boşsa boş liste).
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [FeedingDayPlan], { name: 'feedingDayPlans' })
  async feedingDayPlans(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: CallerClaims,
    @Args('planDate') planDate: string,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
  ): Promise<FeedingDayPlan[]> {
    const isManagerOrHigher = user.roles.some((role) =>
      roleHasPermission(role, Role.MODULE_MANAGER),
    );
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(FeedingDayPlan, 'plan')
        .where('plan.tenantId = :tenantId AND plan.planDate = :planDate', { tenantId, planDate });
      if (siteId) qb.andWhere('plan.siteId = :siteId', { siteId });
      if (!isManagerOrHigher) {
        const assigned = user.assignedSiteIds ?? [];
        if (assigned.length === 0) return []; // fail-closed: atanmamış kullanıcı hiçbir planı görmez
        qb.andWhere('plan.siteId IN (:...assigned)', { assigned });
      }
      qb.orderBy('plan.unitCode', 'ASC');
      const plans = await qb.getMany();
      if (plans.length === 0) return plans;

      const meals = await queryRunner.manager.find(FeedingMeal, {
        where: { tenantId, dayPlanId: In(plans.map((plan) => plan.id)) },
        order: { mealIndex: 'ASC' },
      });
      const mealsByPlan = new Map<string, FeedingMeal[]>();
      for (const meal of meals) {
        const bucket = mealsByPlan.get(meal.dayPlanId) ?? [];
        bucket.push(meal);
        mealsByPlan.set(meal.dayPlanId, bucket);
      }
      for (const plan of plans) plan.meals = mealsByPlan.get(plan.id) ?? [];
      return plans;
    });
  }

  /** Döküm kaydı (D-8) — zarf zorunlu (C-17), site yetkisi tx içinde fail-closed. */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => MealFeedingResultView)
  async recordMealFeeding(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: CallerClaims,
    @Args('input') input: RecordMealFeedingInput,
  ): Promise<MealFeedingResultView> {
    return this.mealExecutionService.recordMealFeeding({
      tenantId,
      userId: user.sub,
      caller: { sub: user.sub, roles: user.roles, assignedSiteIds: user.assignedSiteIds },
      mealId: input.mealId,
      pourKg: input.pourKg,
      finalize: input.finalize,
      feedingMethod: input.feedingMethod,
      notes: input.notes,
      envelope: mobileCommandEnvelopeFromInput(input),
    });
  }

  /** Döküm düzeltmesi (C-11) — MANAGER sınıfı işlem (regenerateDayPlan emsali). */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => MealFeedingResultView)
  async correctMealPour(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: CallerClaims,
    @Args('input') input: CorrectMealPourInput,
  ): Promise<MealFeedingResultView> {
    return this.mealExecutionService.correctMealPour({
      tenantId,
      userId: user.sub,
      caller: { sub: user.sub, roles: user.roles, assignedSiteIds: user.assignedSiteIds },
      mealId: input.mealId,
      pourIndex: input.pourIndex,
      correctedKg: input.correctedKg,
    });
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => MealFeedingResultView)
  async skipMeal(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: CallerClaims,
    @Args('input') input: SkipMealInput,
  ): Promise<MealFeedingResultView> {
    return this.mealExecutionService.skipMeal({
      tenantId,
      userId: user.sub,
      caller: { sub: user.sub, roles: user.roles, assignedSiteIds: user.assignedSiteIds },
      mealId: input.mealId,
      reason: input.reason,
    });
  }
}
