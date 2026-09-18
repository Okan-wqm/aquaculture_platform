/**
 * MealFinalizationService — bir öğünü kapatmanın TEK gerçeği (FARM-MEDIUM-276).
 *
 * ## Neden ayrı bir servis
 *
 * "Öğünü kapat" iki yerden olur: operatör kapatır (`recordMealFeeding(finalize)`
 * / `finalizeMeal`) ya da pencere kapanır (05:30 süpürmesi bayat `partially_fed`
 * öğünleri otomatik finalize eder). Bu iki yol AYNI şeyi yapmak zorundadır:
 * aynı varyans formülü, aynı per-meal büyüme hesabı, aynı kalan-öğün recalc'ı,
 * aynı az-atım eşiği ve aynı plan-durumu kuralı.
 *
 * Bugüne kadar bunu iki KOPYA sağlıyordu ve kopyaların doğru kaldığını iddia
 * eden şey koddaki "SİMETRİ" yorumlarıydı. Bir yorum, iki fonksiyonun aynı
 * kalacağını garanti etmez — ve zaten kalmamışlardı: plan-durumu yazımının
 * kanonik kopyası `dayPlan.status !== nextStatus` koruması taşırken süpürme
 * kopyası her turda koşulsuz UPDATE atıyordu; az-atım eşiğinin `?? 15`
 * varsayılanı iki ayrı ifadede yazılıydı, biri değişse diğeri sessizce eski
 * eşikte kalırdı. Sonuç operatör açısından şudur: sistematik az-atım YALNIZ
 * elle kapatılan öğünlerde görünür, pencere kapanışında kapanan öğünde
 * görünmezdi — yani en çok ilgilenilmesi gereken öğünlerde.
 *
 * Bu servis o iki kopyayı yok eder: her iki çağıran da buraya gelir, "aynı
 * davranmaları" bir yorum değil tek bir fonksiyon gövdesi olur.
 *
 * ## Kilit sözleşmesi
 *
 * Çağıran, kanonik kilit sırasını (Batch → TankBatch → DayPlan → Meal) ZATEN
 * almış olarak gelir; bu servis kilit almaz. `locked`, `lockUnitForGrowth`'un
 * döndürdüğü kilitli üniteyi taşır ve `null` olabilir (üniteye ait TankBatch
 * satırı yok). Büyüme uygulanamayan bu hâl SESSİZ geçilmez: metrik + WARN.
 *
 * @module FeedingProtocol/Services
 */
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent, MealUnderfedEvent } from '@platform/event-contracts';

import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import { FeedingDayPlan, FeedingDayPlanStatus } from '../entities/feeding-day-plan.entity';
import { FeedingProtocolV2 } from '../entities/feeding-protocol-v2.entity';
import { BiomassGrowthApplierService, type LockedUnit } from './biomass-growth-applier.service';
import { DayPlanRecalcService } from './day-plan-recalc.service';
import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';
import { round3 } from '../../common/utils/rounding.util';

/**
 * Protokolde eşik tanımlı değilse kullanılan az-atım eşiği (%).
 *
 * TEK tanım: iki çağıran da bu sabiti kendi `?? 15` ifadesinde tekrar yazarsa
 * biri değiştiğinde diğeri sessizce eski eşikte kalır — bulgunun kendisi buydu.
 */
export const DEFAULT_UNDERFEED_THRESHOLD_PERCENT = 15;

/** Öğünü kapatan çağrının girdisi. Kilitler çağıranda, karar burada. */
export interface MealFinalization {
  tenantId: string;
  dayPlan: FeedingDayPlan;
  meal: FeedingMeal;
  /** `lockUnitForGrowth` sonucu — TankBatch yoksa null. */
  locked: LockedUnit | null;
  finalizedAt: Date;
  /** Kapatan kullanıcı; `null` = pencere kapanışı (kimse kapatmadı). */
  fedBy: string | null;
  /** Planın protokolü (çağıran zaten yüklemiştir); eşik buradan çözülür. */
  protocol: Pick<FeedingProtocolV2, 'settings'> | null;
}

@Injectable()
export class MealFinalizationService {
  private readonly logger = new Logger(MealFinalizationService.name);

  constructor(
    private readonly growthApplier: BiomassGrowthApplierService,
    private readonly recalcService: DayPlanRecalcService,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly metrics: FarmDomainMetricsService,
  ) {}

