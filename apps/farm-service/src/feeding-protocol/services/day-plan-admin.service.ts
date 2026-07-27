/**
 * DayPlanAdminService — operatör (MANAGER+) plan yönetim aksiyonları (K-9).
 *
 *  - `regenerateDayPlan(unitId)`: ünitenin bugünkü planını güncel durumdan
 *    yeniden hesaplar. Aktif plan varsa recalc ('manual_regenerate' gerekçesi —
 *    beslenmiş/kapanmış öğünler korunur, kalanlar yeniden fiyatlanır); bugün
 *    hiç plan üretilmemişse (örn. atama 06:00'dan sonra aktive edildi) planı
 *    ŞİMDİ üretir — 06:00 üreticisiyle aynı computeDayPlan/persistDayPlan yolu.
 *  - `transitionUnitFeed(unitId, toFeedId)`: manuel yem geçişi — atamanın
 *    currentFeed/band durumu + bugünkü kalan öğünlerin feedId'si güncellenir,
 *    `FeedTypeTransitioned(automatic:false)` outbox'a yazılır. Hedef yem,
 *    protokolün band yemlerinden biri OLMAK ZORUNDADIR (bant dışı serbest yem
 *    protokol sözleşmesini kırar — fail-closed). Sonraki otomatik geçişler
 *    histerezisi bu banda göre değerlendirir (manuel seçim anında ezilmez).
 *
 * Kilit disiplini (K-1): DayPlan → Meals → Assignment sırası —
 * DayPlanRecalcService ile birebir; storage'a hiç dokunulmaz.
 * FE tetikleyicileri Faz 6 (MealBoard "planı yeniden üret", AssignmentsTab
 * "manuel geçiş") — Faz 5 yalnız servis + mutation yüzeyi.
 *
 * @module FeedingProtocol/Services
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent, FeedTypeTransitionedEvent } from '@platform/event-contracts';

import { FeedingProtocolV2, FeedingProtocolStatus } from '../entities/feeding-protocol-v2.entity';
import {
  ProtocolAssignment,
  ProtocolAssignmentStatus,
} from '../entities/protocol-assignment.entity';
import { FeedingDayPlan, FeedingDayPlanStatus } from '../entities/feeding-day-plan.entity';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { MealPlanGeneratorService, mixedTankStats } from './meal-plan-generator.service';
import { DayPlanRecalcService } from './day-plan-recalc.service';
import { calendarDayIn } from './meal-schedule.util';
import { collectFeedSourceFeedIds, buildFeedFcrMatrixMap } from './feed-fcr-source.util';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';

/**
 * K-9 operatör aksiyonlarının kapalı sonuç kümesi — GraphQL'e kayıtlı enum
 * olarak çıkar (P-25: telde stringly-typed union yok; kayıt DTO katmanında).
 */
export enum DayPlanAdminOutcome {
  RECALCULATED = 'recalculated',
  GENERATED = 'generated',
  TRANSITIONED = 'transitioned',
}

export interface DayPlanAdminResult {
  outcome: DayPlanAdminOutcome;
  dayPlanId?: string;
}

