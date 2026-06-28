/**
 * RecordCleanerMortalityHandler
 *
 * RecordCleanerMortalityCommand'ı işler ve cleaner fish ölüm kaydı oluşturur.
 *
 * @module Batch/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { toEventIso,
  createBaseEvent,
  MORTALITY_REASONS,
  type CleanerFishMortalityRecordedEvent,
  type MortalityReasonCode,
} from '@platform/event-contracts';
import { RecordCleanerMortalityCommand } from '../commands/record-cleaner-mortality.command';
import { Batch, BatchType } from '../entities/batch.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { TankOperation, OperationType, MortalityReason } from '../entities/tank-operation.entity';
import { isMortalityReason } from '../entities/tank-operation.enums';
import { MortalityRecord, MortalityCause } from '../entities/mortality-record.entity';
import { MortalityCullPolicyService } from '../services/mortality-cull-policy.service';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { Species } from '../../species/entities/species.entity';

/**
 * Normalise the command-layer mortality reason (lower-snake) to the
 * `MortalityReasonCode` (UPPER_SNAKE) used on the domain-event
 * contract. Falls back to `UNKNOWN` if the caller supplies a reason
 * that isn't in the enumerated set — never throws; event emission
 * must not be blocked by an invalid enum label on the input side,
 * and the TankOperation `mortalityReason` column stores the raw
 * input anyway.
 */
function toMortalityReasonCode(reason: string): MortalityReasonCode {
  const upper = reason.toUpperCase();
  return (MORTALITY_REASONS as readonly string[]).includes(upper)
    ? (upper as MortalityReasonCode)
    : 'UNKNOWN';
}

