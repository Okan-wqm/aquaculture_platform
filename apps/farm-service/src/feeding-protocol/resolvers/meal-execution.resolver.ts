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
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  ResolveField,
  Parent,
  Float,
  Int,
} from '@nestjs/graphql';
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
import { FcrResolvedSource } from '../entities/feeding-protocol-v2.entity';
import { FeedingDayPlan } from '../entities/feeding-day-plan.entity';
import { FeedingMeal } from '../entities/feeding-meal.entity';
import { MealExecutionService } from '../services/meal-execution.service';
import { DayPlanAdminService } from '../services/day-plan-admin.service';
import { DayPlanAdminResultView, MealFeedingResultView } from '../dto/meal-execution.results';
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
    private readonly dayPlanAdminService: DayPlanAdminService,
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

  // ── P-25: snapshot'ın tipli alan alt kümesi ────────────────────────────────
  // Mobil istemci `snapshot` jsonb'sini TEL ÜZERİNDEN ÇEKMEZ (eski motorun opak
  // `calculations` blob'u anti-deseniydi): plan hesabının mobilde gereken
  // girdileri burada tipli skalerler olarak çözülür. Web MealBoard provenans
  // gösterimi için `snapshot`'ı okumaya devam eder — iki tüketici tek üretim
  // anı verisini okur, ikinci bir hesap yolu yoktur.

  @ResolveField(() => Float)
  avgWeightG(@Parent() plan: FeedingDayPlan): number {
    return plan.snapshot.avgWeightG;
  }

  @ResolveField(() => Int)
  fishCount(@Parent() plan: FeedingDayPlan): number {
    return plan.snapshot.fishCount;
  }

  @ResolveField(() => Float)
  biomassKg(@Parent() plan: FeedingDayPlan): number {
    return plan.snapshot.biomassKg;
  }

  @ResolveField(() => Float, { nullable: true })
  waterTempC(@Parent() plan: FeedingDayPlan): number | null {
    return plan.snapshot.waterTempC;
  }

  @ResolveField(() => String)
  temperatureSource(@Parent() plan: FeedingDayPlan): string {
    return plan.snapshot.temperatureSource;
  }

  @ResolveField(() => Boolean)
  usingDefaultTemperature(@Parent() plan: FeedingDayPlan): boolean {
    return plan.snapshot.usingDefaultTemperature;
  }

  @ResolveField(() => ID)
  feedId(@Parent() plan: FeedingDayPlan): string {
    return plan.snapshot.feed.id;
  }

  @ResolveField(() => String)
  feedCode(@Parent() plan: FeedingDayPlan): string {
    return plan.snapshot.feed.code;
  }

  @ResolveField(() => String)
  feedName(@Parent() plan: FeedingDayPlan): string {
    return plan.snapshot.feed.name;
  }

  @ResolveField(() => Float)
  effectiveRatePercent(@Parent() plan: FeedingDayPlan): number {
    return plan.snapshot.effectiveRatePercent;
  }

  @ResolveField(() => Float)
  expectedFcr(@Parent() plan: FeedingDayPlan): number {
    return plan.snapshot.expectedFcr;
  }

  @ResolveField(() => FcrResolvedSource)
  fcrResolvedSource(@Parent() plan: FeedingDayPlan): FcrResolvedSource {
    return plan.snapshot.fcrResolvedSource;
  }

  /**
   * D-2 rozeti: tankta birden fazla üretim batch'i var. Bandı ETKİLEMEZ — band
   * tank geneli adet-ağırlıklı ortalamadan çözülür; bu alan yalnız
   * görünürlüktür (B3 öncesi snapshot'ta false).
   */
  @ResolveField(() => Boolean)
  mixedBatch(@Parent() plan: FeedingDayPlan): boolean {
    return plan.snapshot.mixedBatch ?? false;
  }

  /** D-2 uyarısı: batch'ler arası ağırlık dağılımı CV'si (%); tekil tankta null. */
  @ResolveField(() => Float, { nullable: true })
  weightCvPercent(@Parent() plan: FeedingDayPlan): number | null {
    return plan.snapshot.weightCvPercent ?? null;
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

  /**
   * K-9: planı güncel durumdan yeniden üret (MANAGER+). Aktif plan varsa
   * 'manual_regenerate' gerekçeli recalc; bugün plan yoksa şimdi üretim.
   * FE tetikleyicisi Faz 6 (MealBoard).
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => DayPlanAdminResultView)
  async regenerateDayPlan(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: CallerClaims,
    @Args('unitId', { type: () => ID }) unitId: string,
  ): Promise<DayPlanAdminResultView> {
    return this.dayPlanAdminService.regenerateDayPlan(tenantId, user.sub, unitId);
  }

  /**
   * K-9: manuel yem geçişi (MANAGER+) — atama currentFeed/band + kalan
   * öğünler + FeedTypeTransitioned(automatic:false). Hedef yem protokol
   * bandlarından biri olmak zorundadır (fail-closed).
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => DayPlanAdminResultView)
  async transitionUnitFeed(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: CallerClaims,
    @Args('unitId', { type: () => ID }) unitId: string,
    @Args('toFeedId', { type: () => ID }) toFeedId: string,
  ): Promise<DayPlanAdminResultView> {
    return this.dayPlanAdminService.transitionUnitFeed(tenantId, user.sub, unitId, toFeedId);
  }
}