  /**
   * Öğünü kapat: varyans → (per_meal ise) büyüme + kalan öğün recalc'ı →
   * az-atım sinyali.
   *
   * Dönüş: öğün satırının BURADA yazılıp yazılmadığı. per_meal dalında satır
   * recalc'tan ÖNCE yazılmak ZORUNDA (FARM-MEDIUM-250): aksi hâlde recalc
   * `status='scheduled'` filtresiyle bu öğünü de "kalan" sayıp yeniden
   * fiyatlıyor, ardından bayat entity ile yapılan save recalc'ın `recalcLog` +
   * `plannedTotalKg` yazımını geri alıyor (lost update). `false` dönerse
   * çağıran `manager.save(meal)`'i kendisi yapar.
   */
  async finalize(manager: EntityManager, ctx: MealFinalization): Promise<boolean> {
    const { tenantId, dayPlan, meal, locked, finalizedAt, fedBy, protocol } = ctx;

    meal.status = FeedingMealStatus.FED;
    meal.fedAt = finalizedAt;
    // Pencere kapanışında kimse kapatmadı — sahte bir kullanıcı damgalamak
    // yerine alan boş bırakılır (kolon nullable).
    if (fedBy !== null) meal.fedBy = fedBy;

    const actualKg = Number(meal.actualKg);
    const plannedKg = Number(meal.plannedKg);
    meal.varianceKg = round3(actualKg - plannedKg);
    meal.variancePercent = plannedKg > 0 ? round3(((actualKg - plannedKg) / plannedKg) * 100) : 0;

    let mealPersisted = false;
    // Mod PLANIN kolonundan okunur (FARM-CRITICAL-244): protokolün o anki
    // ayarına bakmak, ayar değiştiğinde büyümeyi çift saydırıyor ya da
    // kaybettiriyordu.
    if (dayPlan.growthApplicationMode !== 'daily') {
      const expectedFcr = dayPlan.resolution.expectedFcr;
      const growthKg = expectedFcr > 0 ? actualKg / expectedFcr : 0;
      if (locked) {
        await this.growthApplier.applyGrowth(manager, tenantId, locked, growthKg, expectedFcr);
        await manager.save(meal);
        mealPersisted = true;
        // Kalan öğünler yeni biomass'tan — band geçişi histerezisle burada.
        await this.recalcService.recalcForUnit(manager, tenantId, meal.unitId, 'meal_growth');
      } else if (growthKg > 0) {
        // Üniteye ait TankBatch yok: kg gerçekten atıldı ama biyokütleye
        // yazılacak yer yok. Sessiz geçmek FCR'ı sistematik olarak bozardı —
        // ölçülebilir ve aranabilir bırakılır.
        this.metrics.recordMealGrowthUnattributed({ reason: 'no_tank_batch' });
        this.logger.warn({
          message: 'Meal finalized without biomass attribution: unit has no tank batch',
          unitId: meal.unitId,
          mealId: meal.id,
          dayPlanId: dayPlan.id,
          growthKg,
        });
      }
    }

    // P-21: az-atım eşiği (negatif varyans) — finalize'da, öğün kapsamında.
    const threshold = underfeedThresholdOf(protocol);
    if (meal.variancePercent !== null && meal.variancePercent < -threshold) {
      const underfed: MealUnderfedEvent = {
        ...createBaseEvent<MealUnderfedEvent>('MealUnderfed', tenantId, {
          aggregateId: meal.id,
          aggregateType: 'FeedingMeal',
        }),
        scope: 'meal',
        unitId: meal.unitId,
        unitCode: dayPlan.unitCode,
        dayPlanId: dayPlan.id,
        mealId: meal.id,
        plannedKg,
        actualKg,
        variancePercent: meal.variancePercent,
        thresholdPercent: threshold,
      };
      await this.outboxPublisher.enqueue(underfed, manager);
    }

    return mealPersisted;
  }

  /**
   * Açık (scheduled/partially_fed) öğün kalmadıysa planı kapat; ilk aktivitede
   * `in_progress`.
   *
   * HEDEFLENMİŞ update (FARM-MEDIUM-250): tam-entity `save()` bu noktada elde
   * tutulan BAYAT nesneyi yazar ve aynı transaction'da recalc'ın güncellediği
   * `recalcLog` + `plannedTotalKg` alanlarını geri alırdı (TypeORM `save()`
   * optimistic sürüm kontrolü yapmaz, hata da yükselmezdi). Yalnız durum
   * kolonu, yalnız gerçekten değiştiyse yazılır.
   */
  async settleDayPlanStatus(
    manager: EntityManager,
    tenantId: string,
    dayPlan: FeedingDayPlan,
  ): Promise<void> {
    const openCount = await manager.count(FeedingMeal, {
      where: [
        { dayPlanId: dayPlan.id, tenantId, status: FeedingMealStatus.SCHEDULED },
        { dayPlanId: dayPlan.id, tenantId, status: FeedingMealStatus.PARTIALLY_FED },
      ],
    });
    const nextStatus =
      openCount === 0 ? FeedingDayPlanStatus.COMPLETED : FeedingDayPlanStatus.IN_PROGRESS;
    if (dayPlan.status !== nextStatus) {
      dayPlan.status = nextStatus;
      await manager.update(FeedingDayPlan, { id: dayPlan.id, tenantId }, { status: nextStatus });
    }
  }
}

/** Protokolün az-atım eşiği; tanımsızsa tek yerde duran varsayılan. */
export function underfeedThresholdOf(
  protocol: Pick<FeedingProtocolV2, 'settings'> | null | undefined,
): number {
  return protocol?.settings.underfeedAlertThresholdPercent ?? DEFAULT_UNDERFEED_THRESHOLD_PERCENT;
}
