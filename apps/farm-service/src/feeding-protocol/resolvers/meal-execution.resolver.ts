/**
 * Öğün yürütme GraphQL yüzeyi (Faz 5).
 *
 * Authz (plan NFR): `feedingDayPlans` okuması üç rol (MODULE_USER site-filtreli
 * — atanmadığı sitenin planını GÖREMEZ); `recordMealFeeding`/`skipMeal` üç rol
 * AMA yazma tx'i İÇİNDE `resolveTankSiteId` + `assertSiteAssignment`
 * fail-closed koşar (SEC-HIGH-051 — rol kapısı UX, site kapısı güvenlik).
 *
 * Mutasyonlar closed `FEEDING_OPERATION_COMMAND_PORT` sözleşmesine doğrudan
 * gider; resolver'a domain manager veya ikinci bir command facade verilmez.
 * Okuma `runInTenantRead` sorgusuna gider.
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
import { Inject, UseGuards } from '@nestjs/common';
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
import {
  FEEDING_OPERATION_COMMAND_PORT,
  type FeedingOperationCommandPort,
} from '../feeding-operation-command.port';
import { DayPlanAdminResultView, MealFeedingResultView } from '../dto/meal-execution.results';
import {
  CorrectMealPourInput,
  FinalizeMealInput,
  RecordMealFeedingInput,
  SkipMealInput,
} from '../dto/meal-execution.inputs';

interface CallerClaims {
  sub: string;
  roles: Role[];
  assignedSiteIds?: string[];
}

type MealExecutionCommandPort = Pick<
  FeedingOperationCommandPort,
  | 'recordMeal'
  | 'correctMeal'
  | 'finalizeMeal'
  | 'skipMeal'
  | 'regenerateDayPlan'
  | 'transitionFeed'
>;

@UseGuards(GqlAuthGuard)
@Resolver(() => FeedingDayPlan)
export class MealExecutionResolver {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(FEEDING_OPERATION_COMMAND_PORT)
    private readonly operationPort: MealExecutionCommandPort,
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
    return plan.resolution.waterTempC;
  }

  @ResolveField(() => String)
  temperatureSource(@Parent() plan: FeedingDayPlan): string {
    return plan.resolution.temperatureSource;
  }

  @ResolveField(() => Boolean)
  usingDefaultTemperature(@Parent() plan: FeedingDayPlan): boolean {
    return plan.resolution.temperatureSource === 'none';
  }

  @ResolveField(() => ID)
  feedId(@Parent() plan: FeedingDayPlan): string {
    return plan.resolution.feed.id;
  }

  @ResolveField(() => String)
  feedCode(@Parent() plan: FeedingDayPlan): string {
    return plan.resolution.feed.code;
  }

  @ResolveField(() => String)
  feedName(@Parent() plan: FeedingDayPlan): string {
    return plan.resolution.feed.name;
  }

  @ResolveField(() => Float)
  effectiveRatePercent(@Parent() plan: FeedingDayPlan): number {
    return plan.resolution.effectiveRatePercent;
  }

  @ResolveField(() => Float)
  expectedFcr(@Parent() plan: FeedingDayPlan): number {
    return plan.resolution.expectedFcr;
  }

  @ResolveField(() => FcrResolvedSource)
  fcrResolvedSource(@Parent() plan: FeedingDayPlan): FcrResolvedSource {
    return plan.resolution.fcrResolvedSource;
  }

  /** D-2 rozeti: tank karışık; band tankın adet-ağırlıklı ortalama ağırlığından seçildi. */
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
    const envelope = mobileCommandEnvelopeFromInput(input);
    return this.operationPort.recordMeal({
      tenantId,
      actorId: user.sub,
      requestId: envelope.clientCommandId,
      caller: { sub: user.sub, roles: user.roles, assignedSiteIds: user.assignedSiteIds },
      mealId: input.mealId,
      pourKg: input.pourKg,
      finalize: input.finalize,
      feedingMethod: input.feedingMethod,
      notes: input.notes,
      envelope,
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
    return this.operationPort.correctMeal({
      tenantId,
      actorId: user.sub,
      requestId: input.operationRequestId,
      caller: { sub: user.sub, roles: user.roles, assignedSiteIds: user.assignedSiteIds },
      mealId: input.mealId,
      pourIndex: input.pourIndex,
      correctedKg: input.correctedKg,
    });
  }

  /** Close an existing partial meal without creating a synthetic pour. */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => MealFeedingResultView)
  async finalizeMeal(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: CallerClaims,
    @Args('input') input: FinalizeMealInput,
  ): Promise<MealFeedingResultView> {
    return this.operationPort.finalizeMeal({
      tenantId,
      actorId: user.sub,
      requestId: input.operationRequestId,
      caller: { sub: user.sub, roles: user.roles, assignedSiteIds: user.assignedSiteIds },
      mealId: input.mealId,
    });
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => MealFeedingResultView)
  async skipMeal(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: CallerClaims,
    @Args('input') input: SkipMealInput,
  ): Promise<MealFeedingResultView> {
    return this.operationPort.skipMeal({
      tenantId,
      actorId: user.sub,
      requestId: input.operationRequestId,
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
    @Args('operationRequestId', { type: () => ID }) operationRequestId: string,
  ): Promise<DayPlanAdminResultView> {
    return this.operationPort.regenerateDayPlan({
      tenantId,
      actorId: user.sub,
      unitId,
      requestId: operationRequestId,
    });
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
    @Args('operationRequestId', { type: () => ID }) operationRequestId: string,
  ): Promise<DayPlanAdminResultView> {
    return this.operationPort.transitionFeed({
      tenantId,
      actorId: user.sub,
      unitId,
      toFeedId,
      requestId: operationRequestId,
    });
  }
}
