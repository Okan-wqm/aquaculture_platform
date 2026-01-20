import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLogService, LogAuditParams } from '../services/audit-log.service';
import { AuditLog, AuditAction } from '../entities/audit-log.entity';

describe('AuditLogService', () => {
  let service: AuditLogService;
  let repository: jest.Mocked<Repository<AuditLog>>;

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditLogService,
        {
          provide: getRepositoryToken(AuditLog),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<AuditLogService>(AuditLogService);
    repository = module.get(getRepositoryToken(AuditLog));

    // Reset mocks
    jest.clearAllMocks();
  });

  describe('log', () => {
    const baseParams: LogAuditParams = {
      tenantId: 'tenant-123',
      entityType: 'Site',
      entityId: 'entity-456',
      action: AuditAction.CREATE,
    };

    it('should create an audit log entry', async () => {
      const mockAuditLog = { id: 'log-123', ...baseParams };
      mockRepository.create.mockReturnValue(mockAuditLog);
      mockRepository.save.mockResolvedValue(mockAuditLog);

      const result = await service.log(baseParams);

      expect(mockRepository.create).toHaveBeenCalled();
      expect(mockRepository.save).toHaveBeenCalled();
      expect(result).toEqual(mockAuditLog);
    });

    it('should include user information when provided', async () => {
      const paramsWithUser = {
        ...baseParams,
        userId: 'user-789',
        userName: 'John Doe',
      };

      const mockAuditLog = { id: 'log-123', ...paramsWithUser };
      mockRepository.create.mockReturnValue(mockAuditLog);
      mockRepository.save.mockResolvedValue(mockAuditLog);

      await service.log(paramsWithUser);

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-789',
          userName: 'John Doe',
        }),
      );
    });

    it('should generate summary when not provided', async () => {
      mockRepository.create.mockImplementation((data) => data);
      mockRepository.save.mockImplementation((data) => Promise.resolve({ id: 'log-123', ...data }));

      await service.log(baseParams);

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: expect.stringContaining('Site'),
        }),
      );
    });
  });

  describe('logCreate', () => {
    it('should log CREATE action with after data', async () => {
      const entity = { id: 'entity-1', name: 'Test Site', version: 1 };
      mockRepository.create.mockImplementation((data) => data);
      mockRepository.save.mockImplementation((data) => Promise.resolve({ id: 'log-1', ...data }));

      await service.logCreate(
        'tenant-1',
        'Site',
        'entity-1',
        entity,
        'user-1',
        'Admin',
      );

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CREATE,
          changes: expect.objectContaining({
            after: expect.any(Object),
          }),
        }),
      );
    });
  });

  describe('logUpdate', () => {
    it('should log UPDATE action with before and after data', async () => {
      const before = { id: 'entity-1', name: 'Old Name', version: 1 };
      const after = { id: 'entity-1', name: 'New Name', version: 2 };

      mockRepository.create.mockImplementation((data) => data);
      mockRepository.save.mockImplementation((data) => Promise.resolve({ id: 'log-1', ...data }));

      await service.logUpdate(
        'tenant-1',
        'Site',
        'entity-1',
        before,
        after,
        'user-1',
      );

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.UPDATE,
          changes: expect.objectContaining({
            before: expect.any(Object),
            after: expect.any(Object),
            changedFields: expect.arrayContaining(['name']),
          }),
        }),
      );
    });

    it('should return null if no fields changed', async () => {
      const entity = { id: 'entity-1', name: 'Same Name', version: 1, updatedAt: new Date() };

      const result = await service.logUpdate(
        'tenant-1',
        'Site',
        'entity-1',
        entity,
        { ...entity, updatedAt: new Date(), version: 2 }, // Only audit fields changed
        'user-1',
      );

      expect(result).toBeNull();
      expect(mockRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('logDelete', () => {
    it('should log SOFT_DELETE action by default', async () => {
      const entity = { id: 'entity-1', name: 'Test Site' };
      mockRepository.create.mockImplementation((data) => data);
      mockRepository.save.mockImplementation((data) => Promise.resolve({ id: 'log-1', ...data }));

      await service.logDelete('tenant-1', 'Site', 'entity-1', entity, 'user-1');

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.SOFT_DELETE,
        }),
      );
    });

    it('should log DELETE action when isSoftDelete is false', async () => {
      const entity = { id: 'entity-1', name: 'Test Site' };
      mockRepository.create.mockImplementation((data) => data);
      mockRepository.save.mockImplementation((data) => Promise.resolve({ id: 'log-1', ...data }));

      await service.logDelete(
        'tenant-1',
        'Site',
        'entity-1',
        entity,
        'user-1',
        undefined,
        undefined,
        false, // Hard delete
      );

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.DELETE,
        }),
      );
    });
  });

  describe('logRestore', () => {
    it('should log RESTORE action', async () => {
      const entity = { id: 'entity-1', name: 'Restored Site' };
      mockRepository.create.mockImplementation((data) => data);
      mockRepository.save.mockImplementation((data) => Promise.resolve({ id: 'log-1', ...data }));

      await service.logRestore('tenant-1', 'Site', 'entity-1', entity, 'user-1');

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.RESTORE,
        }),
      );
    });
  });

  describe('getEntityHistory', () => {
    it('should return audit logs for entity', async () => {
      const mockLogs = [
        { id: 'log-1', action: AuditAction.UPDATE },
        { id: 'log-2', action: AuditAction.CREATE },
      ];
      mockRepository.find.mockResolvedValue(mockLogs);

      const result = await service.getEntityHistory('tenant-1', 'Site', 'entity-1');

      expect(mockRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId: 'tenant-1',
            entityType: 'Site',
            entityId: 'entity-1',
          },
          order: { createdAt: 'DESC' },
          take: 100,
        }),
      );
      expect(result).toEqual(mockLogs);
    });
  });

  describe('cleanupOldLogs', () => {
    it('should delete logs older than retention period', async () => {
      mockRepository.delete.mockResolvedValue({ affected: 150 });

      const result = await service.cleanupOldLogs(90);

      expect(mockRepository.delete).toHaveBeenCalled();
      expect(result).toBe(150);
    });

    it('should use default retention of 90 days', async () => {
      mockRepository.delete.mockResolvedValue({ affected: 50 });

      await service.cleanupOldLogs();

      expect(mockRepository.delete).toHaveBeenCalled();
    });
  });

  describe('sanitization', () => {
    it('should redact sensitive fields', async () => {
      const entityWithSensitiveData = {
        id: 'entity-1',
        name: 'Test',
        password: 'secret123',
        apiKey: 'key-abc',
      };

      mockRepository.create.mockImplementation((data) => data);
      mockRepository.save.mockImplementation((data) => Promise.resolve({ id: 'log-1', ...data }));

      await service.logCreate(
        'tenant-1',
        'User',
        'entity-1',
        entityWithSensitiveData,
      );

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: expect.objectContaining({
            after: expect.objectContaining({
              password: '[REDACTED]',
              apiKey: '[REDACTED]',
            }),
          }),
        }),
      );
    });
  });
});
