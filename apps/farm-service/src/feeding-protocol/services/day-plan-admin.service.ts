/**
 * DayPlanAdminService — operatör (MANAGER+) plan yönetim aksiyonları (K-9).
 *
 *  - `regenerateDayPlan(unitId)`: ünitenin bugünkü planını güncel durumdan
 *    yeniden hesaplar. Aktif plan varsa recalc ('manual_regenerate' gerekçesi —
 *    beslenmiş/kapanmış öğünler korunur, kalanlar yeniden fiyatlanır); bugün
 *    hiç plan üretilmemişse (örn. atama 06:00'dan sonra aktive edildi) planı
 *    ŞİMDİ üretir — 06:00 üreticisiyle aynı computeDayPlan/persistDayPlan yolu.
 *  - `generateInitialDayPlan(assignment)`: atama-anı İLK plan üretimi
 *    (FARM-MEDIUM-257) — protokol atandığı transaction'ın içinde bugünün
 *    planı üretilir; atlanma nedenleri sınıflandırılmış döner (atama yolunda
 *    log, regenerate yolunda BadRequest). Ayrıntı metodun docblock'unda.
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
import { ProtocolResolutionService } from './protocol-resolution.service';
import { FeedingClockService } from './feeding-clock.service';
import { SiteTimeZoneService } from '../../localization/services/site-time-zone.service';
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

/**
 * Atama-anı ilk plan üretiminin ATLANMA nedenleri — sınıflandırılmış, sessiz
 * atlama yok (atama yolunda log'lanır; regenerate yolunda BadRequest'e
 * çevrilir).
 */
export type InitialDayPlanSkipReason =
  | 'not_effective_yet'
  | 'protocol_inactive'
  | 'empty_unit'
  | 'not_computable'
  | 'already_exists';

export type InitialDayPlanResult =
  | { outcome: 'generated'; dayPlanId: string }
  | {
      outcome: 'skipped';
      reason: InitialDayPlanSkipReason;
      /** protocol_inactive için gözlenen protokol durumu (hata mesajında). */
      protocolStatus?: FeedingProtocolStatus | null;
    };

