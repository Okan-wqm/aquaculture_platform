/**
 * DailyFeedingExecutionService
 *
 * Yemleme programlarinin gunluk yurutulmesini yonetir.
 * Her tank icin DailyFeedingExecution kayitlari olusturur ve
 * operator tarafindan kaydedilen gercek yemleme verilerini isler.
 *
 * Temel islevler:
 * 1. Gunluk plan olusturma - generateDailyPlan
 * 2. Operator islemleri - recordActualFeeding, skipDailyFeeding
 * 3. Buyume hesaplama - calculateGrowthFromFeeding
 * 4. Yem gecis kontrolu - checkAndExecuteTransition
 *
 * @module Feeding
 */
import { randomUUID } from 'crypto';

import {
  MobileCommandReceiptService,
  type MobileCommandEnvelope,
} from '@aquaculture/backend-common/mobile-command';
import {
  SiteAuthorizationService,
  type SiteScopeCaller,
} from '@aquaculture/backend-common/security';
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, In, IsNull } from 'typeorm';
import { NatsEventBus } from '@platform/event-bus';

import { resolveTankSiteId } from '../../batch/utils/tank-lookup.util';

// Entities
import {
  DailyFeedingExecution,
  ExecutionStatus,
  ExecutionCalculation,
  ExecutionResult,
  TransitionWarning,
} from '../entities/daily-feeding-execution.entity';
import {
  FeedingProgram,
  FCRSource,
  FeedAssignment,
  GrowthApplicationMode,
} from '../entities/feeding-program.entity';
import { FeedingProgramTank } from '../entities/feeding-program-tank.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { UnitProtocolResolverService } from '../../feeding-protocol/services/unit-protocol-resolver.service';
import {
  tankBandWeightG,
  type BandWeightG,
} from '../../feeding-protocol/services/protocol-rate.service';

// Services
import { BilinearInterpolationService } from './bilinear-interpolation.service';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import { BatchDomainService } from '../../batch/services/batch-domain.service';
import { FeedingLedgerService } from './feeding-ledger.service';
// TEK büyüme yazarı — bu servis artık kendi mutlak-değer yazarını taşımaz.
import { BiomassGrowthApplierService } from '../../feeding-protocol/services/biomass-growth-applier.service';

// Constants
import { SYSTEM_USER_ID } from '../constants';
import { MAX_FEED_KG } from '../../feeding-protocol/constants';

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Sicaklik okuma sonucu
 */
export interface TemperatureReading {
  value: number;
  timestamp: Date;
  sensorId?: string;
}

/**
 * Tank guncel durumu
 */
export interface TankCurrentState {
  tankId: string;
  tankName: string;
  tankCode: string;
  /**
   * UNIT-authoritative average weight — the tank aggregate, never a batch's own
   * weight. Branded so the band resolution below cannot be fed the wrong
   * source; see `BandWeightG` in protocol-rate.service.
   */
  avgWeightG: BandWeightG;
  fishCount: number;
  biomassKg: number;
  waterTempC: number;
  /** True if temperature is using default value because sensor reading was unavailable */
  usingDefaultTemperature: boolean;
  batchId?: string;
}

/**
 * Gunluk plan olusturma sonucu
 */
export interface DailyPlanResult {
  programId: string;
  date: Date;
  executionsCreated: number;
  executions: DailyFeedingExecution[];
  errors: string[];
}

/**
 * Yemleme kaydi sonucu
 */
