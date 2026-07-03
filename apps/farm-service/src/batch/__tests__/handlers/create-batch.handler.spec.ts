/**
 * Create Batch Handler Unit Tests
 *
 * Verifies the current production contract: transactional batch creation,
 * tenant-scoped species lookup, generated batchNumber, and outbox enqueue.
 */
import { BadRequestException } from '@nestjs/common';
import { Batch, BatchInputType, BatchStatus } from '../../entities/batch.entity';
import { CreateBatchCommand, CreateBatchPayload } from '../../commands/create-batch.command';
import { CreateBatchHandler } from '../../handlers/create-batch.handler';
import { TankAllocation, AllocationType } from '../../entities/tank-allocation.entity';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { Species } from '../../../species/entities/species.entity';
import { CodeGeneratorService } from '../../../database/services/code-generator.service';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';

describe('CreateBatchHandler', () => {
  let handler: CreateBatchHandler;
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  const mockBatchRepository = createMockRepository<Batch>();
  const mockDocumentRepository = createMockRepository();
  const mockSpeciesRepository = createMockRepository<Species>();
  const mockTankBatchRepository = createMockRepository();
  const mockEquipmentRepository = createMockRepository();
  const mockCodeGenerator = {
    generateCode: jest.fn(),
  } as unknown as jest.Mocked<CodeGeneratorService>;
  const mockOutboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const createdBy = 'user-001';
  const payload: CreateBatchPayload = {
    name: 'Test Batch 2024',
    speciesId: 'species-456',
    inputType: BatchInputType.FRY,
    initialQuantity: 10000,
    initialAvgWeightG: 5,
    stockedAt: new Date('2024-01-15'),
    supplierId: 'supplier-001',
    purchaseCost: 0.5,
    currency: 'TRY',
    notes: 'Test batch',
  };

  const species = {
    id: payload.speciesId,
    tenantId,
    commonName: 'Rainbow Trout',
    growthParameters: { targetFCR: 1.2, avgDailyGrowth: 1.5 },
  } as Species;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSpeciesRepository.findOne.mockResolvedValue(species);
    mockCodeGenerator.generateCode.mockResolvedValue({
      code: 'B-2024-00042',
      sequence: 42,
      year: 2024,
    });
    const mockTankCapacityService = {
      enforce: jest.fn().mockReturnValue({
        projectedDensityKgM3: 1,
        utilizationPercent: 10,
        isOverCapacity: false,
      }),
    };
    mockManager.save.mockImplementation((_entityClass: unknown, data: unknown) =>
      Promise.resolve({ id: 'batch-new-123', ...(data as object) }),
    );
    handler = new CreateBatchHandler(
      mockDataSource as any,
      mockBatchRepository,
      mockDocumentRepository as any,
      mockSpeciesRepository,
      mockTankBatchRepository as any,
      mockEquipmentRepository as any,
      mockCodeGenerator,
      mockOutboxPublisher as any,
      mockTankCapacityService as any,
    );
  });

  it('creates a quarantine batch with generated batchNumber', async () => {
    const result = await handler.execute(
      new CreateBatchCommand(tenantId, payload, createdBy),
    );

    expect(result.id).toBe('batch-new-123');
    expect(result.batchNumber).toBe('B-2024-00042');
    expect(result.status).toBe(BatchStatus.QUARANTINE);
    expect(mockSpeciesRepository.findOne).toHaveBeenCalledWith({
      where: {
        id: payload.speciesId,
        tenantId,
        isActive: true,
        isDeleted: false,
      },
    });
    expect(mockCodeGenerator.generateCode).toHaveBeenCalledWith({
      prefix: 'B',
      tenantId,
      entityType: 'Batch',
    });
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('sets biomass, current quantity, and FCR target from species', async () => {
    await handler.execute(new CreateBatchCommand(tenantId, payload, createdBy));

    expect(mockManager.create).toHaveBeenCalledWith(
      Batch,
      expect.objectContaining({
        initialQuantity: payload.initialQuantity,
        currentQuantity: payload.initialQuantity,
        weight: expect.objectContaining({
          initial: expect.objectContaining({
            avgWeight: payload.initialAvgWeightG,
            totalBiomass: 50,
          }),
          actual: expect.objectContaining({
            avgWeight: payload.initialAvgWeightG,
            totalBiomass: 50,
          }),
        }),
        fcr: expect.objectContaining({
          target: 1.2,
        }),
      }),
    );
  });

  it('enqueues BatchCreated event in the same transaction', async () => {
    await handler.execute(new CreateBatchCommand(tenantId, payload, createdBy));

    expect(mockOutboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BatchCreated',
        tenantId,
        userId: createdBy,
        batchId: 'batch-new-123',
        quantity: payload.initialQuantity,
      }),
      mockManager,
    );
  });

  it('throws BadRequestException when species is not active for tenant', async () => {
    mockSpeciesRepository.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(new CreateBatchCommand(tenantId, payload, createdBy)),
    ).rejects.toThrow(BadRequestException);

    expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('validates initialQuantity is positive before database writes', async () => {
    await expect(
      handler.execute(
        new CreateBatchCommand(
          tenantId,
          { ...payload, initialQuantity: 0 },
          createdBy,
        ),
      ),
    ).rejects.toThrow('Initial quantity must be positive');

    expect(mockSpeciesRepository.findOne).not.toHaveBeenCalled();
  });

  it('validates initialAvgWeightG is positive before database writes', async () => {
    await expect(
      handler.execute(
        new CreateBatchCommand(
          tenantId,
          { ...payload, initialAvgWeightG: -5 },
          createdBy,
        ),
      ),
    ).rejects.toThrow('Initial average weight must be positive');

    expect(mockSpeciesRepository.findOne).not.toHaveBeenCalled();
  });

  it('writes an initial_stocking tank_allocations ledger row per initial location (FARM-HIGH-112)', async () => {
    const equipment: Partial<Equipment> = {
      id: 'tank-001',
      tenantId,
      code: 'TNK-2024-00001',
      name: 'Tank 1',
      currentBiomass: 0,
      currentCount: 0,
    };
    (mockManager.find as jest.Mock).mockImplementation((entity: unknown) =>
      Promise.resolve(entity === Equipment ? [equipment] : []),
    );

    await handler.execute(
      new CreateBatchCommand(
        tenantId,
        {
          ...payload,
          initialLocations: [
            { locationType: 'tank', tankId: 'tank-001', quantity: 1000, biomass: 50 },
          ],
        },
        createdBy,
      ),
    );

    // The stocking must enter the allocation ledger — the ledger-reconcile
    // recomputes true counts from it, so a createBatch stocking with no
    // allocation row leaves an incomplete (unreconcilable) history.
    const allocationSave = mockManager.save.mock.calls.find(
      ([entity]) => entity === TankAllocation,
    );
    expect(allocationSave).toBeDefined();
    const savedRows = allocationSave![1] as TankAllocation[];
    expect(savedRows).toHaveLength(1);
    expect(savedRows[0]).toMatchObject({
      tenantId,
      tankId: 'tank-001',
      allocationType: AllocationType.INITIAL_STOCKING,
      quantity: 1000, // inflows are stored positive (signed convention)
      biomassKg: 50,
      allocatedBy: createdBy,
      isDeleted: false,
    });
  });
});