@Injectable()
@CommandHandler(RecordCleanerMortalityCommand)
export class RecordCleanerMortalityHandler implements ICommandHandler<RecordCleanerMortalityCommand, Batch> {
  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(TankOperation)
    private readonly operationRepository: Repository<TankOperation>,
    @InjectRepository(MortalityRecord)
    private readonly mortalityRepository: Repository<MortalityRecord>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly mortalityCullPolicy: MortalityCullPolicyService,
  ) {}

  async execute(command: RecordCleanerMortalityCommand): Promise<Batch> {
    const { tenantId, payload, recordedBy } = command;

    // Cleaner batch'i bul
    const cleanerBatch = await this.batchRepository.findOne({
      where: { id: payload.cleanerBatchId, tenantId, isActive: true },
    });

    if (!cleanerBatch) {
      throw new NotFoundException(`Cleaner batch ${payload.cleanerBatchId} bulunamadı`);
    }

    if (cleanerBatch.batchType !== BatchType.CLEANER_FISH) {
      throw new BadRequestException(
        `Batch ${cleanerBatch.batchNumber} bir cleaner fish batch'i değil`
      );
    }

    this.mortalityCullPolicy.assertStockMutable(cleanerBatch);
    this.mortalityCullPolicy.assertQuantityWithinCurrent({
      operation: 'Mortality',
      quantity: payload.quantity,
      currentQuantity: cleanerBatch.currentQuantity,
    });

    // Tank'ı bul (Equipment entity)
    const tank = await this.equipmentRepository.findOne({
      where: { id: payload.tankId, tenantId, isActive: true },
    });

    if (!tank) {
      throw new NotFoundException(`Tank ${payload.tankId} bulunamadı`);
    }

    // TankBatch'i bul
    const tankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId: payload.tankId },
    });

    if (!tankBatch) {
      throw new NotFoundException(`Tank ${payload.tankId} için TankBatch kaydı bulunamadı`);
    }

    // Bu batch tankta var mı kontrol et
    const cleanerDetails = tankBatch.cleanerFishDetails || [];
    const batchDetailIndex = cleanerDetails.findIndex(
      (d) => d.batchId === cleanerBatch.id
    );

    if (batchDetailIndex < 0) {
      throw new BadRequestException(
        `Cleaner batch ${cleanerBatch.batchNumber} bu tankta bulunmuyor`
      );
    }

    const batchDetail = cleanerDetails[batchDetailIndex]!;

    // Miktar kontrolü
    if (payload.quantity > batchDetail.quantity) {
      throw new BadRequestException(
        `Mortality miktarı (${payload.quantity}) tanktaki cleaner fish miktarından (${batchDetail.quantity}) fazla olamaz`
      );
    }
    this.mortalityCullPolicy.assertAggregateWithinInitial({
      batch: cleanerBatch,
      addedRemoval: payload.quantity,
    });

    // Species bilgisini al
    const species = await this.speciesRepository.findOne({
      where: { id: cleanerBatch.speciesId, tenantId },
    });

    const speciesName = species?.commonName || 'Unknown Cleaner Fish';

    // Biomass hesapla
    const avgWeightG = batchDetail.avgWeightG;
    const biomassKg = (payload.quantity * avgWeightG) / 1000;

    // Pre-operation state kaydet
    const preOperationState = {
      quantity: tankBatch.cleanerFishQuantity || 0,
      biomassKg: Number(tankBatch.cleanerFishBiomassKg || 0),
      densityKgM3: Number(tankBatch.densityKgM3 || 0),
    };

    // TankBatch cleaner fish detaylarını güncelle
    batchDetail.quantity -= payload.quantity;
    batchDetail.biomassKg -= biomassKg;

    // Mortality tracking için initialQuantity ayarla (eğer yoksa şimdiki değer + mortality)
    if (!batchDetail.initialQuantity) {
      batchDetail.initialQuantity = batchDetail.quantity + payload.quantity;
    }

    // Mortality bilgilerini güncelle
    batchDetail.totalMortality = (batchDetail.totalMortality || 0) + payload.quantity;
    batchDetail.mortalityRate = batchDetail.initialQuantity > 0
      ? (batchDetail.totalMortality / batchDetail.initialQuantity) * 100
      : 0;
    batchDetail.lastMortalityAt = payload.observedAt;

    // Eğer miktar sıfır olduysa batch detayını kaldır
    if (batchDetail.quantity <= 0) {
      cleanerDetails.splice(batchDetailIndex, 1);
    } else {
      cleanerDetails[batchDetailIndex] = batchDetail;
    }

    tankBatch.cleanerFishDetails = cleanerDetails;
    tankBatch.cleanerFishQuantity = Math.max(0, (tankBatch.cleanerFishQuantity || 0) - payload.quantity);
    tankBatch.cleanerFishBiomassKg = Math.max(0, Number(tankBatch.cleanerFishBiomassKg || 0) - biomassKg);
    tankBatch.lastMortalityAt = payload.observedAt;

    // Tank yoğunluğunu güncelle
    const tankVolume = tank.volume || 0;
    if (tankVolume > 0) {
      const totalBiomass = Number(tankBatch.totalBiomassKg || 0) + Number(tankBatch.cleanerFishBiomassKg);
      tankBatch.densityKgM3 = totalBiomass / Number(tankVolume);
    }

    // Cleaner batch mortality güncelle
    cleanerBatch.totalMortality += payload.quantity;
    cleanerBatch.mortalitySummary = {
      ...cleanerBatch.mortalitySummary,
      totalMortality: cleanerBatch.totalMortality,
      mortalityRate: (cleanerBatch.totalMortality / cleanerBatch.initialQuantity) * 100,
      lastMortalityAt: payload.observedAt,
      mainCause: payload.reason,
    };
    cleanerBatch.updatedBy = recordedBy;

    // MortalityRecord oluştur
    const causeMapping: Record<string, MortalityCause> = {
      disease: MortalityCause.DISEASE,
      water_quality: MortalityCause.WATER_QUALITY,
      stress: MortalityCause.STRESS,
      handling: MortalityCause.HANDLING,
      temperature: MortalityCause.TEMPERATURE,
      oxygen: MortalityCause.OXYGEN,
      unknown: MortalityCause.UNKNOWN,
      other: MortalityCause.OTHER,
    };
    const mortalityRecord = this.mortalityRepository.create({
      tenantId,
      batchId: cleanerBatch.id,
      tankId: payload.tankId,
      recordDate: payload.observedAt,
      count: payload.quantity,
      estimatedBiomassLoss: biomassKg,
      cause: causeMapping[payload.reason] || MortalityCause.UNKNOWN,
      causeDetail: payload.detail,
      recordedBy,
      notes: payload.notes,
    });

    // TankOperation kaydı oluştur
    const operation = this.operationRepository.create({
      tenantId,
      tankId: payload.tankId,
      tankName: tank.name,
      tankCode: tank.code,
      batchId: cleanerBatch.id,
      batchNumber: cleanerBatch.batchNumber,
      operationType: OperationType.CLEANER_MORTALITY,
      operationDate: payload.observedAt,
      quantity: payload.quantity,
      avgWeightG,
      biomassKg,
      // FARM-MEDIUM-052 parity: validate against the SSoT enum (an unknown value
      // falls back to OTHER) instead of an unchecked cast onto MortalityReason.
      mortalityReason: isMortalityReason(payload.reason) ? payload.reason : MortalityReason.OTHER,
      mortalityDetail: payload.detail,
      isCleanerFishOperation: true,
      cleanerSpeciesName: speciesName,
      cleanerBatchId: cleanerBatch.id,
      preOperationState,
      postOperationState: {
        quantity: tankBatch.cleanerFishQuantity,
        biomassKg: Number(tankBatch.cleanerFishBiomassKg),
        densityKgM3: Number(tankBatch.densityKgM3),
      },
      notes: payload.notes,
      performedBy: recordedBy,
      isDeleted: false,
    });

    // All saves + outbox enqueue in a single transaction. Welfare
    // alerting (species-specific mortality-rate thresholds) + Mattilsynet
    // compliance tooling consume this event; skipping it on a successful
    // write would leave ops blind to rate-of-loss trends.
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      await queryRunner.manager.save(TankBatch, tankBatch);
      await queryRunner.manager.save(Batch, cleanerBatch);
      await queryRunner.manager.save(MortalityRecord, mortalityRecord);
      await queryRunner.manager.save(TankOperation, operation);

      const newRate =
        cleanerBatch.initialQuantity > 0
          ? (cleanerBatch.totalMortality / cleanerBatch.initialQuantity) * 100
          : 0;
      const event: CleanerFishMortalityRecordedEvent = {
        ...createBaseEvent<CleanerFishMortalityRecordedEvent>(
          'CleanerFishMortalityRecorded',
          tenantId,
          { aggregateId: cleanerBatch.id, aggregateType: 'Batch' },
        ),
        cleanerBatchId: cleanerBatch.id,
        tankId: payload.tankId,
        speciesName,
        quantity: payload.quantity,
        biomassKg,
        reason: toMortalityReasonCode(payload.reason),
        detail: payload.detail,
        observedAt: toEventIso(payload.observedAt),
        newTankCleanerFishQuantity: tankBatch.cleanerFishQuantity ?? 0,
        newTankCleanerFishBiomassKg: Number(tankBatch.cleanerFishBiomassKg ?? 0),
        newCleanerBatchTotalMortality: cleanerBatch.totalMortality,
        newCleanerBatchMortalityRate: newRate,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager);

      return cleanerBatch;
    });
  }
}
