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
import { toEventIso, BatchCreatedEvent, createBaseEvent } from '@platform/event-contracts';
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
import { FinanceSettingsService } from '../../finance/services/finance-settings.service';
import { TankBatchService } from '../services/tank-batch.service';
import { TankStockingService } from '../services/tank-stocking.service';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { defaultFarmStockProjectionForDirectHandlerConstruction } from '../../common/services/direct-handler-dependency-defaults';

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
    private readonly financeSettings: FinanceSettingsService,
    // The single writer for tank composition and for the container fish count.
    private readonly tankBatchService: TankBatchService,
    // SEC-HIGH-167 / FARM-HIGH-323: the one stocking path, shared with
    // allocate-to-tank. Placed before the defaulted parameter below.
    private readonly tankStocking: TankStockingService,
    private readonly farmStockProjection: FarmStockProjectionService = defaultFarmStockProjectionForDirectHandlerConstruction(),
  ) {}

  async execute(command: CreateBatchCommand): Promise<Batch> {
    const { tenantId, payload, createdBy, userRoles, callerAssignedSiteIds } = command;

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
      const inputTypeKey = payload.inputType
        .toLowerCase()
        .replace('_', '') as keyof typeof species.harvestDaysPerInputType;
      const harvestDays = species.harvestDaysPerInputType[inputTypeKey];
      if (harvestDays) {
        expectedHarvestDate = new Date(payload.stockedAt);
        expectedHarvestDate.setDate(expectedHarvestDate.getDate() + harvestDays);
      }
    }

    // Currency SSoT (FARM-HIGH-151): batch.purchaseCost feeds the
    // FINGERLINGS derived-cost line — resolve the tenant default from
    // finance_settings, never a hardcoded literal.
    const defaultCurrency = await this.financeSettings.getDefaultCurrency(tenantId);

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
      const generatedCode = payload.batchNumber
        ? null
        : await this.codeGenerator.generateCode({
            prefix: 'B',
            tenantId,
            entityType: 'Batch',
          });
      const batchNumber =
        payload.batchNumber || generatedCode?.code || `B-${new Date().getFullYear()}-${Date.now()}`;

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
        currency: payload.currency || defaultCurrency,
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
        const healthCertDocs = payload.healthCertificates.map((doc) =>
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
          }),
        );
        await queryRunner.manager.save(BatchDocument, healthCertDocs);
      }

      // Save import documents
      if (payload.importDocuments && payload.importDocuments.length > 0) {
        const importDocs = payload.importDocuments.map((doc) =>
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
          }),
        );
        await queryRunner.manager.save(BatchDocument, importDocs);
      }

      // ── P-H3: Process initial locations with bulk pre-fetch ─────────
      //
      // NB: this transaction holds NO pessimistic lock and runs at READ
      // COMMITTED — an earlier version of this comment claimed otherwise and
      // was simply wrong. The gap against allocate-to-tank's SERIALIZABLE +
      // pessimistic_write model is tracked as FARM-HIGH-323, not fixed here.
      //
      // The previous implementation issued 4-5 queries PER location:
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
      // The fix was three bulk reads BEFORE the loop (Equipment-by-ids,
      // Tank fallback only for missing ids, TankBatch-by-tankIds), then a
      // bulk save at the end — ~40 round-trips down to ~5, ~350 ms to ~80 ms.
      //
      // The bulk READS survive. The in-memory tank_batches mutation did not
      // (FARM-HIGH-139): composition now goes through applyBatchDelta, which
      // re-reads and locks the row per call, so a multi-location stocking
      // costs a few round-trips more than the pure in-memory version did.
      // That is the deliberate trade — initial stocking happens once per
      // batch and is not a hot path, and a second writer that drifts from the
      // SSoT is not worth the milliseconds.
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
          // FARM-HIGH-323 / SEC-HIGH-167 / FARM-MEDIUM-325: every location goes
          // through TankStockingService, the one stocking path, so initial
          // stocking performs the same steps as allocate-to-tank instead of a
          // weaker copy of them: the container is locked before it is read, the
          // caller's site assignment is asserted before any write, the capacity
          // decision is made under that lock, and the ledger row is written.
          //
          // The bulk pre-fetch that used to live here is gone with it. It read
          // Equipment, Tank and TankBatch UNLOCKED before the loop and the
          // capacity decision was made from that snapshot, while applyBatchDelta
          // took its own row lock several lines later — so the value decided on
          // was never the value written against. Three queries saved is not worth
          // a capacity check that describes a state the write does not see.
          for (const location of payload.initialLocations) {
            const tankId = location.tankId || location.pondId;
            if (!tankId) {
              // FARM-MEDIUM-325: refuse rather than skip. A location the caller
              // asked for that silently does not happen leaves a batch stocked
              // into fewer tanks than requested with nothing saying which.
              throw new BadRequestException('Each initial location must name a tankId or a pondId');
            }

            const avgWeightG =
              location.quantity > 0
                ? (location.biomass * 1000) / location.quantity
                : payload.initialAvgWeightG;

            await this.tankStocking.stockTank(queryRunner.manager, {
              tenantId,
              tankId,
              batch: { id: savedBatch.id, batchNumber: savedBatch.batchNumber },
              quantity: location.quantity,
              avgWeightG,
              allocationType: AllocationType.INITIAL_STOCKING,
              allocationDate: location.allocationDate
                ? new Date(location.allocationDate)
                : payload.stockedAt,
              actorUserId: createdBy,
              caller: { roles: userRoles, assignedSiteIds: callerAssignedSiteIds },
              // Initial stocking may intentionally exceed the density cap — the
              // operator spreads the batch as it grows — so the breach is
              // recorded on the row rather than blocking. Unchanged from before.
              capacityMode: 'soft',
              auditSource: 'CreateBatchHandler',
            });
          }

          await this.farmStockProjection.refreshContainers(queryRunner.manager, tenantId, tankIds);
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
        ...createBaseEvent<BatchCreatedEvent>('BatchCreated', tenantId, {
          aggregateId: savedBatch.id,
          aggregateType: 'Batch',
        }),
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