@Injectable()
export class DayPlanAdminService {
  private readonly logger = new Logger(DayPlanAdminService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly generator: MealPlanGeneratorService,
    private readonly recalcService: DayPlanRecalcService,
    private readonly temperatureService: WaterTemperatureService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async regenerateDayPlan(
    tenantId: string,
    userId: string,
    unitId: string,
  ): Promise<DayPlanAdminResult> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const assignment = await this.loadActiveAssignment(manager, tenantId, unitId);
      const planDate = await this.planDateFor(manager, tenantId, assignment.siteId);

      const existing = await manager
        .createQueryBuilder(FeedingDayPlan, 'dp')
        .where('dp.tenantId = :tenantId', { tenantId })
        .andWhere('dp.unitId = :unitId', { unitId })
        .andWhere('dp.planDate = :planDate', { planDate })
        .andWhere('dp.status IN (:...statuses)', {
          statuses: [FeedingDayPlanStatus.PLANNED, FeedingDayPlanStatus.IN_PROGRESS],
        })
        .getOne();

      if (existing) {
        // Recalc kendi kilit sırasını (DayPlan → Meals → Assignment) sahiplenir.
        const result = await this.recalcService.recalcForUnit(
          manager,
          tenantId,
          unitId,
          'manual_regenerate',
        );
        this.logger.log(
          `Day plan ${existing.id} manually recalculated for unit ${unitId} by ${userId}`,
        );
        return {
          outcome: DayPlanAdminOutcome.RECALCULATED,
          dayPlanId: result?.dayPlanId ?? existing.id,
        };
      }

      // Bugün planı yok → şimdi üret (06:00 üreticisiyle AYNI hesap yolu).
      const protocol = await manager.findOne(FeedingProtocolV2, {
        where: { tenantId, id: assignment.protocolId, isDeleted: false },
      });
      if (!protocol || protocol.status !== FeedingProtocolStatus.ACTIVE) {
        throw new BadRequestException(
          `Ünitenin protokolü ACTIVE değil (${protocol?.status ?? 'yok'}) — plan üretilemez`,
        );
      }
      const tankBatch = await manager.findOne(TankBatch, {
        where: { tenantId, tankId: unitId },
      });
      if (!tankBatch || tankBatch.totalQuantity <= 0) {
        throw new BadRequestException('Ünitede balık yok — plan üretilemez');
      }

      const temperature = await this.temperatureService.getEffectiveTemperature(tenantId, unitId);
      const feedIds = collectFeedSourceFeedIds([protocol]);
      const feeds =
        feedIds.length > 0
          ? await manager.find(Feed, {
              where: { tenantId, id: In(feedIds) },
              select: ['id', 'feedingMatrix2D'],
            })
          : [];

      const computed = this.generator.computeDayPlan({
        assignment,
        protocol,
        stock: {
          fishCount: tankBatch.totalQuantity,
          biomassKg: Number(tankBatch.totalBiomassKg || 0),
          avgWeightG: Number(tankBatch.avgWeightG || 0),
          ...mixedTankStats(tankBatch.batchDetails),
        },
        temperature,
        planDate,
        timezone: await this.timezoneFor(manager, tenantId, assignment.siteId),
        feedFcrMatrixByFeedId: buildFeedFcrMatrixMap(feeds),
      });
      if (!computed) {
        throw new BadRequestException('Plan hesaplanamadı (bandsız protokol veya boş ünite)');
      }
      const dayPlanId = await this.generator.persistDayPlan(
        manager,
        {
          tenantId,
          assignmentId: assignment.id,
          protocolId: assignment.protocolId,
          unitId: assignment.unitId,
          siteId: assignment.siteId,
          unitType: assignment.unitType,
          unitName: assignment.unitName,
          unitCode: assignment.unitCode,
          planDate,
          growthApplicationMode: protocol.settings.growthApplicationMode,
        },
        computed,
      );
      this.logger.log(`Day plan generated on demand for unit ${unitId} by ${userId}`);
      return { outcome: DayPlanAdminOutcome.GENERATED, dayPlanId: dayPlanId ?? undefined };
    });
  }

  async transitionUnitFeed(
    tenantId: string,
    userId: string,
    unitId: string,
    toFeedId: string,
  ): Promise<DayPlanAdminResult> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const planDate = calendarDayInDefault();

      // Kanonik sıra: DayPlan → Meals → Assignment (recalc ile birebir).
      const dayPlan = await manager
        .createQueryBuilder(FeedingDayPlan, 'dp')
        .setLock('pessimistic_write')
        .where('dp.tenantId = :tenantId', { tenantId })
        .andWhere('dp.unitId = :unitId', { unitId })
        .andWhere('dp.status IN (:...statuses)', {
          statuses: [FeedingDayPlanStatus.PLANNED, FeedingDayPlanStatus.IN_PROGRESS],
        })
        .orderBy('dp.planDate', 'DESC')
        .getOne();

      const remainingMeals = dayPlan
        ? await manager
            .createQueryBuilder(FeedingMeal, 'meal')
            .setLock('pessimistic_write')
            .where('meal.dayPlanId = :dayPlanId', { dayPlanId: dayPlan.id })
            .andWhere('meal.status = :status', { status: FeedingMealStatus.SCHEDULED })
            .orderBy('meal.mealIndex', 'ASC')
            .getMany()
        : [];

      const assignment = await this.loadActiveAssignment(manager, tenantId, unitId, {
        lock: true,
      });
      const protocol = await manager.findOne(FeedingProtocolV2, {
        where: { tenantId, id: assignment.protocolId, isDeleted: false },
      });
      if (!protocol) {
        throw new NotFoundException(`Protokol bulunamadı: ${assignment.protocolId}`);
      }

      // Fail-closed: hedef yem protokol bandlarından birinin yemi olmalı.
      const bandIndex = protocol.bands.findIndex((band) => band.feedId === toFeedId);
      if (bandIndex < 0) {
        throw new BadRequestException(
          'Hedef yem bu protokolün band yemlerinden biri değil — manuel geçiş protokol dışına çıkamaz',
        );
      }
      const band = protocol.bands[bandIndex]!;

      const fromFeedId = assignment.currentFeedId;
      assignment.currentFeedId = toFeedId;
      assignment.currentBandIndex = bandIndex;
      assignment.lastTransitionAt = new Date();
      assignment.totalTransitions = (assignment.totalTransitions ?? 0) + 1;
      await manager.save(assignment);

      const now = new Date();
      for (const meal of remainingMeals) {
        meal.feedId = toFeedId;
        meal.recalculatedAt = now;
        await manager.save(meal);
      }

      const tankBatch = await manager.findOne(TankBatch, {
        where: { tenantId, tankId: unitId },
      });
      const event: FeedTypeTransitionedEvent = {
        ...createBaseEvent<FeedTypeTransitionedEvent>('FeedTypeTransitioned', tenantId, {
          aggregateId: unitId,
          aggregateType: 'FeedingUnit',
        }),
        unitId,
        unitCode: assignment.unitCode,
        assignmentId: assignment.id,
        fromFeedId,
        toFeedId,
        toFeedCode: band.feedCode,
        bandIndex,
        avgWeightG: Number(tankBatch?.avgWeightG || 0),
        automatic: false,
      };
      await this.outboxPublisher.enqueue(event, manager);

      this.logger.log(
        `Manual feed transition on unit ${unitId}: ${fromFeedId ?? 'none'} → ${toFeedId} ` +
          `(band ${bandIndex}) by ${userId}; ${remainingMeals.length} remaining meals updated` +
          (dayPlan ? ` (plan ${dayPlan.id}, ${planDate})` : ''),
      );
      return { outcome: DayPlanAdminOutcome.TRANSITIONED, dayPlanId: dayPlan?.id };
    });
  }

  private async loadActiveAssignment(
    manager: EntityManager,
    tenantId: string,
    unitId: string,
    opts?: { lock?: boolean },
  ): Promise<ProtocolAssignment> {
    const qb = manager
      .createQueryBuilder(ProtocolAssignment, 'pa')
      .where('pa.tenantId = :tenantId', { tenantId })
      .andWhere('pa.unitId = :unitId', { unitId })
      .andWhere('pa.status = :status', { status: ProtocolAssignmentStatus.ACTIVE });
    if (opts?.lock) qb.setLock('pessimistic_write');
    const assignment = await qb.getOne();
    if (!assignment) {
      throw new NotFoundException(`Ünitenin aktif protokol ataması yok: ${unitId}`);
    }
    return assignment;
  }

  private async timezoneFor(
    manager: EntityManager,
    tenantId: string,
    siteId: string,
  ): Promise<string> {
    const rows: Array<{ timezone: string | null }> = await manager.query(
      `SELECT timezone FROM "sites" WHERE "tenantId" = $1 AND id = $2`,
      [tenantId, siteId],
    );
    return rows[0]?.timezone || 'UTC';
  }

  private async planDateFor(
    manager: EntityManager,
    tenantId: string,
    siteId: string,
  ): Promise<string> {
    return calendarDayIn(await this.timezoneFor(manager, tenantId, siteId));
  }
}

/** Geçiş loglaması için gün etiketi — UTC günü yeterli (bilgi amaçlı). */
function calendarDayInDefault(): string {
  return calendarDayIn('UTC');
}
