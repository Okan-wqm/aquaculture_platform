import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository, QueryRunner } from 'typeorm';
import { CodeGeneratorService } from '../services/code-generator.service';
import { CodeSequence } from '../entities/code-sequence.entity';

describe('CodeGeneratorService', () => {
  let service: CodeGeneratorService;
  let repository: jest.Mocked<Repository<CodeSequence>>;
  let dataSource: jest.Mocked<DataSource>;
  let queryRunner: jest.Mocked<QueryRunner>;

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
  };

  const mockQueryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    },
  };

  const mockDataSource = {
    createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CodeGeneratorService,
        {
          provide: getRepositoryToken(CodeSequence),
          useValue: mockRepository,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<CodeGeneratorService>(CodeGeneratorService);
    repository = module.get(getRepositoryToken(CodeSequence));
    dataSource = module.get(DataSource);

    // Reset mocks
    jest.clearAllMocks();
  });

  describe('generateCode', () => {
    const tenantId = 'tenant-123';
    const currentYear = new Date().getFullYear();

    it('should generate code with correct format', async () => {
      const mockSequence = {
        id: 'seq-1',
        tenantId,
        entityType: 'Batch',
        prefix: 'B',
        year: currentYear,
        lastSequence: 0,
      };

      mockQueryRunner.manager.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.create.mockReturnValue({ ...mockSequence, lastSequence: 0 });
      mockQueryRunner.manager.save.mockImplementation((entity) => {
        entity.lastSequence = 1;
        return Promise.resolve(entity);
      });

      const result = await service.generateCode({
        prefix: 'B',
        tenantId,
        entityType: 'Batch',
      });

      expect(result.code).toBe(`B-${currentYear}-00001`);
      expect(result.sequence).toBe(1);
      expect(result.year).toBe(currentYear);
    });

    it('should increment existing sequence', async () => {
      const existingSequence = {
        id: 'seq-1',
        tenantId,
        entityType: 'Batch',
        prefix: 'B',
        year: currentYear,
        lastSequence: 5,
      };

      mockQueryRunner.manager.findOne.mockResolvedValue(existingSequence);
      mockQueryRunner.manager.save.mockImplementation((entity) => {
        return Promise.resolve(entity);
      });

      const result = await service.generateCode({
        prefix: 'B',
        tenantId,
        entityType: 'Batch',
      });

      expect(result.code).toBe(`B-${currentYear}-00006`);
      expect(result.sequence).toBe(6);
    });

    it('should use custom padding', async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.create.mockReturnValue({
        tenantId,
        entityType: 'Tank',
        prefix: 'TNK',
        year: currentYear,
        lastSequence: 0,
      });
      mockQueryRunner.manager.save.mockImplementation((entity) => {
        entity.lastSequence = 1;
        return Promise.resolve(entity);
      });

      const result = await service.generateCode({
        prefix: 'TNK',
        tenantId,
        entityType: 'Tank',
        padding: 3,
      });

      expect(result.code).toBe(`TNK-${currentYear}-001`);
    });

    it('should use custom separator', async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.create.mockReturnValue({
        tenantId,
        entityType: 'Site',
        prefix: 'SITE',
        year: currentYear,
        lastSequence: 0,
      });
      mockQueryRunner.manager.save.mockImplementation((entity) => {
        entity.lastSequence = 1;
        return Promise.resolve(entity);
      });

      const result = await service.generateCode({
        prefix: 'SITE',
        tenantId,
        entityType: 'Site',
        separator: '/',
      });

      expect(result.code).toBe(`SITE/${currentYear}/00001`);
    });

    it('should rollback on error', async () => {
      mockQueryRunner.manager.findOne.mockRejectedValue(new Error('DB Error'));

      await expect(
        service.generateCode({
          prefix: 'B',
          tenantId,
          entityType: 'Batch',
        }),
      ).rejects.toThrow('DB Error');

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });

  describe('entity-specific generators', () => {
    const tenantId = 'tenant-123';
    const currentYear = new Date().getFullYear();

    beforeEach(() => {
      mockQueryRunner.manager.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.create.mockImplementation((EntityClass, data) => ({
        ...data,
        lastSequence: 0,
      }));
      mockQueryRunner.manager.save.mockImplementation((entity) => {
        entity.lastSequence = 1;
        return Promise.resolve(entity);
      });
    });

    it('generateBatchCode should use B prefix', async () => {
      const result = await service.generateBatchCode(tenantId);
      expect(result).toBe(`B-${currentYear}-00001`);
    });

    it('generateTankCode should use TNK prefix', async () => {
      const result = await service.generateTankCode(tenantId);
      expect(result).toBe(`TNK-${currentYear}-00001`);
    });

    it('generatePondCode should use PND prefix', async () => {
      const result = await service.generatePondCode(tenantId);
      expect(result).toBe(`PND-${currentYear}-00001`);
    });

    it('generateSiteCode should use SITE prefix', async () => {
      const result = await service.generateSiteCode(tenantId);
      expect(result).toBe(`SITE-${currentYear}-00001`);
    });

    it('generateEquipmentCode should use EQP prefix', async () => {
      const result = await service.generateEquipmentCode(tenantId);
      expect(result).toBe(`EQP-${currentYear}-00001`);
    });

    it('generateWorkOrderCode should use WO prefix', async () => {
      const result = await service.generateWorkOrderCode(tenantId);
      expect(result).toBe(`WO-${currentYear}-00001`);
    });
  });

  describe('parseCode', () => {
    it('should parse valid code', () => {
      const result = service.parseCode('B-2024-00123');

      expect(result).toEqual({
        prefix: 'B',
        year: 2024,
        sequence: 123,
      });
    });

    it('should parse code with long prefix', () => {
      const result = service.parseCode('TNK-2024-00001');

      expect(result).toEqual({
        prefix: 'TNK',
        year: 2024,
        sequence: 1,
      });
    });

    it('should return null for invalid format', () => {
      expect(service.parseCode('invalid')).toBeNull();
      expect(service.parseCode('B-2024')).toBeNull();
      expect(service.parseCode('B-2024-00001-extra')).toBeNull();
    });
  });

  describe('isValidCode', () => {
    it('should return true for valid code', () => {
      const currentYear = new Date().getFullYear();
      expect(service.isValidCode(`B-${currentYear}-00001`)).toBe(true);
    });

    it('should validate prefix when provided', () => {
      const currentYear = new Date().getFullYear();
      expect(service.isValidCode(`B-${currentYear}-00001`, 'B')).toBe(true);
      expect(service.isValidCode(`B-${currentYear}-00001`, 'TNK')).toBe(false);
    });

    it('should reject invalid year', () => {
      expect(service.isValidCode('B-2015-00001')).toBe(false); // Too old
      expect(service.isValidCode('B-2030-00001')).toBe(false); // Too far in future
    });

    it('should reject invalid sequence', () => {
      expect(service.isValidCode('B-2024-00000')).toBe(false); // Zero
    });

    it('should reject invalid format', () => {
      expect(service.isValidCode('invalid')).toBe(false);
    });
  });

  describe('getCurrentSequence', () => {
    it('should return current sequence number', async () => {
      mockRepository.findOne.mockResolvedValue({
        lastSequence: 42,
      });

      const result = await service.getCurrentSequence('tenant-1', 'Batch');

      expect(result).toBe(42);
    });

    it('should return 0 if no sequence exists', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      const result = await service.getCurrentSequence('tenant-1', 'Batch');

      expect(result).toBe(0);
    });
  });

  describe('setSequence', () => {
    it('should create new sequence if not exists', async () => {
      mockRepository.findOne.mockResolvedValue(null);
      mockRepository.create.mockReturnValue({
        tenantId: 'tenant-1',
        entityType: 'Batch',
        prefix: 'B',
        year: 2024,
        lastSequence: 100,
      });
      mockRepository.save.mockResolvedValue({});

      await service.setSequence('tenant-1', 'Batch', 'B', 100, 2024);

      expect(mockRepository.create).toHaveBeenCalled();
      expect(mockRepository.save).toHaveBeenCalled();
    });

    it('should update existing sequence', async () => {
      const existing = {
        id: 'seq-1',
        tenantId: 'tenant-1',
        entityType: 'Batch',
        lastSequence: 50,
      };
      mockRepository.findOne.mockResolvedValue(existing);
      mockRepository.save.mockResolvedValue({ ...existing, lastSequence: 100 });

      await service.setSequence('tenant-1', 'Batch', 'B', 100, 2024);

      expect(mockRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          lastSequence: 100,
        }),
      );
    });
  });
});
