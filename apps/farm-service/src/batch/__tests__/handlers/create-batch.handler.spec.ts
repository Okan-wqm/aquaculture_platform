/**
 * Create Batch Handler Unit Tests
 *
 * Batch oluşturma handler'ının kapsamlı testleri.
 *
 * @module Batch/Tests
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventBus } from '@platform/cqrs';
import { CreateBatchHandler } from '../../handlers/create-batch.handler';
import { CreateBatchCommand } from '../../commands/create-batch.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { Species } from '../../../species/entities/species.entity';
import { CodeGeneratorService } from '../../../database/services/code-generator.service';

describe('CreateBatchHandler', () => {
  let handler: CreateBatchHandler;
  let batchRepository: jest.Mocked<Repository<Batch>>;
  let speciesRepository: jest.Mocked<Repository<Species>>;
  let codeGeneratorService: jest.Mocked<CodeGeneratorService>;
  let eventBus: jest.Mocked<EventBus>;

  const mockBatchRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
  };

  const mockSpeciesRepository = {
    findOne: jest.fn(),
  };

  const mockCodeGeneratorService = {
    generateBatchCode: jest.fn(),
  };

  const mockEventBus = {
    publish: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateBatchHandler,
        {
          provide: getRepositoryToken(Batch),
          useValue: mockBatchRepository,
        },
        {
          provide: getRepositoryToken(Species),
          useValue: mockSpeciesRepository,
        },
        {
          provide: CodeGeneratorService,
          useValue: mockCodeGeneratorService,
        },
        {
          provide: EventBus,
          useValue: mockEventBus,
        },
      ],
    }).compile();

    handler = module.get<CreateBatchHandler>(CreateBatchHandler);
    batchRepository = module.get(getRepositoryToken(Batch));
    speciesRepository = module.get(getRepositoryToken(Species));
    codeGeneratorService = module.get(CodeGeneratorService);
    eventBus = module.get(EventBus);

    jest.clearAllMocks();
  });

  describe('execute', () => {
    const tenantId = 'tenant-123';
    const commandData = {
      name: 'Test Batch 2024',
      speciesId: 'species-456',
      siteId: 'site-789',
      initialQuantity: 10000,
      initialAvgWeightG: 5,
      stockingDate: new Date('2024-01-15'),
      supplierId: 'supplier-001',
      sourceType: 'hatchery' as const,
      unitCost: 0.5,
      currency: 'TRY',
      notes: 'Test batch',
      createdBy: 'user-001',
    };

    it('should create a batch successfully', async () => {
      const generatedCode = 'B-2024-001';
      const mockSpecies = {
        id: commandData.speciesId,
        commonName: 'Rainbow Trout',
        growthParameters: { targetFCR: 1.2 },
      };
      const mockBatch = {
        id: 'batch-new-123',
        ...commandData,
        batchCode: generatedCode,
        tenantId,
        status: BatchStatus.STOCKED,
      };

      mockSpeciesRepository.findOne.mockResolvedValue(mockSpecies);
      mockCodeGeneratorService.generateBatchCode.mockResolvedValue(generatedCode);
      mockBatchRepository.create.mockReturnValue(mockBatch);
      mockBatchRepository.save.mockResolvedValue(mockBatch);

      const command = new CreateBatchCommand(tenantId, commandData);
      const result = await handler.execute(command);

      expect(result).toBeDefined();
      expect(result.id).toBe('batch-new-123');
      expect(result.batchCode).toBe(generatedCode);
      expect(mockSpeciesRepository.findOne).toHaveBeenCalledWith({
        where: { id: commandData.speciesId, tenantId },
      });
      expect(mockCodeGeneratorService.generateBatchCode).toHaveBeenCalledWith(tenantId);
      expect(mockBatchRepository.save).toHaveBeenCalled();
    });

    it('should throw error when species not found', async () => {
      mockSpeciesRepository.findOne.mockResolvedValue(null);

      const command = new CreateBatchCommand(tenantId, commandData);

      await expect(handler.execute(command))
        .rejects.toThrow('Species not found');
    });

    it('should set initial biomass correctly', async () => {
      const mockSpecies = {
        id: commandData.speciesId,
        commonName: 'Rainbow Trout',
      };

      mockSpeciesRepository.findOne.mockResolvedValue(mockSpecies);
      mockCodeGeneratorService.generateBatchCode.mockResolvedValue('B-2024-001');
      mockBatchRepository.create.mockImplementation((data) => ({
        id: 'batch-new-123',
        ...data,
      }));
      mockBatchRepository.save.mockImplementation((batch) => Promise.resolve(batch));

      const command = new CreateBatchCommand(tenantId, commandData);
      await handler.execute(command);

      expect(mockBatchRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          initialBiomassKg: 50, // 10000 * 5 / 1000 = 50 kg
          currentBiomassKg: 50,
        }),
      );
    });

    it('should set default status to STOCKED', async () => {
      const mockSpecies = { id: commandData.speciesId, commonName: 'Trout' };

      mockSpeciesRepository.findOne.mockResolvedValue(mockSpecies);
      mockCodeGeneratorService.generateBatchCode.mockResolvedValue('B-2024-001');
      mockBatchRepository.create.mockImplementation((data) => ({
        id: 'batch-new-123',
        ...data,
      }));
      mockBatchRepository.save.mockImplementation((batch) => Promise.resolve(batch));

      const command = new CreateBatchCommand(tenantId, commandData);
      await handler.execute(command);

      expect(mockBatchRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: BatchStatus.STOCKED,
        }),
      );
    });

    it('should publish BatchCreatedEvent after creation', async () => {
      const mockSpecies = { id: commandData.speciesId, commonName: 'Trout' };
      const mockBatch = {
        id: 'batch-new-123',
        batchCode: 'B-2024-001',
        tenantId,
      };

      mockSpeciesRepository.findOne.mockResolvedValue(mockSpecies);
      mockCodeGeneratorService.generateBatchCode.mockResolvedValue('B-2024-001');
      mockBatchRepository.create.mockReturnValue(mockBatch);
      mockBatchRepository.save.mockResolvedValue(mockBatch);

      const command = new CreateBatchCommand(tenantId, commandData);
      await handler.execute(command);

      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'BatchCreated',
          tenantId,
          batchId: 'batch-new-123',
        }),
      );
    });

    it('should set FCR targets from species if available', async () => {
      const mockSpecies = {
        id: commandData.speciesId,
        commonName: 'Rainbow Trout',
        growthParameters: {
          targetFCR: 1.2,
          optimalFCRRange: { min: 1.0, max: 1.4 },
        },
      };

      mockSpeciesRepository.findOne.mockResolvedValue(mockSpecies);
      mockCodeGeneratorService.generateBatchCode.mockResolvedValue('B-2024-001');
      mockBatchRepository.create.mockImplementation((data) => ({
        id: 'batch-new-123',
        ...data,
      }));
      mockBatchRepository.save.mockImplementation((batch) => Promise.resolve(batch));

      const command = new CreateBatchCommand(tenantId, commandData);
      await handler.execute(command);

      expect(mockBatchRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          fcr: expect.objectContaining({
            target: 1.2,
          }),
        }),
      );
    });

    it('should handle optional fields correctly', async () => {
      const minimalCommandData = {
        name: 'Minimal Batch',
        speciesId: 'species-456',
        siteId: 'site-789',
        initialQuantity: 5000,
        initialAvgWeightG: 10,
        stockingDate: new Date(),
        createdBy: 'user-001',
      };

      const mockSpecies = { id: minimalCommandData.speciesId, commonName: 'Trout' };

      mockSpeciesRepository.findOne.mockResolvedValue(mockSpecies);
      mockCodeGeneratorService.generateBatchCode.mockResolvedValue('B-2024-001');
      mockBatchRepository.create.mockImplementation((data) => ({
        id: 'batch-new-123',
        ...data,
      }));
      mockBatchRepository.save.mockImplementation((batch) => Promise.resolve(batch));

      const command = new CreateBatchCommand(tenantId, minimalCommandData);
      const result = await handler.execute(command);

      expect(result).toBeDefined();
      expect(mockBatchRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Minimal Batch',
          initialQuantity: 5000,
        }),
      );
    });

    it('should set currentQuantity equal to initialQuantity', async () => {
      const mockSpecies = { id: commandData.speciesId, commonName: 'Trout' };

      mockSpeciesRepository.findOne.mockResolvedValue(mockSpecies);
      mockCodeGeneratorService.generateBatchCode.mockResolvedValue('B-2024-001');
      mockBatchRepository.create.mockImplementation((data) => ({
        id: 'batch-new-123',
        ...data,
      }));
      mockBatchRepository.save.mockImplementation((batch) => Promise.resolve(batch));

      const command = new CreateBatchCommand(tenantId, commandData);
      await handler.execute(command);

      expect(mockBatchRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          initialQuantity: commandData.initialQuantity,
          currentQuantity: commandData.initialQuantity,
        }),
      );
    });

    it('should validate initialQuantity is positive', async () => {
      const invalidCommandData = {
        ...commandData,
        initialQuantity: 0,
      };

      const command = new CreateBatchCommand(tenantId, invalidCommandData);

      await expect(handler.execute(command))
        .rejects.toThrow('Initial quantity must be positive');
    });

    it('should validate initialAvgWeightG is positive', async () => {
      const invalidCommandData = {
        ...commandData,
        initialAvgWeightG: -5,
      };

      const command = new CreateBatchCommand(tenantId, invalidCommandData);

      await expect(handler.execute(command))
        .rejects.toThrow('Initial average weight must be positive');
    });
  });

  describe('batch code generation', () => {
    it('should generate unique batch code', async () => {
      const mockSpecies = { id: 'species-456', commonName: 'Trout' };

      mockSpeciesRepository.findOne.mockResolvedValue(mockSpecies);
      mockCodeGeneratorService.generateBatchCode.mockResolvedValue('B-2024-0042');
      mockBatchRepository.create.mockImplementation((data) => ({
        id: 'batch-new-123',
        ...data,
      }));
      mockBatchRepository.save.mockImplementation((batch) => Promise.resolve(batch));

      const command = new CreateBatchCommand('tenant-123', {
        name: 'Test Batch',
        speciesId: 'species-456',
        siteId: 'site-789',
        initialQuantity: 1000,
        initialAvgWeightG: 5,
        stockingDate: new Date(),
        createdBy: 'user-001',
      });

      const result = await handler.execute(command);

      expect(result.batchCode).toBe('B-2024-0042');
      expect(mockCodeGeneratorService.generateBatchCode).toHaveBeenCalledWith('tenant-123');
    });
  });
});
