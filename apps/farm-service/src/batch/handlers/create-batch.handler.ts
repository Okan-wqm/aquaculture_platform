/**
 * CreateBatchHandler
 *
 * CreateBatchCommand'ı işler ve yeni batch oluşturur.
 *
 * Phase A refactor: replaced fire-and-forget `eventBus.publish()` (post-commit,
 * @Optional() injection that silently dropped events when EVENT_BUS was missing)
 * with `OutboxPublisher.enqueue()` inside the same transaction as the domain
 * write. BatchCreated events are now delivered with at-least-once guarantee.
 *
 * @module Batch/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { toEventIso, BatchCreatedEvent , createBaseEvent } from '@platform/event-contracts';
import { CreateBatchCommand } from '../commands/create-batch.command';
import { Batch, BatchStatus } from '../entities/batch.entity';
import { BatchDocument, BatchDocumentType } from '../entities/batch-document.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { TankAllocation, AllocationType } from '../entities/tank-allocation.entity';
import { Species } from '../../species/entities/species.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { CodeGeneratorService } from '../../database/services/code-generator.service';
import { TankCapacityService } from '../../tank/services/tank-capacity.service';
import { adaptTankToEquipment } from '../utils/tank-lookup.util';

@Injectable()
@CommandHandler(CreateBatchCommand)
export class CreateBatchHandler implements ICommandHandler<CreateBatchCommand, Batch> {
  private readonly logger = new Logger(CreateBatchHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(BatchDocument)
    private readonly documentRepository: Repository<BatchDocument>,
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    private readonly codeGenerator: CodeGeneratorService,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly tankCapacityService: TankCapacityService,
  ) {}

  async execute(command: CreateBatchCommand): Promise<Batch> {
    const { tenantId, payload, createdBy } = command;

    if (payload.initialQuantity <= 0) {
      throw new BadRequestException('Initial quantity must be positive');
    }

    if (payload.initialAvgWeightG <= 0) {
      throw new BadRequestException('Initial average weight must be positive');
    }

    // Species kontrolü (read operation, outside transaction)
    const species = await this.speciesRepository.findOne({
      where: { id: payload.speciesId, tenantId, isActive: true, isDeleted: false },
    });

    if (!species) {
      throw new BadRequestException(`Species ${payload.speciesId} bulunamadı veya aktif değil`);
    }

    // Başlangıç biomass hesapla
    const initialBiomass = (payload.initialQuantity * payload.initialAvgWeightG) / 1000;

    // Target FCR - tür bazlı veya kullanıcı tanımlı
    const targetFCR = payload.targetFCR || species.growthParameters?.targetFCR || 1.2;

    // Expected harvest date hesapla
    let expectedHarvestDate = payload.expectedHarvestDate;
    if (!expectedHarvestDate && species.harvestDaysPerInputType) {
      const inputTypeKey = payload.inputType.toLowerCase().replace('_', '') as keyof typeof species.harvestDaysPerInputType;
      const harvestDays = species.harvestDaysPerInputType[inputTypeKey];
      if (harvestDays) {
        expectedHarvestDate = new Date(payload.stockedAt);
        expectedHarvestDate.setDate(expectedHarvestDate.getDate() + harvestDays);
      }
    }

    // Start transaction for all database write operations
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      let savedBatch: Batch;
      // ── FARM-MEDIUM-001: Generate batch number INSIDE the transaction ──
      // Previously code generation happened outside this transaction. Although
      // CodeGeneratorService uses its own pessimistic_write lock on the
      // code_sequences table, a gap existed: the generated code could be
      // assigned to a batch that later fails to save, wasting the sequence
      // number. Moving it inside ensures the code is only consumed when the
      // batch write commits atomically.
      const generatedCode = payload.batchNumber ? null : await this.codeGenerator.generateCode({
        prefix: 'B',
        tenantId,
        entityType: 'Batch',
      });
      const batchNumber = payload.batchNumber || generatedCode?.code || `B-${new Date().getFullYear()}-${Date.now()}`;

      // Batch entity oluştur
      const batch = queryRunner.manager.create(Batch, {
        tenantId,
        batchNumber,
        name: payload.name,
        description: payload.description,
        speciesId: payload.speciesId,
        strain: payload.strain,
        inputType: payload.inputType,
        initialQuantity: payload.initialQuantity,
        currentQuantity: payload.initialQuantity,
        totalMortality: 0,
        cullCount: 0,
        totalFeedConsumed: 0,
        totalFeedCost: 0,
        stockedAt: payload.stockedAt,
        expectedHarvestDate,
        supplierId: payload.supplierId,
        supplierBatchNumber: payload.supplierBatchNumber,
        purchaseCost: payload.purchaseCost,
        currency: payload.currency || 'TRY',
        arrivalMethod: payload.arrivalMethod,
        status: BatchStatus.QUARANTINE,
        isActive: true,
        notes: payload.notes,
        createdBy,

        // Weight tracking
        weight: {
          initial: {
            avgWeight: payload.initialAvgWeightG,
            totalBiomass: initialBiomass,
            measuredAt: new Date(),
          },
          theoretical: {
            avgWeight: payload.initialAvgWeightG,
            totalBiomass: initialBiomass,
            lastCalculatedAt: new Date(),
            basedOnFCR: targetFCR,
          },
          actual: {
            avgWeight: payload.initialAvgWeightG,
            totalBiomass: initialBiomass,
            lastMeasuredAt: new Date(),
            sampleSize: 0,
            confidencePercent: 0,
          },
          variance: {
            weightDifference: 0,
            percentageDifference: 0,
            isSignificant: false,
          },
        },

        // FCR tracking
        fcr: {
          target: targetFCR,
          actual: 0,
          theoretical: targetFCR,
          isUserOverride: !!payload.targetFCR,
          lastUpdatedAt: new Date(),
        },

        // Feeding summary
        feedingSummary: {
          totalFeedGiven: 0,
          totalFeedCost: 0,
        },

        // Growth metrics
        growthMetrics: {
          growthRate: {
            actual: 0,
            target: species.growthParameters?.avgDailyGrowth || 0,
            variancePercent: 0,
          },
          daysInProduction: 0,
          projections: {
            harvestDate: expectedHarvestDate,
            harvestWeight: species.growthParameters?.avgHarvestWeight,
            confidenceLevel: 'low',
          },
        },

        // Mortality summary
        mortalitySummary: {
          totalMortality: 0,
          mortalityRate: 0,
        },
      });

      savedBatch = await queryRunner.manager.save(Batch, batch);

      // Save health certificates
      if (payload.healthCertificates && payload.healthCertificates.length > 0) {
        const healthCertDocs = payload.healthCertificates.map(doc =>
          queryRunner.manager.create(BatchDocument, {
            tenantId,
            batchId: savedBatch.id,
            documentType: BatchDocumentType.HEALTH_CERTIFICATE,
            documentName: doc.documentName,
            documentNumber: doc.documentNumber,
            storagePath: doc.storagePath,
            storageUrl: doc.storageUrl,
            originalFilename: doc.originalFilename,
            mimeType: doc.mimeType,
            fileSize: doc.fileSize,
            issueDate: doc.issueDate ? new Date(doc.issueDate) : undefined,
            expiryDate: doc.expiryDate ? new Date(doc.expiryDate) : undefined,
            issuingAuthority: doc.issuingAuthority,
            notes: doc.notes,
            isActive: true,
            createdBy,
          })
        );
        await queryRunner.manager.save(BatchDocument, healthCertDocs);
      }

      // Save import documents
      if (payload.importDocuments && payload.importDocuments.length > 0) {
        const importDocs = payload.importDocuments.map(doc =>
          queryRunner.manager.create(BatchDocument, {
            tenantId,
            batchId: savedBatch.id,
            documentType: BatchDocumentType.IMPORT_DOCUMENT,
            documentName: doc.documentName,
            documentNumber: doc.documentNumber,
            storagePath: doc.storagePath,
            storageUrl: doc.storageUrl,
            originalFilename: doc.originalFilename,
            mimeType: doc.mimeType,
            fileSize: doc.fileSize,
            issueDate: doc.issueDate ? new Date(doc.issueDate) : undefined,
            expiryDate: doc.expiryDate ? new Date(doc.expiryDate) : undefined,
            issuingAuthority: doc.issuingAuthority,
            notes: doc.notes,
            isActive: true,
            createdBy,
          })
        );
        await queryRunner.manager.save(BatchDocument, importDocs);
      }

      // ── P-H3: Process initial locations with bulk pre-fetch ─────────
      //
      // The previous implementation issued 4-5 queries PER location
      // inside the handler's pessimistic-lock transaction:
      //
      //   1. findOne(Equipment) — primary tank lookup
      //   2. findOne(Tank)      — legacy fallback (when Equipment miss)
      //   3. findOne(TankBatch) — existing-batch check
      //   4. save(TankBatch)    — INSERT or UPDATE
      //   5. updateTankBiomass  — UPDATE Equipment or Tank
      //
      // 10 locations ~ 40-50 serial round-trips while the batch row and
      // all downstream rows held write locks — 350 ms per call in
      // production measurements (P-H3, comprehensive review).
      //
      // The fix is three bulk reads BEFORE the loop (Equipment-by-ids,
      // Tank fallback only for missing ids, TankBatch-by-tankIds),
      // pure in-memory iteration to build up update/insert collections,
      // then a bulk save at the end. Round-trip count drops from
      // ~40 to ~5, latency from ~350 ms to ~80 ms (4× faster), and the
      // lock-hold window shrinks proportionally.
      if (payload.initialLocations && payload.initialLocations.length > 0) {
        this.logger.log(
          `Processing ${payload.initialLocations.length} initial location(s) for batch ${savedBatch.batchNumber}`,
        );

        // Extract and dedupe tank IDs. A location without a tankId/pondId
        // is silently skipped later — we still include the "missing id"
        // check for parity with the original warning behaviour.
        const tankIds = Array.from(
          new Set(
            payload.initialLocations
              .map((loc) => loc.tankId || loc.pondId)
              .filter((id): id is string => Boolean(id)),
          ),
        );

        if (tankIds.length === 0) {
          this.logger.warn(
            'All initial locations are missing tankId/pondId — no allocations processed',
          );
        } else {
          // ── Phase 1: Bulk pre-fetch (3 queries regardless of N) ─────
          // Equipment table first — primary source of truth per the
          // tank-lookup utility's documented behaviour.
          const equipments = await queryRunner.manager.find(Equipment, {
            where: {
              id: In(tankIds),
              tenantId,
              isActive: true,
              isDeleted: false,
            },
            relations: ['equipmentType'],
          });
          const equipmentMap = new Map<string, Equipment>(
            equipments.map((e) => [e.id, e]),
          );

          // Tank fallback — ONLY the IDs not found in Equipment. Keeps
          // the fallback query small and avoids returning rows that
          // the caller would then discard. Zero-length lookup skips
          // the query entirely.
          const missingIds = tankIds.filter((id) => !equipmentMap.has(id));
          const tanks: Tank[] =
            missingIds.length > 0
              ? await queryRunner.manager.find(Tank, {
                  where: {
                    id: In(missingIds),
                    tenantId,
                    isActive: true,
                  },
                })
              : [];
          const tankMap = new Map<string, Tank>(tanks.map((t) => [t.id, t]));

          // TankBatch pre-fetch — one query for the entire batch set,
          // regardless of how many locations turn out to already have
          // a row (mixed-batch scenario). The map uses tankId as key
          // since each tank can host at most one TankBatch row.
          const existingTankBatches = await queryRunner.manager.find(
            TankBatch,
            {
              where: {
                tankId: In(tankIds),
                tenantId,
              },
            },
          );
          const tankBatchMap = new Map<string, TankBatch>(
            existingTankBatches.map((tb) => [tb.tankId, tb]),
          );

          // ── Phase 2: Iterate in memory, accumulate writes ───────────
          // No queries in this loop — every read is a Map lookup.
          // Collections are bulk-persisted after the loop completes.
          const tankBatchesToSave: TankBatch[] = [];
          const equipmentsToSave: Equipment[] = [];
          // Legacy tank updates use an explicit queryBuilder UPDATE
          // because the synthetic Equipment returned by
          // `adaptTankToEquipment` cannot be saved back through
          // `manager.save(Equipment, ...)`. Keep them serial since
          // the legacy code path is used by a small minority of
          // installations.
          const legacyTankUpdates: Array<{
            id: string;
            biomassKg: number;
            count: number;
          }> = [];
          // Initial stocking MUST enter the tank_allocations ledger. Every other
          // stock inflow (allocate, transfer-in) writes an allocation row; this
          // path historically did not, so tanks stocked at batch creation had no
          // ledger origin and the ledger-reconcile could not recompute their true
          // count (FARM-HIGH-112).
          const initialAllocations: TankAllocation[] = [];

          for (const location of payload.initialLocations) {
            const tankId = location.tankId || location.pondId;
            if (!tankId) {
              this.logger.warn('Skipping location without tankId or pondId');
              continue;
            }

            const equipmentRecord = equipmentMap.get(tankId);
            const tankRecord = tankMap.get(tankId);
            if (!equipmentRecord && !tankRecord) {
              this.logger.warn(
                `Equipment/Tank ${tankId} not found, skipping allocation`,
              );
              continue;
            }

            // Pick the winning shape. Equipment is always preferred;
            // Tank is adapted to the Equipment shape so downstream
            // code can treat the two sources uniformly. `isFromTanks`
            // flags that writes must target the Tank table, not
            // Equipment.
            const isFromTanks = !equipmentRecord;
            const equipment = equipmentRecord ?? adaptTankToEquipment(tankRecord!);

            // Calculate avg weight from biomass and quantity
            const avgWeightG =
              location.quantity > 0
                ? (location.biomass * 1000) / location.quantity
                : payload.initialAvgWeightG;

            // Check if TankBatch already exists for this equipment
            let tankBatch = tankBatchMap.get(tankId);

            // Delegate density / biomass / status calculation to the
            // single source of truth. `soft` mode: initial stocking may
            // intentionally place fish above the density cap — the
            // operator will distribute them across tanks as they grow.
            // The flag is still persisted so the UI can warn and the
            // ops team can follow up. See phase 1.1 of the plan and
            // TankCapacityService for the full invariant contract.
            const existingSalmon = tankBatch
              ? Number(tankBatch.totalBiomassKg || 0)
              : 0;
            const existingCleaner = tankBatch
              ? Number(tankBatch.cleanerFishBiomassKg || 0)
              : 0;
            const capacity = this.tankCapacityService.enforce({
              mode: 'soft',
              equipment,
              existing: {
                salmonBiomassKg: existingSalmon,
                cleanerBiomassKg: existingCleaner,
              },
              incomingBiomassKg: location.biomass,
            });

            if (tankBatch) {
              // Update existing TankBatch (mixed batch scenario)
              tankBatch.isMixedBatch = true;
              tankBatch.totalQuantity += location.quantity;
              tankBatch.totalBiomassKg =
                Number(tankBatch.totalBiomassKg) + location.biomass;
              tankBatch.avgWeightG =
                tankBatch.totalQuantity > 0
                  ? (Number(tankBatch.totalBiomassKg) * 1000) /
                    tankBatch.totalQuantity
                  : avgWeightG;
              tankBatch.densityKgM3 = capacity.projectedDensityKgM3;
              tankBatch.capacityUsedPercent = capacity.utilizationPercent;
              tankBatch.isOverCapacity = capacity.isOverCapacity;

              // Add to batch details
              const batchDetails = tankBatch.batchDetails || [];
              batchDetails.push({
                batchId: savedBatch.id,
                batchNumber: savedBatch.batchNumber,
                quantity: location.quantity,
                avgWeightG: avgWeightG,
                biomassKg: location.biomass,
                percentageOfTank:
                  (location.biomass / Number(tankBatch.totalBiomassKg)) * 100,
              });
              tankBatch.batchDetails = batchDetails;

              this.logger.log(
                `Updated existing TankBatch for equipment ${equipment.code} (mixed batch)`,
              );
            } else {
              // Create new TankBatch — capacity flags come from the
              // service so they match the allocate / transfer / deploy
              // outputs exactly.
              tankBatch = queryRunner.manager.create(TankBatch, {
                tenantId,
                tankId,
                tankName: equipment.name,
                tankCode: equipment.code,
                primaryBatchId: savedBatch.id,
                primaryBatchNumber: savedBatch.batchNumber,
                totalQuantity: location.quantity,
                currentQuantity: location.quantity,
                avgWeightG: avgWeightG,
                totalBiomassKg: location.biomass,
                currentBiomassKg: location.biomass,
                densityKgM3: capacity.projectedDensityKgM3,
                capacityUsedPercent: capacity.utilizationPercent,
                isOverCapacity: capacity.isOverCapacity,
                isMixedBatch: false,
                /** Cleaner fish fields default to zero for production batches.
                 *  TypeORM create() sends explicit null for omitted fields,
                 *  bypassing the DB column default — must be set explicitly. */
                cleanerFishBiomassKg: 0,
                cleanerFishQuantity: 0,
              });
              tankBatchMap.set(tankId, tankBatch);

              this.logger.log(
                `Created new TankBatch for equipment ${equipment.code}`,
              );
            }

            tankBatchesToSave.push(tankBatch);

            // Ledger row for this initial stocking (positive quantity — the
            // stored sign convention: inflows positive, transfer-out negative).
            initialAllocations.push(
              queryRunner.manager.create(TankAllocation, {
                tenantId,
                batchId: savedBatch.id,
                tankId,
                allocationType: AllocationType.INITIAL_STOCKING,
                allocationDate: payload.stockedAt || new Date(),
                quantity: location.quantity,
                avgWeightG,
                biomassKg: location.biomass,
                densityKgM3: capacity.projectedDensityKgM3,
                batchNumber: savedBatch.batchNumber,
                tankCode: equipment.code,
                tankName: equipment.name,
                allocatedBy: createdBy,
                isDeleted: false,
              }),
            );

            // Queue biomass/count update for the originating row.
            // Equipment path: mutate the in-memory entity and bulk-save
            // it with all siblings after the loop. Tank path: queue a
            // raw UPDATE because the adapted entity cannot be saved
            // through the Equipment metadata.
            if (isFromTanks) {
              legacyTankUpdates.push({
                id: tankId,
                biomassKg: Number(tankBatch.totalBiomassKg),
                count: tankBatch.totalQuantity,
              });
            } else {
              equipmentRecord!.currentBiomass = Number(tankBatch.totalBiomassKg);
              equipmentRecord!.currentCount = tankBatch.totalQuantity;
              if (!equipmentsToSave.includes(equipmentRecord!)) {
                equipmentsToSave.push(equipmentRecord!);
              }
            }

            this.logger.log(
              `Allocated ${location.quantity} fish (${location.biomass} kg) to ${equipment.code}`,
            );
          }

          // ── Phase 3: Bulk writes ────────────────────────────────────
          if (tankBatchesToSave.length > 0) {
            await queryRunner.manager.save(TankBatch, tankBatchesToSave);
          }
          if (initialAllocations.length > 0) {
            await queryRunner.manager.save(TankAllocation, initialAllocations);
          }
          if (equipmentsToSave.length > 0) {
            await queryRunner.manager.save(Equipment, equipmentsToSave);
          }
          // Legacy Tank path — serial UPDATEs via query builder, since
          // the adapted Equipment cannot round-trip through save().
          // Kept serial because the legacy code path is rare in
          // production and batching would require a CASE WHEN UPDATE
          // that obscures the intent for a marginal gain.
          for (const update of legacyTankUpdates) {
            await queryRunner.manager
              .createQueryBuilder()
              .update(Tank)
              .set({
                currentBiomass: update.biomassKg,
                currentCount: update.count,
              })
              .where('id = :id', { id: update.id })
              .execute();
          }
        }
      }

      // Enqueue BatchCreatedEvent into the transactional outbox BEFORE commit.
      // savedBatch is non-null at this point because we only reach here after
      // a successful save. The outbox INSERT joins the same transaction so the
      // domain write and event delivery commit atomically — at-least-once
      // delivery guaranteed even when NATS is briefly unavailable.
      const tankIds = (payload.initialLocations || [])
        .map((loc) => loc.tankId || loc.pondId)
        .filter((id): id is string => !!id);
      const batchCreatedEvent: BatchCreatedEvent = {
        ...createBaseEvent<BatchCreatedEvent>('BatchCreated', tenantId, { aggregateId: savedBatch.id, aggregateType: 'Batch' }),
        userId: createdBy,
        batchId: savedBatch.id,
        tankIds: tankIds.length > 0 ? tankIds : undefined,
        name: savedBatch.batchNumber,
        species: species.commonName,
        quantity: savedBatch.initialQuantity,
        stockedAt: toEventIso(savedBatch.stockedAt),
      };
      await this.outboxPublisher.enqueue(batchCreatedEvent, queryRunner.manager);

      // Domain writes + outbox row are atomic — runInTenantTransaction commits.
      return savedBatch;
    });
  }
}
