/**
 * DeployCleanerFishHandler
 *
 * DeployCleanerFishCommand'ı işler ve cleaner fish'i bir tanka yerleştirir.
 *
 * @module Batch/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import {
  toEventIso,
  createBaseEvent,
  type CleanerFishDeployedEvent,
} from '@platform/event-contracts';
import { DeployCleanerFishCommand } from '../commands/deploy-cleaner-fish.command';
import { Batch, BatchType } from '../entities/batch.entity';
import { TankBatch, CleanerFishDetail } from '../entities/tank-batch.entity';
import { TankOperation, OperationType } from '../entities/tank-operation.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { Species } from '../../species/entities/species.entity';
import { TankCapacityService } from '../../tank/services/tank-capacity.service';
import { BatchAggregateMutationPort } from '../batch-aggregate-mutation.port';

@Injectable()
@CommandHandler(DeployCleanerFishCommand)
export class DeployCleanerFishHandler implements ICommandHandler<DeployCleanerFishCommand, Batch> {
  constructor(
    private readonly batchMutations: BatchAggregateMutationPort,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(TankOperation)
    private readonly operationRepository: Repository<TankOperation>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
    private readonly tankCapacityService: TankCapacityService,
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: DeployCleanerFishCommand): Promise<Batch> {
    const { tenantId, payload, deployedBy } = command;

    // Cleaner batch'i bul
    const cleanerBatch = await this.batchRepository.findOne({
      where: { id: payload.cleanerBatchId, tenantId, isActive: true },
    });

    if (!cleanerBatch) {
      throw new NotFoundException(`Cleaner batch ${payload.cleanerBatchId} bulunamadı`);
    }

    if (cleanerBatch.batchType !== BatchType.CLEANER_FISH) {
      throw new BadRequestException(
        `Batch ${cleanerBatch.batchNumber} bir cleaner fish batch'i değil`,
      );
    }

    // Miktar kontrolü
    if (payload.quantity > cleanerBatch.currentQuantity) {
      throw new BadRequestException(
        `Deploy miktarı (${payload.quantity}) mevcut miktardan (${cleanerBatch.currentQuantity}) fazla olamaz`,
      );
    }

    // Hedef tank'ı bul (Equipment entity)
    const targetTank = await this.equipmentRepository.findOne({
      where: { id: payload.targetTankId, tenantId, isActive: true },
    });

    if (!targetTank) {
      throw new NotFoundException(`Tank ${payload.targetTankId} bulunamadı`);
    }

    // Species bilgisini al
    const species = await this.speciesRepository.findOne({
      where: { id: cleanerBatch.speciesId, tenantId },
    });

    const speciesName = species?.commonName || 'Unknown Cleaner Fish';

    // Ağırlık ve biomass hesapla
    const avgWeightG = payload.avgWeightG || cleanerBatch.getCurrentAvgWeight();
    const biomassKg = (payload.quantity * avgWeightG) / 1000;

    // TankBatch'i bul veya oluştur
    let tankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId: payload.targetTankId },
    });

    // ── WELFARE GATE: tank density/capacity check ──────────────────────
    //
    // Welfare invariant (Mattilsynet fish welfare regulation): a tank
    // cannot be stocked beyond its configured maxDensity without risking
    // fish welfare violations. Before this check, deployCleanerFish
    // silently wrote `isOverCapacity: false` into a fresh TankBatch and
    // never consulted the tank's specs — docs/illustrator/ Girdi 15-B15.
    //
    // Hard mode: deploying into an already-stocked tank is an additive
    // operation, so we block over-capacity deploys entirely.
    const capacity = this.tankCapacityService.enforce({
      mode: 'hard',
      equipment: targetTank,
      existing: {
        salmonBiomassKg: Number(tankBatch?.totalBiomassKg ?? 0),
        cleanerBiomassKg: Number(tankBatch?.cleanerFishBiomassKg ?? 0),
      },
      incomingBiomassKg: biomassKg,
    });

    if (!tankBatch) {
      // TankBatch yoksa oluştur (sadece cleaner fish ile).
      // capacity.isOverCapacity will be false here because enforce()
      // would have thrown before reaching this branch if the projected
      // density exceeded maxDensity — keeping the flag consistent with
      // the density-based invariant rather than hard-coded false.
      tankBatch = this.tankBatchRepository.create({
        tenantId,
        tankId: payload.targetTankId,
        tankName: targetTank.name,
        tankCode: targetTank.code,
        totalQuantity: 0,
        totalBiomassKg: 0,
        avgWeightG: 0,
        densityKgM3: 0,
        cleanerFishQuantity: 0,
        cleanerFishBiomassKg: 0,
        cleanerFishDetails: [],
        isMixedBatch: false,
        isOverCapacity: capacity.isOverCapacity,
      });
    }

    // Pre-operation state kaydet
    const preOperationState = {
      quantity: tankBatch.cleanerFishQuantity || 0,
      biomassKg: Number(tankBatch.cleanerFishBiomassKg || 0),
      densityKgM3: Number(tankBatch.densityKgM3 || 0),
    };

    // Cleaner fish detaylarını güncelle
    const existingDetails = tankBatch.cleanerFishDetails || [];
    const existingDetailIndex = existingDetails.findIndex((d) => d.batchId === cleanerBatch.id);

    const newDetail: CleanerFishDetail = {
      batchId: cleanerBatch.id,
      batchNumber: cleanerBatch.batchNumber,
      speciesId: cleanerBatch.speciesId,
      speciesName,
      quantity: payload.quantity,
      initialQuantity: payload.quantity, // İlk deploy miktarını kaydet
      avgWeightG,
      biomassKg,
      sourceType: cleanerBatch.sourceType as 'farmed' | 'wild_caught',
      deployedAt: payload.deployedAt,
      totalMortality: 0, // Başlangıçta mortality 0
      mortalityRate: 0,
    };

    if (existingDetailIndex >= 0) {
      // Mevcut batch'e ekle
      const existingDetail = existingDetails[existingDetailIndex]!;
      existingDetail.quantity += payload.quantity;
      existingDetail.biomassKg += biomassKg;
      // initialQuantity'yi de güncelle (ek deployment)
      existingDetail.initialQuantity = (existingDetail.initialQuantity || 0) + payload.quantity;
      // Mortality rate yeniden hesapla (eğer mortality varsa)
      if (existingDetail.totalMortality && existingDetail.initialQuantity > 0) {
        existingDetail.mortalityRate =
          (existingDetail.totalMortality / existingDetail.initialQuantity) * 100;
      }
    } else {
      // Yeni kayıt ekle
      existingDetails.push(newDetail);
    }

    tankBatch.cleanerFishDetails = existingDetails;
    tankBatch.cleanerFishQuantity = (tankBatch.cleanerFishQuantity || 0) + payload.quantity;
    tankBatch.cleanerFishBiomassKg = Number(tankBatch.cleanerFishBiomassKg || 0) + biomassKg;

    // Tank yoğunluğunu güncelle
    const tankVolume = targetTank.volume || 0;
    if (tankVolume > 0) {
      const totalBiomass =
        Number(tankBatch.totalBiomassKg || 0) + Number(tankBatch.cleanerFishBiomassKg);
      tankBatch.densityKgM3 = totalBiomass / Number(tankVolume);
    }

    // Cleaner batch miktarını düşür
    cleanerBatch.currentQuantity -= payload.quantity;
    cleanerBatch.updatedBy = deployedBy;

    // TankOperation kaydı oluştur
    const operation = this.operationRepository.create({
      tenantId,
      tankId: payload.targetTankId,
      tankName: targetTank.name,
      tankCode: targetTank.code,
      batchId: cleanerBatch.id,
      batchNumber: cleanerBatch.batchNumber,
      operationType: OperationType.CLEANER_DEPLOYMENT,
      operationDate: payload.deployedAt,
      quantity: payload.quantity,
      avgWeightG,
      biomassKg,
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
      performedBy: deployedBy,
      isDeleted: false,
    });

    // All saves + outbox enqueue in a single transaction so the
    // `CleanerFishDeployed` event never fires without the domain
    // writes landing, and the domain never commits without its event
    // enqueued. OutboxWorker publishes to NATS asynchronously with
    // retry + dead-letter.
    return runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner, mutationSession) => {
        await this.batchMutations.commitTankBatchTransition(mutationSession, {
          intent: 'cleaner_fish_deployed',
          aggregate: tankBatch,
        });
        await this.batchMutations.commitBatchTransition(mutationSession, {
          intent: 'cleaner_fish_deployed',
          aggregate: cleanerBatch,
        });
        await queryRunner.manager.save(TankOperation, operation);

        const event: CleanerFishDeployedEvent = {
          ...createBaseEvent<CleanerFishDeployedEvent>('CleanerFishDeployed', tenantId, {
            aggregateId: cleanerBatch.id,
            aggregateType: 'Batch',
          }),
          cleanerBatchId: cleanerBatch.id,
          targetTankId: payload.targetTankId,
          speciesName,
          quantity: payload.quantity,
          avgWeightG,
          biomassKg,
          deployedAt: toEventIso(payload.deployedAt),
          newTankCleanerFishQuantity: tankBatch.cleanerFishQuantity ?? 0,
          newTankCleanerFishBiomassKg: Number(tankBatch.cleanerFishBiomassKg ?? 0),
          newTankDensityKgM3: Number(tankBatch.densityKgM3 ?? 0),
          newCleanerBatchCurrentQuantity: cleanerBatch.currentQuantity,
          isOverCapacity: capacity.isOverCapacity,
        };
        await this.outboxPublisher.enqueue(event, queryRunner.manager);

        return cleanerBatch;
      },
    );
  }
}