@Injectable()
export class DayPlanAdminService {
  private readonly logger = new Logger(DayPlanAdminService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly generator: MealPlanGeneratorService,
    private readonly recalcService: DayPlanRecalcService,
    private readonly temperatureService: WaterTemperatureService,
    private readonly outboxPublisher: OutboxPublisher,
    // Band çözümü ağırlıktan — manuel geçiş de aynı SSoT'yi kullanır (W3).
    private readonly resolutionService: ProtocolResolutionService,
    // Takvim/saat çözümünün TEK sahibi (W5, D-B4) — servisin kendi
    // `timezoneFor` kopyası (site kolonu → 'UTC', tenant zonu YOK) silindi.
    private readonly clock: FeedingClockService,
    // Zon hiyerarşisinin (site → tenant → UTC) tek sahibi.
    private readonly siteTimeZones: SiteTimeZoneService,
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
      const initial = await this.generateInitialDayPlan(manager, tenantId, assignment);
      if (initial.outcome === 'generated') {
        this.logger.log(`Day plan generated on demand for unit ${unitId} by ${userId}`);
        return { outcome: DayPlanAdminOutcome.GENERATED, dayPlanId: initial.dayPlanId };
      }
      switch (initial.reason) {
        case 'protocol_inactive':
          throw new BadRequestException(
            `Ünitenin protokolü ACTIVE değil (${initial.protocolStatus ?? 'yok'}) — plan üretilemez`,
          );
        case 'empty_unit':
          throw new BadRequestException('Ünitede balık yok — plan üretilemez');
        case 'not_computable':
          throw new BadRequestException('Plan hesaplanamadı (bandsız protokol veya boş ünite)');
        case 'not_effective_yet':
          throw new BadRequestException(
            'Atamanın yürürlük başlangıcı (effectiveFrom) gelecekte — plan henüz üretilmez',
          );
        case 'already_exists':
          // `existing` kontrolü yukarıda PLANNED/IN_PROGRESS için yapıldı; persist
          // çakışması ancak tamamlanmış/iptal edilmiş bir günlük plana karşı
          // olabilir — davranış eskiyle aynı: outcome GENERATED, id belirsiz.
          return { outcome: DayPlanAdminOutcome.GENERATED };
      }
    });
  }

  /**
   * Atama-anı İLK gün planı üretimi (FARM-MEDIUM-257 — kök-neden çözüm).
   *
   * NEDEN ATAMA YOLU: gün planı eskiden yalnız 06:00 cron'unun üretimiyle
   * oluşuyordu; protokol atandıktan sonra operatör ilk planı ERTESİ GÜN
   * görüyordu (`feedingDayPlans` boş dönüyor, E2E akışı düşüyordu). Sorgu
   * tarafında lazy üretim yerine ATAMA KOMUTUNDA eager üretim seçildi:
   * `feedingDayPlans` bir `runInTenantRead` okuma koşusudur (yazma oraya
   * ait değil) ve sorgu MODULE_USER'a açıktır — üretim ise MANAGER+ yeteneği
   * (regenerateDayPlan rol kapısı); okuma yolunda side-effect üretim hem
   * okuma/yazma ayrımını hem rol kapısını delerdi. Atama komutu zaten yazma
   * transaction'ıdır; plan AYNI tx'te üretilir (atomik: ya atama+plan birlikte
   * durur ya birlikte geri alınır).
   *
   * 06:00 cron ile çakışma YAPISAL olarak imkânsız: persistDayPlan
   * `(tenantId, unitId, planDate)` unique anahtarıyla ON CONFLICT DO NOTHING
   * upsert-idempotenttir. Atama yolundaki atlanmalar (boş ünite, geçersiz
   * protokol…) atamayı BAŞARISIZ KILMAZ — atama ile plan üretiminin
   * geçerlilik koşulları farklıdır (balıksız üniteye atama meşrudur); atlanan
   * planı ertesi gün 06:00 üreticisi ya da regenerateDayPlan üretir.
   *
   * Bu metodu regenerateDayPlan'ın "bugün plan yoksa şimdi üret" dalı DA
   * kullanır — iki yol tek hesap gövdesini paylaşır (K-3 dry-run emsali).
   */
  async generateInitialDayPlan(
    manager: EntityManager,
    tenantId: string,
    assignment: ProtocolAssignment,
  ): Promise<InitialDayPlanResult> {
    // Gelecek tarihli effectiveFrom: atama henüz yürürlükte değil — bugünün
    // planı şimdi üretilmez (yürürlük gününün 06:00'ı üretir).
    if (assignment.effectiveFrom && assignment.effectiveFrom.getTime() > Date.now()) {
      return { outcome: 'skipped', reason: 'not_effective_yet' };
    }

    const protocol = await manager.findOne(FeedingProtocolV2, {
      where: { tenantId, id: assignment.protocolId, isDeleted: false },
    });
    if (!protocol || protocol.status !== FeedingProtocolStatus.ACTIVE) {
      return {
        outcome: 'skipped',
        reason: 'protocol_inactive',
        protocolStatus: protocol?.status ?? null,
      };
    }
    const tankBatch = await manager.findOne(TankBatch, {
      where: { tenantId, tankId: assignment.unitId },
    });
    if (!tankBatch || tankBatch.totalQuantity <= 0) {
      return { outcome: 'skipped', reason: 'empty_unit' };
    }

    const temperature = await this.temperatureService.getEffectiveTemperature(
      tenantId,
      assignment.unitId,
    );
    const feedIds = collectFeedSourceFeedIds([protocol]);
    const feeds =
      feedIds.length > 0
        ? await manager.find(Feed, {
            where: { tenantId, id: In(feedIds) },
            select: ['id', 'feedingMatrix2D'],
          })
        : [];

    const planDate = await this.planDateFor(manager, tenantId, assignment.siteId);
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
      timezone: (await this.siteTimeZones.siteZones(manager, tenantId)).zoneOf(assignment.siteId),
      feedFcrMatrixByFeedId: buildFeedFcrMatrixMap(feeds),
    });
    if (!computed) {
      return { outcome: 'skipped', reason: 'not_computable' };
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
    if (!dayPlanId) {
      // Unique anahtar çakışması: bugünün planı zaten var (atama değiştirme
      // semantiği — eski atamanın planı ünitenin bugünü olarak ayakta).
      return { outcome: 'skipped', reason: 'already_exists' };
    }
    return { outcome: 'generated', dayPlanId };
  }

  async transitionUnitFeed(
    tenantId: string,
    userId: string,
    unitId: string,
    toFeedId: string,
  ): Promise<DayPlanAdminResult> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

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

      // Band AĞIRLIKTAN çözülür, feedId'den DEĞİL (FARM-MEDIUM-251).
      // `bands.findIndex(feedId)` aynı pelletin iki bandda kullanıldığı
      // protokollerde — yaygın ve protokol doğrulamasında yasak değil —
      // YANLIŞ bandı kilitliyordu: 60 g balık band0'a (0–50 g, %4) düşüyor,
      // histerezis onu koruyor ve her recalc'ta %33 fazla besleniyordu.
      const transitionTankBatch = await manager.findOne(TankBatch, {
        where: { tenantId, tankId: unitId },
      });
      const bandBasisWeightG = this.resolutionService.resolveBandBasisWeight({
        avgWeightG: Number(transitionTankBatch?.avgWeightG ?? 0),
      });
      const bandIndex = this.resolutionService.resolveManualTransitionBand(
        protocol.bands,
        bandBasisWeightG,
        toFeedId,
      );
      if (bandIndex === null) {
        throw new BadRequestException(
          'Hedef yem, ünitenin güncel ağırlığına karşılık gelen bandın (veya komşu bandın) ' +
            'yemi değil — manuel geçiş protokolün ağırlık mantığı dışına çıkamaz',
        );
      }
      const band = protocol.bands[bandIndex]!;

      const fromFeedId = assignment.currentFeedId;
      assignment.currentFeedId = toFeedId;
      assignment.currentBandIndex = bandIndex;
      // Operatörün seçimi PIN'lenir (FARM-MEDIUM-251). `currentBandIndex` tek
      // başına yetmiyordu: manuel geçiş komşu banda yapılabildiği için çözücü
      // ağırlık bandına dönüyor ve aşağıdaki recalc, geçişi kendi
      // transaction'ında geri alıp çelişkili bir ikinci FeedTypeTransitioned
      // yayıyordu. Pin, balık bandın üstüne çıkana kadar yaşar.
      assignment.manualBandIndex = bandIndex;
      assignment.lastTransitionAt = new Date();
      assignment.totalTransitions = (assignment.totalTransitions ?? 0) + 1;
      await manager.save(assignment);

      const now = new Date();
      for (const meal of remainingMeals) {
        meal.feedId = toFeedId;
        meal.recalculatedAt = now;
        await manager.save(meal);
      }

      // Kalan öğünler YENİ bandın oranıyla yeniden fiyatlanır ve plan çözümü
      // (resolution) atomik güncellenir — eski hâl yalnız `feedId` yazıyordu,
      // öğünler eski bandın kg'ıyla dökülüyordu (FARM-MEDIUM-251 senaryo B).
      await this.recalcService.recalcForUnit(manager, tenantId, unitId, 'manual_transition');

      const tankBatch = transitionTankBatch;
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
          (dayPlan ? ` (plan ${dayPlan.id}, ${dayPlan.planDate})` : ''),
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

  private async planDateFor(
    manager: EntityManager,
    tenantId: string,
    siteId: string,
  ): Promise<string> {
    return (await this.clock.resolve(manager, tenantId, siteId)).localDate;
  }
}