export interface FeedingRecordResult {
  executionId: string;
  actualKg: number;
  growthKg: number;
  newBiomassKg: number;
  newAvgWeightG: number;
  feedTransitioned: boolean;
  newFeedId?: string;
  newFeedCode?: string;
}

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class DailyFeedingExecutionService {
  private readonly logger = new Logger(DailyFeedingExecutionService.name);

  constructor(
    @InjectRepository(DailyFeedingExecution)
    private readonly executionRepo: Repository<DailyFeedingExecution>,
    @InjectRepository(FeedingProgram)
    private readonly programRepo: Repository<FeedingProgram>,
    @InjectRepository(FeedingProgramTank)
    private readonly programTankRepo: Repository<FeedingProgramTank>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepo: Repository<TankBatch>,
    @InjectRepository(Batch)
    private readonly batchRepo: Repository<Batch>,
    @InjectRepository(Tank)
    private readonly tankRepo: Repository<Tank>,
    @InjectRepository(Feed)
    private readonly feedRepo: Repository<Feed>,
    private readonly bilinearService: BilinearInterpolationService,
    private readonly waterTemperatureService: WaterTemperatureService,
    private readonly dataSource: DataSource,
    private readonly batchDomainService: BatchDomainService,
    // P-05/K-4: drain penceresi boyunca legacy kayıt da TEK yem yazma yolundan
    // (FeedingLedgerService) geçer — storage düşümü artık burada yaşamaz.
    private readonly feedingLedger: FeedingLedgerService,
    // 0.5: the ONE writer of a unit's growth state (lock order + proportional
    // batchDetails distribution + tagged provenance). This service used to keep
    // a rival absolute-value writer; that duplicate is deleted.
    private readonly growthApplier: BiomassGrowthApplierService,
    private readonly mobileCommandReceipts: MobileCommandReceiptService,
    // SEC-HIGH-051: object-level site authorization SSoT, enforced AT THE SINK so
    // every feeding-write caller (recordDailyFeeding, recordBulkFeeding, any
    // future caller) is gated identically and the resolver can never again be
    // the sole, forgettable enforcement point.
    private readonly siteAuth: SiteAuthorizationService,
    // Protocol lookup + rate SSoT (unit-keyed). Shared with the tanks-page
    // DataLoader and the 06:00 day-plan generator so this legacy engine cannot
    // compute a different rate for the same tank.
    private readonly unitProtocol: UnitProtocolResolverService,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  // ==========================================================================
  // 1. GUNLUK PLAN OLUSTURMA
  // ==========================================================================

  /**
   * Bir yemleme programi icin belirtilen tarihte tum tanklara
   * DailyFeedingExecution kayitlari olusturur.
   *
   * @param programId Yemleme programi ID
   * @param date Plan tarihi
   * @param tenantId Tenant ID
   * @param userId Optional user ID (defaults to SYSTEM_USER_ID for cron jobs)
   * @returns Olusturulan plan sonucu
   */
  async generateDailyPlan(
    programId: string,
    date: Date,
    tenantId: string,
    userId: string = SYSTEM_USER_ID,
  ): Promise<DailyPlanResult> {
    this.logger.log(
      `Generating daily plan for program ${programId} on ${date.toISOString().split('T')[0]}`,
    );

    const result: DailyPlanResult = {
      programId,
      date,
      executionsCreated: 0,
      executions: [],
      errors: [],
    };

    // 1. Programi yukle
    const program = await this.programRepo.findOne({
      where: { id: programId, tenantId },
    });

    if (!program) {
      throw new NotFoundException(`Feeding program ${programId} not found`);
    }

    if (!program.isActive()) {
      throw new BadRequestException(`Feeding program ${programId} is not active`);
    }

    // 2. Programa bagli aktif tanklari yukle
    const programTanks = await this.programTankRepo.find({
      where: {
        feedingProgramId: programId,
        tenantId,
        isActive: true,
      },
    });

    if (programTanks.length === 0) {
      result.errors.push('No active tanks found in this program');
      return result;
    }

    // 3. Her tank icin execution olustur
    for (const programTank of programTanks) {
      try {
        // Ayni gun icin zaten execution var mi kontrol et
        const existingExecution = await this.executionRepo.findOne({
          where: {
            feedingProgramTankId: programTank.id,
            executionDate: date,
            tenantId,
          },
        });

        if (existingExecution) {
          this.logger.debug(
            `Execution already exists for tank ${programTank.equipmentCode} on ${date.toISOString().split('T')[0]}`,
          );
          result.executions.push(existingExecution);
          continue;
        }

        // Tank guncel durumunu al
        const tankState = await this.getTankCurrentState(
          programTank.equipmentId,
          tenantId,
          programTank.temperatureSensorId,
        );

        if (!tankState) {
          result.errors.push(`Could not get state for tank ${programTank.equipmentCode}`);
          continue;
        }

        // Gunluk yem miktarini hesapla
        const calculations = await this.calculateDailyFeed(
          program,
          tankState,
          programTank,
          tenantId,
        );

        // Execution olustur
        const execution = this.executionRepo.create({
          tenantId,
          feedingProgramId: programId,
          feedingProgramTankId: programTank.id,
          executionDate: date,
          equipmentId: programTank.equipmentId,
          equipmentType: programTank.equipmentType,
          equipmentName: programTank.equipmentName,
          equipmentCode: programTank.equipmentCode,
          calculations,
          status: ExecutionStatus.PLANNED,
          createdBy: userId, // SECURITY FIX: Track who created this execution
        });

        const savedExecution = await this.executionRepo.save(execution);
        result.executions.push(savedExecution);
        result.executionsCreated++;

        this.logger.debug(
          `Created execution for tank ${programTank.equipmentCode}: ${calculations.plannedFeedKg}kg planned`,
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push(
          `Error creating execution for tank ${programTank.equipmentCode}: ${errorMessage}`,
        );
        this.logger.error(`Error creating execution for tank ${programTank.equipmentCode}`, error);
      }
    }

    this.logger.log(
      `Daily plan generated: ${result.executionsCreated} executions created, ${result.errors.length} errors`,
    );

    return result;
  }

  /**
   * Tank, ortalama agirlik, su sicakligi ve yem bilgisine gore
   * gunluk yem miktarini hesaplar.
   *
   * Feed table'dan feedingRate% alinir ve biomass ile carpilir.
   * FCR ise program veya feed'den alinir.
   */
  async calculateDailyFeed(
    program: FeedingProgram,
    tankState: TankCurrentState,
    programTank: FeedingProgramTank,
    tenantId: string,
  ): Promise<ExecutionCalculation> {
    const { avgWeightG, fishCount, biomassKg, waterTempC, usingDefaultTemperature } = tankState;

    // Validate fishCount to prevent division by zero
    if (fishCount <= 0) {
      throw new BadRequestException(
        `Invalid fish count (${fishCount}) for tank ${programTank.equipmentCode}. Fish count must be greater than 0.`,
      );
    }

    // 1. Mevcut agirlik icin uygun yemi bul
    const feedAssignment = program.findFeedForWeight(avgWeightG);
    if (!feedAssignment) {
      throw new BadRequestException(
        `No feed assignment found for weight ${avgWeightG}g in program ${program.code}`,
      );
    }

    // 2. Feed entity'sini yukle (feedingMatrix2D icin)
    const feed = await this.feedRepo.findOne({
      where: { id: feedAssignment.feedId, tenantId },
    });

    if (!feed) {
      throw new NotFoundException(`Feed ${feedAssignment.feedId} not found for tenant ${tenantId}`);
    }

    // 3. Yemleme oranini hesapla (bilinear interpolasyon ile)
    let feedingRatePercent = 3.0; // Default
    let fcr = 1.0;

    if (feed.feedingMatrix2D) {
      const interpolationResult = this.bilinearService.interpolate(
        feed.feedingMatrix2D,
        waterTempC,
        avgWeightG,
      );
      feedingRatePercent = interpolationResult.feedingRatePercent;
      fcr = interpolationResult.fcr ?? 1.0;
    } else if (feed.feedingCurve && feed.feedingCurve.length > 0) {
      // 1D curve fallback
      const curvePoint = this.findFeedingCurvePoint(feed.feedingCurve, avgWeightG);
      if (curvePoint) {
        feedingRatePercent = curvePoint.feedingRatePercent;
        fcr = curvePoint.fcr;
      }
    }

    // 3b. Protocol precedence (rate SSoT). If the TANK carries an active
    // protocol assignment, its band rate × tempMultiplier × unit override
    // drives the rate — the SAME resolver the tanks-page DataLoader and the
    // 06:00 day-plan generator use, so all three agree by construction. FCR
    // stays feed/program-derived (this legacy path has no protocol FCR model).
    // A DEFAULTED temperature must not scale the protocol rate: the tanks page
    // passes undefined when no reading exists (multiplier 1.0), and the daily
    // plan must agree — the 15 °C fallback stays confined to the matrix/curve
    // interpolation above, which needs SOME temperature to interpolate at all.
    const protocolRatePercent = await this.resolveProtocolRatePercent(
      tenantId,
      tankState.tankId,
      avgWeightG,
      usingDefaultTemperature ? undefined : waterTempC,
    );
    if (protocolRatePercent !== null) {
      feedingRatePercent = protocolRatePercent;
    }

    // 4. FCR kaynagini kontrol et
    let fcrSource = FCRSource.FEED;
    if (program.settings.fcrSource === FCRSource.PROGRAM && program.fcrTable) {
      const programFCR = this.getFCRFromProgramTable(program.fcrTable, waterTempC, avgWeightG);
      if (programFCR) {
        fcr = programFCR;
        fcrSource = FCRSource.PROGRAM;
      }
    }

    // 5. Validate FCR is within biological limits (0.5 to 5.0)
    const MIN_FCR = 0.5;
    const MAX_FCR = 5.0;
    if (fcr < MIN_FCR || fcr > MAX_FCR) {
      this.logger.warn(
        `FCR value ${fcr} outside biological limits (${MIN_FCR}-${MAX_FCR}) for tank ${programTank.equipmentCode}. Clamping to valid range.`,
      );
      fcr = Math.max(MIN_FCR, Math.min(MAX_FCR, fcr));
    }

    // 6. Gunluk yem miktarini hesapla
    const plannedFeedKg = this.calculateDailyFeedAmount(biomassKg, feedingRatePercent);

    // 7. Ogun basina yem miktari - validate mealsPerDay to prevent division by zero
    const mealsPerDay = program.settings.defaultMealsPerDay ?? 4;
    if (mealsPerDay <= 0) {
      throw new BadRequestException(
        `Invalid mealsPerDay setting (${mealsPerDay}) in program ${program.code}. Must be greater than 0.`,
      );
    }
    const perMealKg = plannedFeedKg / mealsPerDay;

    // 8. Gecis uyarisi kontrol et
    let transitionWarning: TransitionWarning | undefined;
    const transitionInfo = program.isTransitionApproaching(avgWeightG);
    if (transitionInfo.approaching && transitionInfo.nextFeed) {
      const currentFeed = feedAssignment;
      transitionWarning = {
        currentRange: `${currentFeed.minWeightG}-${currentFeed.maxWeightG}g`,
        nextRange: `${transitionInfo.nextFeed.minWeightG}-${transitionInfo.nextFeed.maxWeightG}g`,
        nextFeedId: transitionInfo.nextFeed.feedId,
        nextFeedCode: transitionInfo.nextFeed.feedCode,
        remainingGrams: transitionInfo.remainingG ?? 0,
        estimatedDays: this.estimateDaysToTransition(
          avgWeightG,
          currentFeed.maxWeightG,
          fcr,
          plannedFeedKg,
          fishCount,
        ),
      };
    }

    // Log warning if using default temperature
    if (usingDefaultTemperature) {
      this.logger.warn(
        `[WARNING] Execution for tank ${programTank.equipmentCode} is using default temperature (${waterTempC}C). ` +
          `Feeding calculations may be inaccurate.`,
      );
    }

    return {
      avgWeightG,
      fishCount,
      biomassKg,
      waterTempC,
      usingDefaultTemperature,
      activeFeedId: feedAssignment.feedId,
      activeFeedCode: feedAssignment.feedCode,
      activeFeedName: feedAssignment.feedName,
      feedingRatePercent,
      plannedFeedKg,
      mealsPerDay,
      perMealKg,
      expectedFCR: fcr,
      fcrSource,
      transitionWarning,
    };
  }

  // ==========================================================================
  // 2. OPERATOR ISLEMLERI
  // ==========================================================================

  /**
   * Gercek yemleme miktarini kaydeder.
   * FCR ile buyume hesabi yapar ve tank/batch gunceller.
   *
   * SEC-HIGH-051: object-level site authorization is enforced HERE, at the
   * shared sink, not at the resolver. The `caller` (sub/roles/assignedSiteIds)
   * is resolved against the execution's tank site on the SAME transactional
   * manager that performs the write, so EVERY feeding-write call site —
   * recordDailyFeeding, recordBulkFeeding, and any future caller — fails closed
   * for an unassigned/unresolved site (MODULE_MANAGER+ bypasses via the role
   * hierarchy). The caller is REQUIRED: no feeding write may run unauthenticated
   * for site scope.
   *
   * @param executionId Execution ID
   * @param actualKg Verilen gercek yem miktari (kg)
   * @param userId Islemi yapan kullanici
   * @param tenantId Tenant ID
   * @param caller SEC-HIGH-051 site-scope caller (sub/roles/assignedSiteIds)
   * @param notes Opsiyonel notlar
   */
  async recordActualFeeding(
    executionId: string,
    actualKg: number,
    userId: string,
    tenantId: string,
    caller: SiteScopeCaller,
    notes?: string,
    mobileCommand?: MobileCommandEnvelope,
  ): Promise<FeedingRecordResult> {
    // Input validation for actualKg
    if (actualKg <= 0) {
      throw new BadRequestException('Actual feed amount must be greater than 0');
    }
    if (actualKg > MAX_FEED_KG) {
      throw new BadRequestException(
        `Actual feed amount (${actualKg}kg) exceeds maximum allowed (${MAX_FEED_KG}kg)`,
      );
    }

    this.logger.log(
      `Recording actual feeding for execution ${executionId}: ${actualKg}kg by user ${userId}`,
    );

    // Create queryRunner for transaction
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // FARM-MEDIUM-051: idempotency for daily feeding. A retry of an
      // already-COMMITTED feeding previously surfaced as a hard failure because
      // canRecordFeeding() is false once COMPLETED. With the durable receipt, a
      // replay is a no-op SUCCESS that returns the committed result and bypasses
      // canRecordFeeding(). Feeding is NOT stock-decrementing, so legacy mode
      // (no envelope) is TOLERATED and runs once — unlike mortality/cull/transfer.
      const receipt = await this.mobileCommandReceipts.begin(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        tenantId,
        envelope: mobileCommand,
        operationType: 'recordDailyFeeding',
        responseType: 'DailyFeedingExecution',
      });
      if (receipt.mode === 'replay') {
        await queryRunner.commitTransaction();
        const replayed = receipt.responsePayload as FeedingRecordResult | null;
        if (replayed && replayed.executionId) {
          return replayed;
        }
        // Receipt completed but the response payload is unavailable — surface a
        // clear conflict instead of silently re-running the side effects.
        throw new BadRequestException(
          `Feeding for execution ${executionId} was already recorded (replay payload unavailable)`,
        );
      }

      // 1. Execution'i yukle with tenantId filter
      const execution = await queryRunner.manager.findOne(DailyFeedingExecution, {
        where: { id: executionId, tenantId },
        relations: ['feedingProgram'],
      });

      if (!execution) {
        throw new NotFoundException(`Execution ${executionId} not found for tenant ${tenantId}`);
      }

      if (!execution.canRecordFeeding()) {
        throw new BadRequestException(
          `Execution ${executionId} cannot record feeding (status: ${execution.status}). ` +
            `Only PLANNED or IN_PROGRESS executions can record feeding.`,
        );
      }

      // SEC-HIGH-051: object-level site authorization at the SHARED SINK. Resolve
      // the execution's tank (equipmentId) -> Department.siteId on THIS
      // transaction's manager (serialized with the writes below) and assert the
      // caller is assigned to it BEFORE any feeding mutation. MODULE_MANAGER+
      // bypasses via the role hierarchy; an unassigned/unresolved site for a
      // MODULE_USER is DENIED (fail-closed). Done here, not in the resolver, so
      // every caller (single + bulk + future) is gated identically.
      const feedingSiteId = await resolveTankSiteId(
        queryRunner.manager,
        execution.equipmentId,
        tenantId,
      );
      this.siteAuth.assertSiteAssignment({ caller, siteId: feedingSiteId });

      // 1.5 Live LOCKED batch re-read + feedability assertion.
      //
      // WHY: this service previously NEVER loaded the Batch in the recording
      // transaction — it only touched the batch indirectly (and unlocked)
      // through updateTankBiomassWithManager AFTER growth was already
      // computed. So a batch that was emptied / closed / harvested between
      // plan generation and recording could still have feed logged against
      // it, inflating totalFeedConsumed with no biomass and corrupting FCR
      // (the exact failure assertFeedable guards in CreateFeedingRecordHandler).
      // WHAT: acquire the unit in the K-1 canonical order (the unit's batches by
      // batchId ASC under pessimistic_write, then the TankBatch row) through the
      // shared primitive, take the primary batch FROM that locked set, and
      // reject the recording if it is empty or non-feedable BEFORE any state is
      // mutated — a concurrent CloseBatch / final harvest cannot race it.
      // The old shape read TankBatch unlocked, locked the primary batch, and
      // only then locked TankBatch again deep inside
      // updateTankBiomassWithManager — the reverse of the order every other
      // writer on this tank uses (AB-BA).
      const locked = await this.growthApplier.lockUnitForGrowth(
        queryRunner.manager,
        tenantId,
        execution.equipmentId,
      );
      if (!locked?.tankBatch.primaryBatchId) {
        // K-4 fail-closed: tek yem yazma yolu (FeedingLedgerService) yem
        // kaydını batch'siz yazamaz — batch'i olmayan tanka yem kaydı, hiçbir
        // biomass'a atfedilemeyen tüketim demektir (assertFeedable'ın koruduğu
        // aynı bozulma). Eski davranış bunu sessizce tolere ediyordu.
        throw new BadRequestException(
          `Tank ${execution.equipmentId} has no primary batch — feeding cannot be ` +
            `recorded without a batch to attribute the feed to.`,
        );
      }
      const primaryBatchId = locked.tankBatch.primaryBatchId;
      const lockedBatch = locked.batches.get(primaryBatchId);
      if (!lockedBatch) {
        // primaryBatchId is derived FROM batchDetails by the single stock
        // writer (TankBatchService.applyBatchDelta), so a primary batch that is
        // not in the unit's locked set means the row is internally
        // inconsistent. Feeding it would attribute feed to a batch outside the
        // locked cohort; refuse instead of locking it out of order.
        throw new NotFoundException(
          `Primary batch ${primaryBatchId} not found in the locked batch set of tank ${execution.equipmentId}.`,
        );
      }
      this.batchDomainService.assertFeedable(lockedBatch);

      // 2. Validate and get FCR with range check
      let fcr = execution.calculations.expectedFCR;
      const MIN_FCR = 0.5;
      const MAX_FCR = 5.0;
      if (fcr < MIN_FCR || fcr > MAX_FCR) {
        this.logger.warn(
          `FCR value ${fcr} outside biological limits (${MIN_FCR}-${MAX_FCR}) for execution ${executionId}. Clamping to valid range.`,
        );
        fcr = Math.max(MIN_FCR, Math.min(MAX_FCR, fcr));
      }

      // Growth application mode (per-program). PER_FEEDING rolls the weight up now;
      // DAILY records the feed but holds back the roll-up to applyPendingDailyGrowth,
      // so every plan in the day sees the same morning weight.
      const growthMode =
        execution.feedingProgram?.settings?.growthApplicationMode ??
        GrowthApplicationMode.PER_FEEDING;
      const applyGrowthNow = growthMode === GrowthApplicationMode.PER_FEEDING;

      // 3. Buyume hesapla with sanity checks
      const growthKg = this.calculateGrowthFromFeeding(actualKg, fcr);

      // 4. Yeni biomass ve ortalama agirlik hesapla
      const { biomassKg, fishCount } = execution.calculations;

      // Validate fishCount to prevent division by zero
      if (fishCount <= 0) {
        throw new BadRequestException(
          `Cannot calculate growth: fish count is ${fishCount}. Tank may be empty.`,
        );
      }

      // Sanity check: growth should not exceed biological limits
      // Max daily growth is typically 5% of body weight
      const maxDailyGrowthKg = biomassKg * 0.05;
      if (growthKg > maxDailyGrowthKg) {
        this.logger.warn(
          `Calculated growth (${growthKg.toFixed(2)}kg) exceeds expected biological limit ` +
            `(${maxDailyGrowthKg.toFixed(2)}kg, 5% of biomass) for execution ${executionId}`,
        );
      }

      // Projected figures from the execution's plan snapshot. When the growth is
      // actually applied below these are REPLACED by the unit's re-derived
      // aggregates: the snapshot is a plan-time forecast, while the tank row is
      // the live truth (it may have absorbed a mortality or a weighing since).
      let newBiomassKg = biomassKg + growthKg;
      let newAvgWeightG = (newBiomassKg / fishCount) * 1000;

      // Store previous state for audit
      const previousState = {
        status: execution.status,
        biomassKg,
        avgWeightG: execution.calculations.avgWeightG,
      };

      // 5. Execution'i guncelle (entity metodunu kullan)
      execution.recordActualFeeding(actualKg, fcr, userId, notes);
      if (applyGrowthNow) {
        // PER_FEEDING: growth is rolled into the tank/batch below, now — stamp the
        // idempotency key so the daily roll-up never re-applies it.
        execution.growthAppliedAt = new Date();
      }

      // 6. Buyumeyi TEK yazardan uygula — PER_FEEDING only. DAILY holds this
      // back to applyPendingDailyGrowth (growthAppliedAt stays null until then).
      //
      // WHY the single writer: updateTankBiomassWithManager used to set
      // tankBatch.avgWeightG / totalBiomassKg / currentBiomassKg to ABSOLUTE
      // values derived from a plan-time snapshot, without touching
      // batchDetails[] — blowing away the per-batch SSoT that every other
      // writer maintains, so a mixed tank's breakdown silently drifted from its
      // own aggregate. Routing the DELTA through applyGrowth distributes it
      // proportionally across batchDetails[] and re-derives the aggregates FROM
      // that SSoT, which is the only shape that cannot drift. It also projects
      // Tank.currentBiomass and stamps FCR provenance in one place.
      if (applyGrowthNow) {
        await this.growthApplier.applyGrowth(queryRunner.manager, tenantId, locked, growthKg, fcr);
        // Re-derived by the writer from batchDetails[] — the authoritative
        // post-growth weight, and therefore the right input to the feed
        // transition check below (which used to run on the snapshot forecast).
        newBiomassKg = Number(locked.tankBatch.totalBiomassKg);
        newAvgWeightG = Number(locked.tankBatch.avgWeightG);
      }

      // 7. Yem gecisi kontrolu — PER_FEEDING only; DAILY re-evaluates transitions
      // when the roll-up applies the aggregate growth.
      let feedTransitioned = false;
      let newFeedId: string | undefined;
      let newFeedCode: string | undefined;

      if (applyGrowthNow && execution.feedingProgram) {
        const transitionResult = await this.checkAndExecuteTransitionWithManager(
          queryRunner.manager,
          execution,
          newAvgWeightG,
          tenantId,
        );
        if (transitionResult) {
          feedTransitioned = true;
          newFeedId = transitionResult.newFeedId;
          newFeedCode = transitionResult.newFeedCode;
          execution.markFeedTransition(newFeedId, newFeedCode);
        }
      }

      // 8. Kaydet execution within transaction
      await queryRunner.manager.save(execution);

      // 9. TEK yem yazma yolu (P-05/K-4): drain penceresi boyunca legacy
      // execution kaydı da FeedingLedgerService'ten geçer — FeedingRecord
      // satırı (sourceExecutionId unique partial index; Faz 6 tarihsel
      // backfill'i aynı anahtara çarptığı için drain kayıtları çift
      // taşınamaz), Batch.totalFeedConsumed/Cost (kilit yukarıda alındı),
      // site-scoped FEFO storage düşümü (akışın SON yazımı, K-1) ve
      // FeedingRecordedEvent outbox tek noktadan. FCRCalculationService ve
      // finans (derived-cost-sources) drain kayıtlarını artık eksik görmez.
      const activeFeed = await queryRunner.manager.findOne(Feed, {
        where: { id: execution.calculations.activeFeedId, tenantId },
      });
      if (!activeFeed) {
        throw new NotFoundException(
          `Feed ${execution.calculations.activeFeedId} not found for tenant ${tenantId}.`,
        );
      }
      const recordedAt = new Date();
      await this.feedingLedger.recordFeed(
        queryRunner.manager,
        tenantId,
        userId,
        lockedBatch,
        activeFeed,
        {
          batchId: lockedBatch.id,
          tankId: execution.equipmentId,
          feedId: activeFeed.id,
          plannedAmountKg: execution.calculations.plannedFeedKg,
          actualAmountKg: actualKg,
          feedingDate: new Date(execution.executionDate),
          feedingTime: `${String(recordedAt.getUTCHours()).padStart(2, '0')}:${String(
            recordedAt.getUTCMinutes(),
          ).padStart(2, '0')}`,
          fedBy: userId,
          notes,
          sourceExecutionId: executionId,
          siteId: feedingSiteId ?? undefined,
        },
      );

      const result: FeedingRecordResult = {
        executionId,
        actualKg,
        growthKg,
        newBiomassKg,
        newAvgWeightG,
        feedTransitioned,
        newFeedId,
        newFeedCode,
      };

      // FARM-MEDIUM-051: mark the receipt COMPLETED with the result payload, in
      // the SAME transaction, so a later retry with the same clientCommandId
      // replays this exact result instead of re-running the feeding. No-op for
      // legacy mode (no envelope).
      await this.mobileCommandReceipts.complete(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        receipt,
        responseType: 'DailyFeedingExecution',
        responseId: execution.id,
        responsePayload: result,
      });

      await queryRunner.commitTransaction();

      // 10. Audit log for state change
      this.logger.log(
        `[AUDIT] Feeding recorded for execution ${executionId}: ` +
          `status ${previousState.status} -> ${execution.status}, ` +
          `biomass ${previousState.biomassKg.toFixed(2)}kg -> ${newBiomassKg.toFixed(2)}kg, ` +
          `avgWeight ${previousState.avgWeightG.toFixed(1)}g -> ${newAvgWeightG.toFixed(1)}g, ` +
          `actualKg: ${actualKg}, growthKg: ${growthKg.toFixed(2)}, ` +
          `user: ${userId}` +
          (feedTransitioned ? `, transitioned to ${newFeedCode}` : ''),
      );

      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to record feeding for execution ${executionId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Gunluk yemlemeyi atlar.
   *
   * SEC-HIGH-051: skipping a feeding execution is a site-scoped write (it flips
   * the execution to SKIPPED). The `caller` is asserted against the execution's
   * tank site at this sink — same fail-closed posture as recordActualFeeding —
   * so a MODULE_USER cannot skip another site's executions.
   *
   * @param executionId Execution ID
   * @param reason Atlama nedeni
   * @param userId Islemi yapan kullanici
   * @param tenantId Tenant ID
   * @param caller SEC-HIGH-051 site-scope caller (sub/roles/assignedSiteIds)
   */
  async skipDailyFeeding(
    executionId: string,
    reason: string,
    userId: string,
    tenantId: string,
    caller: SiteScopeCaller,
  ): Promise<DailyFeedingExecution> {
    // Validate reason
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('Skip reason is required');
    }

    this.logger.log(`Skipping execution ${executionId}: ${reason} by user ${userId}`);

    const execution = await this.executionRepo.findOne({
      where: { id: executionId, tenantId },
    });

    if (!execution) {
      throw new NotFoundException(`Execution ${executionId} not found for tenant ${tenantId}`);
    }

    // SEC-HIGH-051: assert site assignment before the SKIPPED write. The skip is
    // not transactional, so resolve on the shared datasource manager; the row is
    // re-checked + saved immediately after, so no TOCTOU window of practical
    // concern (and a site re-home cannot grant access that was just denied).
    const skipSiteId = await resolveTankSiteId(
      this.dataSource.manager,
      execution.equipmentId,
      tenantId,
    );
    this.siteAuth.assertSiteAssignment({ caller, siteId: skipSiteId });

    if (execution.isCompleted() || execution.isSkipped()) {
      throw new BadRequestException(
        `Execution ${executionId} is already ${execution.status}. Cannot skip a ${execution.status} execution.`,
      );
    }

    // Store previous state for audit
    const previousStatus = execution.status;

    // Entity metodunu kullan
    execution.skip(reason, userId);

    const savedExecution = await this.executionRepo.save(execution);

    // Audit log for state change
    this.logger.log(
      `[AUDIT] Execution ${executionId} skipped: status ${previousStatus} -> ${execution.status}, ` +
        `reason: "${reason}", user: ${userId}`,
    );

    return savedExecution;
  }

  // ==========================================================================
  // 3. BUYUME HESAPLAMA
  // ==========================================================================

  /**
   * Verilen yem miktari ve FCR'dan buyumeyi hesaplar.
   *
   * Formula: growthKg = actualKg / fcr
   *
   * @param actualKg Verilen yem miktari (kg)
   * @param fcr Feed Conversion Ratio
   * @returns Buyume miktari (kg)
   */
  calculateGrowthFromFeeding(actualKg: number, fcr: number): number {
    if (fcr <= 0) {
      this.logger.warn(`Invalid FCR value: ${fcr}, using default 1.0`);
      fcr = 1.0;
    }
    return actualKg / fcr;
  }

  /**
   * DAILY-mode roll-up: apply the day's pending FCR growth to each tank ONCE.
   *
   * PER_FEEDING executions stamp `growthAppliedAt` inline, so the only rows this
   * finds are DAILY executions whose weight update was pending. For each tank it
   * sums the pending growth (fed / clamped-FCR) and applies a single weight
   * update to the still-morning biomass, then stamps every processed execution so
   * the growth is never applied twice. Idempotent — safe to run repeatedly.
   */
  async applyPendingDailyGrowth(
    tenantId: string,
  ): Promise<{ tanksUpdated: number; executionsRolledUp: number }> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const pending = await manager.find(DailyFeedingExecution, {
        // tenantId predicate matches every sibling read: defense-in-depth beyond
        // the pinned search_path (a future schema change must not fold tenants).
        where: { tenantId, status: ExecutionStatus.COMPLETED, growthAppliedAt: IsNull() },
        relations: { feedingProgram: true, feedingProgramTank: true },
      });
      if (pending.length === 0) {
        return { tanksUpdated: 0, executionsRolledUp: 0 };
      }

      // Sum each tank's pending growth; carry every id so it can be stamped, and
      // the latest program-bearing execution so the feed transition the inline
      // path skipped for DAILY can be evaluated against the rolled-up weight.
      const byTank = new Map<
        string,
        { growthKg: number; fedKg: number; ids: string[]; latest?: DailyFeedingExecution }
      >();
      for (const exec of pending) {
        const entry = byTank.get(exec.equipmentId) ?? { growthKg: 0, fedKg: 0, ids: [] };
        const actualKg = exec.actualFeedKg;
        if (actualKg && actualKg > 0) {
          const fcr = Math.max(0.5, Math.min(5.0, exec.calculations.expectedFCR));
          entry.growthKg += this.calculateGrowthFromFeeding(actualKg, fcr);
          // Carried so the roll-up can state the EFFECTIVE FCR of the whole day
          // (Σfed / Σgrowth) as provenance instead of one execution's rate.
          entry.fedKg += actualKg;
        }
        entry.ids.push(exec.id);
        if (
          exec.feedingProgram &&
          (!entry.latest || exec.executionDate >= entry.latest.executionDate)
        ) {
          entry.latest = exec;
        }
        byTank.set(exec.equipmentId, entry);
      }

      const now = new Date();
      let tanksUpdated = 0;
      for (const [equipmentId, { growthKg, fedKg, latest }] of byTank) {
        if (growthKg <= 0) {
          continue;
        }
        // The tank biomass is still the morning value — DAILY held back every
        // update. Locked in the canonical order by the shared primitive.
        const locked = await this.growthApplier.lockUnitForGrowth(manager, tenantId, equipmentId);
        // COUNT SSoT read (DB-FARMPROD-HIGH-001): fish count is the batchDetails-
        // derived totalQuantity, not the redundant currentQuantity mirror.
        if (!locked || locked.tankBatch.totalQuantity <= 0) {
          continue;
        }
        // PROVENANCE FIX: the old writer stamped `basedOnFCR = batch.fcr?.actual ?? 1.0`.
        // `fcr.actual` is 0 for every live batch and `??` does NOT coalesce 0, so
        // it stamped basedOnFCR = 0 — a division-by-zero-shaped provenance that
        // claimed the growth came from an impossible feed conversion. The day's
        // EFFECTIVE FCR (Σfed / Σgrowth) is the only honest answer here, because
        // the roll-up sums executions that each used their own expected FCR.
        const basedOnFcr = fedKg / growthKg;
        await this.growthApplier.applyGrowth(manager, tenantId, locked, growthKg, basedOnFcr);
        // Re-derived from batchDetails[] by the single writer.
        const newAvgWeightG = Number(locked.tankBatch.avgWeightG);
        // DAILY held the feed-transition check back at recording time; evaluate
        // it here against the rolled-up weight so transitions (programTank
        // update + stats + audit) fire exactly once per day for DAILY programs.
        if (latest) {
          const transition = await this.checkAndExecuteTransitionWithManager(
            manager,
            latest,
            newAvgWeightG,
            tenantId,
          );
          if (transition) {
            latest.markFeedTransition(transition.newFeedId, transition.newFeedCode);
            await manager.save(latest);
          }
        }
        tanksUpdated += 1;
      }

      // Stamp EVERY processed execution — including zero-growth ones — so the daily
      // scan does not keep re-reading them.
      const allIds = Array.from(byTank.values()).flatMap((e) => e.ids);
      await manager.update(DailyFeedingExecution, { id: In(allIds) }, { growthAppliedAt: now });

      return { tanksUpdated, executionsRolledUp: allIds.length };
    });
  }

  // updateTankBiomass / updateTankBiomassWithManager are GONE (0.5).
  //
  // They were a SECOND writer of a unit's growth state and every difference
  // from the real one was a defect:
  //   - they set tankBatch.avgWeightG / totalBiomassKg / currentBiomassKg to
  //     ABSOLUTE values without touching batchDetails[], erasing the per-batch
  //     SSoT that BiomassGrowthApplierService.applyGrowth maintains;
  //   - they overwrote the PRIMARY batch's theoretical weight with ONE tank's
  //     figure, corrupting a batch that spans several units (the D-1 bug);
  //   - they stamped `basedOnFCR = batch.fcr?.actual ?? 1.0`, and because
  //     `fcr.actual` is 0 for every live batch and `??` does not coalesce 0,
  //     the persisted provenance was 0.
  // Both call sites now go through BiomassGrowthApplierService, so there is
  // exactly ONE writer of a tank's growth and its provenance is always tagged.

  // ==========================================================================
  // 4. YEM GECIS KONTROLU
  // ==========================================================================

  /**
   * Yeni ortalama agirliga gore yem gecisi gerekip gerekmedlgini kontrol eder.
   * Eger agirlik siniri gecildiyse, FeedingProgramTank'i yeni yemle gunceller.
   * Creates its own queries - use checkAndExecuteTransitionWithManager for existing transactions.
   *
   * @param execution Guncel execution
   * @param newAvgWeightG Yeni ortalama agirlik
   * @param tenantId Tenant ID
   * @returns Gecis yapildiysa yeni yem bilgisi, yoksa null
   */
  async checkAndExecuteTransition(
    execution: DailyFeedingExecution,
    newAvgWeightG: number,
    tenantId: string,
  ): Promise<{ newFeedId: string; newFeedCode: string } | null> {
    // Programi yukle with tenantId filter
    const program = await this.programRepo.findOne({
      where: { id: execution.feedingProgramId, tenantId },
    });

    if (!program || !program.settings.autoTransition) {
      return null;
    }

    // Mevcut yem atamasini bul
    const currentFeed = program.findFeedForWeight(execution.calculations.avgWeightG);
    if (!currentFeed) {
      return null;
    }

    // Yeni agirlik icin yem atamasini bul
    const newFeed = program.findFeedForWeight(newAvgWeightG);
    if (!newFeed) {
      return null;
    }

    // Ayni yem mi kontrol et
    if (currentFeed.feedId === newFeed.feedId) {
      return null;
    }

    // Yem degisti - ProgramTank'i guncelle with tenantId filter
    const programTank = await this.programTankRepo.findOne({
      where: { id: execution.feedingProgramTankId, tenantId },
    });

    if (programTank) {
      // Yeni yem atamasinin index'ini bul
      const newRangeIndex = program.feedAssignments.findIndex((fa) => fa.feedId === newFeed.feedId);

      programTank.transitionToFeed(newFeed.feedId, newFeed.feedCode, newRangeIndex);

      await this.programTankRepo.save(programTank);

      // Program istatistiklerini guncelle
      program.totalFeedTransitions++;
      await this.programRepo.save(program);

      // Audit log for feed transition
      this.logger.log(
        `[AUDIT] Feed transition executed for tank ${programTank.equipmentCode}: ` +
          `${currentFeed.feedCode} -> ${newFeed.feedCode} (weight: ${newAvgWeightG.toFixed(1)}g)`,
      );
    } else {
      this.logger.warn(
        `ProgramTank ${execution.feedingProgramTankId} not found for tenant ${tenantId}. Feed transition skipped.`,
      );
    }

    return {
      newFeedId: newFeed.feedId,
      newFeedCode: newFeed.feedCode,
    };
  }

  /**
   * Yeni ortalama agirliga gore yem gecisi gerekip gerekmedlgini kontrol eder (uses provided EntityManager).
   * Use this when you already have an active transaction.
   *
   * @param manager EntityManager from existing transaction
   * @param execution Guncel execution
   * @param newAvgWeightG Yeni ortalama agirlik
   * @param tenantId Tenant ID
   * @returns Gecis yapildiysa yeni yem bilgisi, yoksa null
   */
  /**
   * @internal Shared transition seam — invoked inline by recordActualFeeding
   * (PER_FEEDING) and by applyPendingDailyGrowth (DAILY roll-up).
   */
  async checkAndExecuteTransitionWithManager(
    manager: import('typeorm').EntityManager,
    execution: DailyFeedingExecution,
    newAvgWeightG: number,
    tenantId: string,
  ): Promise<{ newFeedId: string; newFeedCode: string } | null> {
    // Programi yukle with tenantId filter
    const program = await manager.findOne(FeedingProgram, {
      where: { id: execution.feedingProgramId, tenantId },
    });

    if (!program || !program.settings.autoTransition) {
      return null;
    }

    // Mevcut yem atamasini bul
    const currentFeed = program.findFeedForWeight(execution.calculations.avgWeightG);
    if (!currentFeed) {
      return null;
    }

    // Yeni agirlik icin yem atamasini bul
    const newFeed = program.findFeedForWeight(newAvgWeightG);
    if (!newFeed) {
      return null;
    }

    // Ayni yem mi kontrol et
    if (currentFeed.feedId === newFeed.feedId) {
      return null;
    }

    // Yem degisti - ProgramTank'i guncelle with tenantId filter and pessimistic lock
    const programTank = await manager.findOne(FeedingProgramTank, {
      where: { id: execution.feedingProgramTankId, tenantId },
      lock: { mode: 'pessimistic_write' },
    });

    if (programTank) {
      // Yeni yem atamasinin index'ini bul
      const newRangeIndex = program.feedAssignments.findIndex((fa) => fa.feedId === newFeed.feedId);

      programTank.transitionToFeed(newFeed.feedId, newFeed.feedCode, newRangeIndex);

      await manager.save(programTank);

      // Program istatistiklerini guncelle
      program.totalFeedTransitions++;
      await manager.save(program);

      // Audit log for feed transition
      this.logger.log(
        `[AUDIT] Feed transition executed for tank ${programTank.equipmentCode}: ` +
          `${currentFeed.feedCode} -> ${newFeed.feedCode} (weight: ${newAvgWeightG.toFixed(1)}g)`,
      );
    } else {
      this.logger.warn(
        `ProgramTank ${execution.feedingProgramTankId} not found for tenant ${tenantId}. Feed transition skipped.`,
      );
    }

    return {
      newFeedId: newFeed.feedId,
      newFeedCode: newFeed.feedCode,
    };
  }

  // ==========================================================================
  // YARDIMCI METODLAR
  // ==========================================================================

  /**
   * Tank'in guncel durumunu (biomass, agirlik, sicaklik) getirir.
   */
  private async getTankCurrentState(
    tankId: string,
    tenantId: string,
    temperatureSensorId?: string,
  ): Promise<TankCurrentState | null> {
    // TankBatch'ten guncel durumu al
    const tankBatch = await this.tankBatchRepo.findOne({
      where: { tankId, tenantId },
    });

    if (!tankBatch) {
      this.logger.warn(
        `TankBatch not found for tank ${tankId}. Tank may not be properly configured or has no batch assigned.`,
      );
      return null;
    }

    if (tankBatch.totalQuantity === 0) {
      this.logger.warn(
        `Tank ${tankId} has zero fish count in TankBatch. Cannot generate feeding plan for empty tank.`,
      );
      return null;
    }

    // Tank bilgilerini al
    const tank = await this.tankRepo.findOne({
      where: { id: tankId, tenantId },
    });

    // Sicaklik okumasini al
    const temperatureResult = await this.getWaterTemperature(tankId, tenantId, temperatureSensorId);

    return {
      tankId,
      tankName: tankBatch.tankName ?? tank?.name ?? 'Unknown',
      tankCode: tankBatch.tankCode ?? tank?.code ?? 'UNK',
      // Derived from the unit aggregate (the same constructor the 06:00 cron and
      // the day-plan admin use) so this legacy engine reads the identical weight
      // the v2 engine bands on.
      avgWeightG: tankBandWeightG(tankBatch),
      fishCount: tankBatch.totalQuantity || 0,
      biomassKg: Number(tankBatch.totalBiomassKg) || 0,
      waterTempC: temperatureResult.value,
      usingDefaultTemperature: temperatureResult.isDefault,
      batchId: tankBatch.primaryBatchId,
    };
  }

  /**
   * The TANK's feeding-rate percent from the protocol assigned to it, or null
   * when the unit has no active assignment / the protocol has no band for this
   * weight (caller then keeps the feed matrix/curve rate).
   *
   * WHY the unit and not the batch: this used to read `batches_v2.protocolId`,
   * a v1 column with no writer in the entire repo. It therefore returned null
   * on every call — the "protocol precedence" this method promises never once
   * happened in production, and the daily plan quietly fed the matrix rate
   * while the 06:00 v2 engine fed the same tank from its assignment band. The
   * authority is `feeding_protocol_assignments.unitId`, one active row per unit
   * by partial unique index, which also matches the domain rule that the TANK
   * (not the batch) owns weight, band, feed type and rate. A consequence worth
   * naming: a tank with fish but no primary batch now resolves its protocol
   * too, where the batch-keyed version could not.
   */
  private async resolveProtocolRatePercent(
    tenantId: string,
    unitId: string,
    avgWeightG: BandWeightG,
    waterTempC: number | undefined,
  ): Promise<number | null> {
    const resolved = await this.unitProtocol.resolveForUnit(
      this.dataSource,
      tenantId,
      unitId,
      avgWeightG,
      // A DEFAULTED temperature must not scale the protocol rate — the caller
      // passes undefined in that case and it becomes an explicit "no reading".
      waterTempC ?? null,
    );
    return resolved ? resolved.effectiveRatePercent : null;
  }

  /**
   * Sensor service'den veya sensor_readings tablosundan sicaklik okur.
   * Bulunamazsa varsayilan deger doner.
   *
   * @returns Object containing temperature value and flag indicating if default was used
   */
  private async getWaterTemperature(
    tankId: string,
    tenantId: string,
    _sensorId?: string,
  ): Promise<{ value: number; isDefault: boolean }> {
    const DEFAULT_TEMP = 15.0;

    // Phase 2a: resolve via WaterTemperatureService (latest manual water-quality
    // measurement). Replaces the old cross-schema raw query, which was
    // prod-broken (farm_service has no grant on the `sensor` schema) and named
    // columns/tables that do not exist. `_sensorId` is reserved for Phase 2b,
    // when the sensor source resolves the tank's linked sensor reading through
    // the same service (a farm-side projection of the SensorReading event).
    const reading = await this.waterTemperatureService.getCurrentTemperature(tenantId, tankId);
    if (reading) {
      return { value: reading.celsius, isDefault: false };
    }

    this.logger.warn(
      `No water temperature on record for tank ${tankId}. Using default ${DEFAULT_TEMP}C; ` +
        `feeding calculations may be inaccurate until a measurement or sensor reading exists.`,
    );
    return { value: DEFAULT_TEMP, isDefault: true };
  }

  /**
   * Feeding curve'den agirliga uygun noktayi bulur (1D fallback).
   */
  private findFeedingCurvePoint(
    curve: { fishWeightG: number; feedingRatePercent: number; fcr: number }[],
    avgWeightG: number,
  ): { feedingRatePercent: number; fcr: number } | null {
    if (!curve || curve.length === 0) {
      return null;
    }

    // Agirliklara gore azalan sirada sirala
    const sorted = [...curve].sort((a, b) => b.fishWeightG - a.fishWeightG);

    // Mevcut agirliktan kucuk veya esit ilk noktayi bul
    const point = sorted.find((p) => avgWeightG >= p.fishWeightG);

    if (point) {
      return {
        feedingRatePercent: point.feedingRatePercent,
        fcr: point.fcr,
      };
    }

    // Bulunamazsa en kucuk agirliktaki noktayi don
    const smallest = sorted[sorted.length - 1];
    return smallest ? { feedingRatePercent: smallest.feedingRatePercent, fcr: smallest.fcr } : null;
  }

  /**
   * Program FCR tablosundan interpolasyon ile FCR degerini alir.
   */
  private getFCRFromProgramTable(
    fcrTable: {
      temperatures: number[];
      weights: number[];
      fcrValues: number[][];
    },
    temperature: number,
    weightG: number,
  ): number | null {
    // Validate fcrTable structure
    if (!fcrTable || !fcrTable.temperatures || !fcrTable.weights || !fcrTable.fcrValues) {
      this.logger.warn('FCR table is missing required properties');
      return null;
    }

    // Check if fcrValues arrays exist and have valid structure
    // Note: 0 is a valid FCR value, so we use explicit null/undefined checks
    if (fcrTable.fcrValues.length === 0) {
      this.logger.warn('FCR table has empty fcrValues array');
      return null;
    }

    // BilinearInterpolationService formatina cevir ve kullan
    const matrix = {
      temperatures: fcrTable.temperatures,
      weights: fcrTable.weights,
      rates: fcrTable.fcrValues, // FCR degerlerini rate olarak kullan
    };

    const validationResult = this.bilinearService.validateMatrix(matrix);
    if (!validationResult.valid) {
      this.logger.warn(`Invalid FCR table: ${validationResult.errors.join(', ')}`);
      return null;
    }

    const result = this.bilinearService.interpolate(matrix, temperature, weightG);
    // feedingRatePercent in this context is the FCR value
    // Note: 0 could be a valid interpolation result (though unusual for FCR),
    // so we use explicit null check instead of falsy check
    if (result.feedingRatePercent === null || result.feedingRatePercent === undefined) {
      return null;
    }
    return result.feedingRatePercent;
  }

  /**
   * Gunluk yem miktarini hesaplar.
   */
  private calculateDailyFeedAmount(biomassKg: number, feedingRatePercent: number): number {
    // Use explicit zero checks instead of falsy check to avoid
    // short-circuiting on biomassKg === 0 (which is a valid but abnormal state)
    if (biomassKg <= 0 || feedingRatePercent <= 0) {
      if (biomassKg === 0) {
        this.logger.warn(
          'calculateDailyFeedAmount called with biomassKg=0 — possible data entry error',
        );
      }
      return 0;
    }
    // 2 ondalik basamaga yuvarla
    return Math.round(((biomassKg * feedingRatePercent) / 100) * 100) / 100;
  }

  /**
   * Yem gecisine kalan tahmini gun sayisini hesaplar.
   */
  private estimateDaysToTransition(
    currentWeightG: number,
    targetWeightG: number,
    fcr: number,
    dailyFeedKg: number,
    fishCount: number,
  ): number {
    if (currentWeightG >= targetWeightG || fishCount <= 0 || dailyFeedKg <= 0) {
      return 0;
    }

    // Gunluk buyume tahmini: dailyGrowthKg = dailyFeedKg / fcr
    const dailyGrowthKg = dailyFeedKg / fcr;
    const dailyGrowthPerFishG = (dailyGrowthKg / fishCount) * 1000;

    if (dailyGrowthPerFishG <= 0) {
      return 999; // Cok uzun sure
    }

    const weightGap = targetWeightG - currentWeightG;
    return Math.ceil(weightGap / dailyGrowthPerFishG);
  }

  // ==========================================================================
  // SORGULAMA METODLARI
  // ==========================================================================

  /**
   * Belirli bir tarih ve program icin tum execution'lari getirir.
   */
  async getExecutionsForDate(
    programId: string,
    date: Date,
    tenantId: string,
  ): Promise<DailyFeedingExecution[]> {
    return this.executionRepo.find({
      where: {
        feedingProgramId: programId,
        executionDate: date,
        tenantId,
      },
      order: {
        equipmentCode: 'ASC',
      },
    });
  }

  /**
   * Tek bir execution'i ID ile getirir.
   */
  async getExecutionById(
    executionId: string,
    tenantId: string,
  ): Promise<DailyFeedingExecution | null> {
    return this.executionRepo.findOne({
      where: { id: executionId, tenantId },
      relations: ['feedingProgram', 'feedingProgramTank'],
    });
  }

  /**
   * Tamamlanmamis (PLANNED veya IN_PROGRESS) execution'lari getirir.
   */
  async getPendingExecutions(
    programId: string,
    tenantId: string,
  ): Promise<DailyFeedingExecution[]> {
    return this.executionRepo.find({
      where: [
        { feedingProgramId: programId, tenantId, status: ExecutionStatus.PLANNED },
        { feedingProgramId: programId, tenantId, status: ExecutionStatus.IN_PROGRESS },
      ],
      order: {
        executionDate: 'ASC',
        equipmentCode: 'ASC',
      },
    });
  }
}
