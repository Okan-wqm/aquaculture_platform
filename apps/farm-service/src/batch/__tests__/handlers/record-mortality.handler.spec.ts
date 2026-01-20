/**
 * Record Mortality Handler Unit Tests
 *
 * Mortality kaydı handler'ının kapsamlı testleri.
 *
 * @module Batch/Tests
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventBus } from '@platform/cqrs';
import { RecordMortalityHandler } from '../../handlers/record-mortality.handler';
import { RecordMortalityCommand } from '../../commands/record-mortality.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { MortalityRecord, MortalityCause } from '../../entities/mortality-record.entity';
import { TankBatch } from '../../entities/tank-batch.entity';

describe('RecordMortalityHandler', () => {
  let handler: RecordMortalityHandler;
  let batchRepository: jest.Mocked<Repository<Batch>>;
  let mortalityRepository: jest.Mocked<Repository<MortalityRecord>>;
  let tankBatchRepository: jest.Mocked<Repository<TankBatch>>;
  let eventBus: jest.Mocked<EventBus>;

  const mockBatchRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
  };

  const mockMortalityRepository = {
    create: jest.fn(),
    save: jest.fn(),
    sum: jest.fn(),
  };

  const mockTankBatchRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
  };

  const mockEventBus = {
    publish: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecordMortalityHandler,
        {
          provide: getRepositoryToken(Batch),
          useValue: mockBatchRepository,
        },
        {
          provide: getRepositoryToken(MortalityRecord),
          useValue: mockMortalityRepository,
        },
        {
          provide: getRepositoryToken(TankBatch),
          useValue: mockTankBatchRepository,
        },
        {
          provide: EventBus,
          useValue: mockEventBus,
        },
      ],
    }).compile();

    handler = module.get<RecordMortalityHandler>(RecordMortalityHandler);
    batchRepository = module.get(getRepositoryToken(Batch));
    mortalityRepository = module.get(getRepositoryToken(MortalityRecord));
    tankBatchRepository = module.get(getRepositoryToken(TankBatch));
    eventBus = module.get(EventBus);

    jest.clearAllMocks();
  });

  describe('execute', () => {
    const tenantId = 'tenant-123';
    const commandData = {
      batchId: 'batch-456',
      quantity: 50,
      cause: MortalityCause.DISEASE,
      mortalityDate: new Date('2024-01-15'),
      tankId: 'tank-789',
      symptoms: 'Fin rot observed',
      suspectedPathogen: 'Bacterial infection',
      notes: 'Isolated affected tank',
      recordedBy: 'user-001',
    };

    it('should record mortality successfully', async () => {
      const mockBatch = {
        id: commandData.batchId,
        tenantId,
        currentQuantity: 10000,
        initialQuantity: 10000,
        totalMortality: 100,
        status: BatchStatus.ACTIVE,
      };

      const mockMortalityRecord = {
        id: 'mortality-new-123',
        ...commandData,
        tenantId,
      };

      mockBatchRepository.findOne.mockResolvedValue(mockBatch);
      mockMortalityRepository.create.mockReturnValue(mockMortalityRecord);
      mockMortalityRepository.save.mockResolvedValue(mockMortalityRecord);
      mockBatchRepository.save.mockResolvedValue({
        ...mockBatch,
        currentQuantity: 9950,
        totalMortality: 150,
      });

      const command = new RecordMortalityCommand(tenantId, commandData);
      const result = await handler.execute(command);

      expect(result).toBeDefined();
      expect(result.id).toBe('mortality-new-123');
      expect(mockBatchRepository.findOne).toHaveBeenCalledWith({
        where: { id: commandData.batchId, tenantId },
      });
      expect(mockMortalityRepository.save).toHaveBeenCalled();
    });

    it('should throw error when batch not found', async () => {
      mockBatchRepository.findOne.mockResolvedValue(null);

      const command = new RecordMortalityCommand(tenantId, commandData);

      await expect(handler.execute(command))
        .rejects.toThrow('Batch not found');
    });

    it('should throw error when mortality exceeds current quantity', async () => {
      const mockBatch = {
        id: commandData.batchId,
        tenantId,
        currentQuantity: 30, // Less than mortality quantity
        status: BatchStatus.ACTIVE,
      };

      mockBatchRepository.findOne.mockResolvedValue(mockBatch);

      const command = new RecordMortalityCommand(tenantId, commandData);

      await expect(handler.execute(command))
        .rejects.toThrow('Mortality quantity exceeds current batch quantity');
    });

    it('should update batch quantity and mortality count', async () => {
      const mockBatch = {
        id: commandData.batchId,
        tenantId,
        currentQuantity: 10000,
        initialQuantity: 10000,
        totalMortality: 100,
        status: BatchStatus.ACTIVE,
      };

      mockBatchRepository.findOne.mockResolvedValue(mockBatch);
      mockMortalityRepository.create.mockReturnValue({ id: 'mortality-123' });
      mockMortalityRepository.save.mockResolvedValue({ id: 'mortality-123' });
      mockBatchRepository.save.mockImplementation((batch) => Promise.resolve(batch));

      const command = new RecordMortalityCommand(tenantId, commandData);
      await handler.execute(command);

      expect(mockBatchRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          currentQuantity: 9950, // 10000 - 50
          totalMortality: 150, // 100 + 50
        }),
      );
    });

    it('should update tank batch if tankId provided', async () => {
      const mockBatch = {
        id: commandData.batchId,
        tenantId,
        currentQuantity: 10000,
        initialQuantity: 10000,
        totalMortality: 100,
        status: BatchStatus.ACTIVE,
      };

      const mockTankBatch = {
        id: 'tank-batch-123',
        tankId: commandData.tankId,
        batchId: commandData.batchId,
        currentQuantity: 5000,
      };

      mockBatchRepository.findOne.mockResolvedValue(mockBatch);
      mockTankBatchRepository.findOne.mockResolvedValue(mockTankBatch);
      mockMortalityRepository.create.mockReturnValue({ id: 'mortality-123' });
      mockMortalityRepository.save.mockResolvedValue({ id: 'mortality-123' });
      mockBatchRepository.save.mockImplementation((batch) => Promise.resolve(batch));
      mockTankBatchRepository.save.mockImplementation((tb) => Promise.resolve(tb));

      const command = new RecordMortalityCommand(tenantId, commandData);
      await handler.execute(command);

      expect(mockTankBatchRepository.findOne).toHaveBeenCalledWith({
        where: {
          tankId: commandData.tankId,
          batchId: commandData.batchId,
          tenantId,
        },
      });
      expect(mockTankBatchRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          currentQuantity: 4950, // 5000 - 50
        }),
      );
    });

    it('should publish MortalityRecordedEvent', async () => {
      const mockBatch = {
        id: commandData.batchId,
        tenantId,
        currentQuantity: 10000,
        initialQuantity: 10000,
        totalMortality: 100,
        status: BatchStatus.ACTIVE,
      };

      mockBatchRepository.findOne.mockResolvedValue(mockBatch);
      mockMortalityRepository.create.mockReturnValue({ id: 'mortality-123' });
      mockMortalityRepository.save.mockResolvedValue({ id: 'mortality-123' });
      mockBatchRepository.save.mockImplementation((batch) => Promise.resolve(batch));

      const command = new RecordMortalityCommand(tenantId, commandData);
      await handler.execute(command);

      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'MortalityRecorded',
          tenantId,
          batchId: commandData.batchId,
          quantity: commandData.quantity,
          reason: commandData.cause,
        }),
      );
    });

    it('should calculate new mortality rate correctly', async () => {
      const mockBatch = {
        id: commandData.batchId,
        tenantId,
        currentQuantity: 10000,
        initialQuantity: 10000,
        totalMortality: 0, // No previous mortality
        status: BatchStatus.ACTIVE,
      };

      mockBatchRepository.findOne.mockResolvedValue(mockBatch);
      mockMortalityRepository.create.mockReturnValue({ id: 'mortality-123' });
      mockMortalityRepository.save.mockResolvedValue({ id: 'mortality-123' });
      mockBatchRepository.save.mockImplementation((batch) => Promise.resolve(batch));

      const command = new RecordMortalityCommand(tenantId, commandData);
      await handler.execute(command);

      // Mortality rate should be 50/10000 * 100 = 0.5%
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          newTotalMortality: 50,
          newMortalityRate: 0.5,
        }),
      );
    });

    it('should not allow mortality on closed batch', async () => {
      const mockBatch = {
        id: commandData.batchId,
        tenantId,
        currentQuantity: 10000,
        status: BatchStatus.CLOSED,
      };

      mockBatchRepository.findOne.mockResolvedValue(mockBatch);

      const command = new RecordMortalityCommand(tenantId, commandData);

      await expect(handler.execute(command))
        .rejects.toThrow('Cannot record mortality for a closed batch');
    });

    it('should handle different mortality causes', async () => {
      const mockBatch = {
        id: commandData.batchId,
        tenantId,
        currentQuantity: 10000,
        initialQuantity: 10000,
        totalMortality: 0,
        status: BatchStatus.ACTIVE,
      };

      mockBatchRepository.findOne.mockResolvedValue(mockBatch);
      mockMortalityRepository.create.mockImplementation((data) => ({
        id: 'mortality-123',
        ...data,
      }));
      mockMortalityRepository.save.mockImplementation((record) => Promise.resolve(record));
      mockBatchRepository.save.mockImplementation((batch) => Promise.resolve(batch));

      const causes = [
        MortalityCause.DISEASE,
        MortalityCause.PREDATION,
        MortalityCause.WATER_QUALITY,
        MortalityCause.HANDLING,
        MortalityCause.UNKNOWN,
      ];

      for (const cause of causes) {
        jest.clearAllMocks();
        mockBatchRepository.findOne.mockResolvedValue({ ...mockBatch });

        const command = new RecordMortalityCommand(tenantId, {
          ...commandData,
          cause,
        });

        const result = await handler.execute(command);

        expect(result).toBeDefined();
        expect(mockMortalityRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            cause,
          }),
        );
      }
    });

    it('should validate quantity is positive', async () => {
      const command = new RecordMortalityCommand(tenantId, {
        ...commandData,
        quantity: 0,
      });

      await expect(handler.execute(command))
        .rejects.toThrow('Mortality quantity must be positive');
    });

    it('should store estimated biomass loss', async () => {
      const mockBatch = {
        id: commandData.batchId,
        tenantId,
        currentQuantity: 10000,
        initialQuantity: 10000,
        totalMortality: 0,
        status: BatchStatus.ACTIVE,
        getCurrentAvgWeight: () => 200, // 200g average weight
      };

      mockBatchRepository.findOne.mockResolvedValue(mockBatch);
      mockMortalityRepository.create.mockImplementation((data) => ({
        id: 'mortality-123',
        ...data,
      }));
      mockMortalityRepository.save.mockImplementation((record) => Promise.resolve(record));
      mockBatchRepository.save.mockImplementation((batch) => Promise.resolve(batch));

      const command = new RecordMortalityCommand(tenantId, commandData);
      await handler.execute(command);

      // Expected biomass loss: 50 fish * 200g / 1000 = 10 kg
      expect(mockMortalityRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          estimatedBiomassLossKg: 10,
        }),
      );
    });
  });

  describe('cumulative mortality tracking', () => {
    it('should accurately track cumulative mortality', async () => {
      const tenantId = 'tenant-123';
      const batchId = 'batch-456';

      // First mortality event
      let currentMortality = 0;
      let currentQuantity = 10000;

      const mockBatch = {
        id: batchId,
        tenantId,
        currentQuantity,
        initialQuantity: 10000,
        totalMortality: currentMortality,
        status: BatchStatus.ACTIVE,
      };

      mockBatchRepository.findOne.mockResolvedValue(mockBatch);
      mockMortalityRepository.create.mockImplementation((data) => ({ id: 'mortality-1', ...data }));
      mockMortalityRepository.save.mockImplementation((record) => Promise.resolve(record));
      mockBatchRepository.save.mockImplementation((batch) => {
        currentMortality = batch.totalMortality;
        currentQuantity = batch.currentQuantity;
        return Promise.resolve(batch);
      });

      // Record 50 mortality
      await handler.execute(new RecordMortalityCommand(tenantId, {
        batchId,
        quantity: 50,
        cause: MortalityCause.DISEASE,
        mortalityDate: new Date(),
        recordedBy: 'user-001',
      }));

      expect(currentMortality).toBe(50);
      expect(currentQuantity).toBe(9950);

      // Update mock for second call
      mockBatchRepository.findOne.mockResolvedValue({
        ...mockBatch,
        currentQuantity,
        totalMortality: currentMortality,
      });

      // Record another 30 mortality
      await handler.execute(new RecordMortalityCommand(tenantId, {
        batchId,
        quantity: 30,
        cause: MortalityCause.WATER_QUALITY,
        mortalityDate: new Date(),
        recordedBy: 'user-001',
      }));

      expect(currentMortality).toBe(80);
      expect(currentQuantity).toBe(9920);
    });
  });
});
