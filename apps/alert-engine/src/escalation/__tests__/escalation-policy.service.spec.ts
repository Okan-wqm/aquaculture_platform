import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, ConflictException } from '@nestjs/common';
import {
  EscalationPolicyService,
  CreatePolicyDto,
  UpdatePolicyDto,
} from '../escalation-policy.service';
import {
  EscalationPolicy,
  EscalationLevel,
  EscalationActionType,
  NotificationChannel,
  OnCallSchedule,
  SuppressionWindow,
} from '../../database/entities/escalation-policy.entity';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';

describe('EscalationPolicyService', () => {
  let service: EscalationPolicyService;
  let repository: jest.Mocked<Repository<EscalationPolicy>>;

  const mockEscalationLevel: EscalationLevel = {
    level: 1,
    name: 'Level 1 - Initial Response',
    timeoutMinutes: 15,
    notifyUserIds: ['user-1', 'user-2'],
    notifyTeamIds: ['team-1'],
    channels: [NotificationChannel.EMAIL, NotificationChannel.SLACK],
    action: EscalationActionType.NOTIFY,
  };

  const mockPolicy: Partial<EscalationPolicy> = {
    id: 'policy-1',
    tenantId: 'tenant-1',
    name: 'Default Policy',
    description: 'Default escalation policy',
    severity: [AlertSeverity.CRITICAL, AlertSeverity.HIGH],
    levels: [mockEscalationLevel],
    repeatIntervalMinutes: 5,
    maxRepeats: 3,
    isActive: true,
    isDefault: false,
    priority: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    appliesTo: jest.fn().mockReturnValue(true),
    getLevel: jest.fn().mockReturnValue(mockEscalationLevel),
    getMaxLevel: jest.fn().mockReturnValue(1),
    hasNextLevel: jest.fn().mockReturnValue(false),
    getCurrentOnCall: jest.fn().mockReturnValue(undefined),
    isInSuppressionWindow: jest.fn().mockReturnValue(false),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EscalationPolicyService,
        {
          provide: getRepositoryToken(EscalationPolicy),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<EscalationPolicyService>(EscalationPolicyService);
    repository = module.get(getRepositoryToken(EscalationPolicy));

    // Clear cache before each test
    service.clearCache();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createPolicy', () => {
    const validDto: CreatePolicyDto = {
      tenantId: 'tenant-1',
      name: 'New Policy',
      severity: [AlertSeverity.HIGH],
      levels: [mockEscalationLevel],
      repeatIntervalMinutes: 5,
      maxRepeats: 3,
    };

    it('should create a valid policy', async () => {
      repository.create.mockReturnValue(mockPolicy as EscalationPolicy);
      repository.save.mockResolvedValue(mockPolicy as EscalationPolicy);

      const result = await service.createPolicy(validDto);

      expect(repository.create).toHaveBeenCalled();
      expect(repository.save).toHaveBeenCalled();
      expect(result).toEqual(mockPolicy);
    });

    it('should throw ConflictException for invalid policy', async () => {
      const invalidDto: CreatePolicyDto = {
        tenantId: 'tenant-1',
        name: '',
        severity: [],
        levels: [],
      };

      await expect(service.createPolicy(invalidDto)).rejects.toThrow(ConflictException);
    });

    it('should unset other defaults when creating default policy', async () => {
      const defaultDto: CreatePolicyDto = {
        ...validDto,
        isDefault: true,
      };

      repository.create.mockReturnValue({ ...mockPolicy, isDefault: true } as EscalationPolicy);
      repository.save.mockResolvedValue({ ...mockPolicy, isDefault: true } as EscalationPolicy);

      await service.createPolicy(defaultDto);

      expect(repository.update).toHaveBeenCalledWith(
        { tenantId: 'tenant-1', isDefault: true },
        { isDefault: false },
      );
    });

    it('should invalidate cache after creation', async () => {
      repository.create.mockReturnValue(mockPolicy as EscalationPolicy);
      repository.save.mockResolvedValue(mockPolicy as EscalationPolicy);

      // Prime the cache
      repository.find.mockResolvedValue([mockPolicy as EscalationPolicy]);
      await service.getPolicies('tenant-1');

      await service.createPolicy(validDto);

      // Cache should be invalidated, so find should be called again
      await service.getPolicies('tenant-1');
      expect(repository.find).toHaveBeenCalledTimes(2);
    });
  });

  describe('updatePolicy', () => {
    it('should update an existing policy', async () => {
      repository.findOne.mockResolvedValue(mockPolicy as EscalationPolicy);
      repository.save.mockResolvedValue({ ...mockPolicy, name: 'Updated' } as EscalationPolicy);

      const updateDto: UpdatePolicyDto = { name: 'Updated' };
      const result = await service.updatePolicy('policy-1', 'tenant-1', updateDto);

      expect(repository.save).toHaveBeenCalled();
      expect(result.name).toBe('Updated');
    });

    it('should throw NotFoundException for non-existent policy', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.updatePolicy('non-existent', 'tenant-1', { name: 'Updated' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should validate levels when updating', async () => {
      repository.findOne.mockResolvedValue(mockPolicy as EscalationPolicy);

      const invalidUpdate: UpdatePolicyDto = {
        levels: [], // Invalid - empty levels
      };

      await expect(
        service.updatePolicy('policy-1', 'tenant-1', invalidUpdate),
      ).rejects.toThrow(ConflictException);
    });

    it('should unset other defaults when setting as default', async () => {
      repository.findOne.mockResolvedValue({ ...mockPolicy, isDefault: false } as EscalationPolicy);
      repository.save.mockResolvedValue({ ...mockPolicy, isDefault: true } as EscalationPolicy);

      await service.updatePolicy('policy-1', 'tenant-1', { isDefault: true });

      expect(repository.update).toHaveBeenCalledWith(
        { tenantId: 'tenant-1', isDefault: true },
        { isDefault: false },
      );
    });
  });

  describe('deletePolicy', () => {
    it('should delete a non-default policy', async () => {
      repository.findOne.mockResolvedValue({ ...mockPolicy, isDefault: false } as EscalationPolicy);

      await service.deletePolicy('policy-1', 'tenant-1');

      expect(repository.remove).toHaveBeenCalled();
    });

    it('should throw NotFoundException for non-existent policy', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.deletePolicy('non-existent', 'tenant-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ConflictException when deleting default policy', async () => {
      repository.findOne.mockResolvedValue({ ...mockPolicy, isDefault: true } as EscalationPolicy);

      await expect(service.deletePolicy('policy-1', 'tenant-1')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('getPolicy', () => {
    it('should return policy by ID', async () => {
      repository.findOne.mockResolvedValue(mockPolicy as EscalationPolicy);

      const result = await service.getPolicy('policy-1', 'tenant-1');

      expect(result).toEqual(mockPolicy);
    });

    it('should throw NotFoundException for non-existent policy', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.getPolicy('non-existent', 'tenant-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getPolicies', () => {
    it('should return all active policies', async () => {
      const policies = [
        { ...mockPolicy, isActive: true },
        { ...mockPolicy, id: 'policy-2', isActive: false },
      ] as EscalationPolicy[];

      repository.find.mockResolvedValue(policies);

      const result = await service.getPolicies('tenant-1');

      expect(result).toHaveLength(1);
      expect(result[0].isActive).toBe(true);
    });

    it('should return all policies when activeOnly is false', async () => {
      const policies = [
        { ...mockPolicy, isActive: true },
        { ...mockPolicy, id: 'policy-2', isActive: false },
      ] as EscalationPolicy[];

      repository.find.mockResolvedValue(policies);

      const result = await service.getPolicies('tenant-1', false);

      expect(result).toHaveLength(2);
    });

    it('should use cache on subsequent calls', async () => {
      repository.find.mockResolvedValue([mockPolicy as EscalationPolicy]);

      await service.getPolicies('tenant-1');
      await service.getPolicies('tenant-1');

      expect(repository.find).toHaveBeenCalledTimes(1);
    });
  });

  describe('getDefaultPolicy', () => {
    it('should return default policy', async () => {
      const policies = [
        { ...mockPolicy, isDefault: false },
        { ...mockPolicy, id: 'policy-2', isDefault: true },
      ] as EscalationPolicy[];

      repository.find.mockResolvedValue(policies);

      const result = await service.getDefaultPolicy('tenant-1');

      expect(result?.isDefault).toBe(true);
    });

    it('should return null if no default policy', async () => {
      repository.find.mockResolvedValue([{ ...mockPolicy, isDefault: false } as EscalationPolicy]);

      const result = await service.getDefaultPolicy('tenant-1');

      expect(result).toBeNull();
    });
  });

  describe('findMatchingPolicy', () => {
    it('should find matching policy by severity', async () => {
      const policies = [
        {
          ...mockPolicy,
          severity: [AlertSeverity.HIGH],
          appliesTo: jest.fn().mockReturnValue(true),
        },
      ] as unknown as EscalationPolicy[];

      repository.find.mockResolvedValue(policies);

      const result = await service.findMatchingPolicy(
        'tenant-1',
        AlertSeverity.HIGH,
      );

      expect(result).toBeDefined();
    });

    it('should return default policy when no specific match', async () => {
      const defaultPolicy = {
        ...mockPolicy,
        isDefault: true,
        severity: [AlertSeverity.LOW],
        appliesTo: jest.fn().mockReturnValue(false),
      };

      const policies = [defaultPolicy] as unknown as EscalationPolicy[];

      repository.find.mockResolvedValue(policies);

      const result = await service.findMatchingPolicy(
        'tenant-1',
        AlertSeverity.CRITICAL,
      );

      expect(result?.isDefault).toBe(true);
    });

    it('should prioritize specific rule match', async () => {
      const genericPolicy = {
        ...mockPolicy,
        id: 'generic',
        priority: 0,
        appliesTo: jest.fn().mockReturnValue(true),
      };

      const specificPolicy = {
        ...mockPolicy,
        id: 'specific',
        priority: 0,
        ruleIds: ['rule-1'],
        appliesTo: jest.fn().mockReturnValue(true),
      };

      const policies = [genericPolicy, specificPolicy] as unknown as EscalationPolicy[];

      repository.find.mockResolvedValue(policies);

      const result = await service.findMatchingPolicy(
        'tenant-1',
        AlertSeverity.HIGH,
        'rule-1',
      );

      expect(result?.id).toBe('specific');
    });
  });

  describe('calculateMatchScore', () => {
    it('should give higher score for severity match', () => {
      const policy = {
        ...mockPolicy,
        severity: [AlertSeverity.HIGH],
        priority: 0,
      } as unknown as EscalationPolicy;

      const score = service.calculateMatchScore(policy, AlertSeverity.HIGH);

      expect(score).toBeGreaterThanOrEqual(10);
    });

    it('should give higher score for rule match', () => {
      const policyWithRule = {
        ...mockPolicy,
        severity: [AlertSeverity.HIGH],
        ruleIds: ['rule-1'],
        priority: 0,
      } as unknown as EscalationPolicy;

      const policyWithoutRule = {
        ...mockPolicy,
        severity: [AlertSeverity.HIGH],
        priority: 0,
      } as unknown as EscalationPolicy;

      const scoreWith = service.calculateMatchScore(policyWithRule, AlertSeverity.HIGH, 'rule-1');
      const scoreWithout = service.calculateMatchScore(policyWithoutRule, AlertSeverity.HIGH, 'rule-1');

      expect(scoreWith).toBeGreaterThan(scoreWithout);
    });

    it('should give higher score for farm match', () => {
      const policyWithFarm = {
        ...mockPolicy,
        severity: [AlertSeverity.HIGH],
        farmIds: ['farm-1'],
        priority: 0,
      } as unknown as EscalationPolicy;

      const policyWithoutFarm = {
        ...mockPolicy,
        severity: [AlertSeverity.HIGH],
        priority: 0,
      } as unknown as EscalationPolicy;

      const scoreWith = service.calculateMatchScore(
        policyWithFarm,
        AlertSeverity.HIGH,
        undefined,
        'farm-1',
      );
      const scoreWithout = service.calculateMatchScore(
        policyWithoutFarm,
        AlertSeverity.HIGH,
        undefined,
        'farm-1',
      );

      expect(scoreWith).toBeGreaterThan(scoreWithout);
    });

    it('should include priority in score', () => {
      const lowPriority = {
        ...mockPolicy,
        severity: [AlertSeverity.HIGH],
        priority: 0,
      } as unknown as EscalationPolicy;

      const highPriority = {
        ...mockPolicy,
        severity: [AlertSeverity.HIGH],
        priority: 10,
      } as unknown as EscalationPolicy;

      const lowScore = service.calculateMatchScore(lowPriority, AlertSeverity.HIGH);
      const highScore = service.calculateMatchScore(highPriority, AlertSeverity.HIGH);

      expect(highScore).toBeGreaterThan(lowScore);
    });
  });

  describe('getMatchReasons', () => {
    it('should include severity match reason', () => {
      const policy = {
        ...mockPolicy,
        severity: [AlertSeverity.HIGH],
      } as unknown as EscalationPolicy;

      const reasons = service.getMatchReasons(policy, AlertSeverity.HIGH);

      expect(reasons.some(r => r.includes('Severity'))).toBe(true);
    });

    it('should include rule match reason', () => {
      const policy = {
        ...mockPolicy,
        ruleIds: ['rule-1'],
      } as unknown as EscalationPolicy;

      const reasons = service.getMatchReasons(policy, AlertSeverity.HIGH, 'rule-1');

      expect(reasons.some(r => r.includes('rule-1'))).toBe(true);
    });

    it('should include default policy reason', () => {
      const policy = {
        ...mockPolicy,
        isDefault: true,
      } as unknown as EscalationPolicy;

      const reasons = service.getMatchReasons(policy, AlertSeverity.HIGH);

      expect(reasons).toContain('Default policy');
    });
  });

  describe('validatePolicy', () => {
    it('should validate valid policy', () => {
      const dto: CreatePolicyDto = {
        tenantId: 'tenant-1',
        name: 'Valid Policy',
        severity: [AlertSeverity.HIGH],
        levels: [mockEscalationLevel],
      };

      const result = service.validatePolicy(dto);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail for empty name', () => {
      const dto: CreatePolicyDto = {
        tenantId: 'tenant-1',
        name: '',
        severity: [AlertSeverity.HIGH],
        levels: [mockEscalationLevel],
      };

      const result = service.validatePolicy(dto);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('name'))).toBe(true);
    });

    it('should fail for empty severity', () => {
      const dto: CreatePolicyDto = {
        tenantId: 'tenant-1',
        name: 'Test',
        severity: [],
        levels: [mockEscalationLevel],
      };

      const result = service.validatePolicy(dto);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('severity'))).toBe(true);
    });

    it('should fail for empty levels', () => {
      const dto: CreatePolicyDto = {
        tenantId: 'tenant-1',
        name: 'Test',
        severity: [AlertSeverity.HIGH],
        levels: [],
      };

      const result = service.validatePolicy(dto);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('level'))).toBe(true);
    });

    it('should fail for non-sequential levels', () => {
      const dto: CreatePolicyDto = {
        tenantId: 'tenant-1',
        name: 'Test',
        severity: [AlertSeverity.HIGH],
        levels: [
          { ...mockEscalationLevel, level: 1 },
          { ...mockEscalationLevel, level: 3 }, // Skip level 2
        ],
      };

      const result = service.validatePolicy(dto);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('sequential'))).toBe(true);
    });

    it('should fail for level with no channels', () => {
      const dto: CreatePolicyDto = {
        tenantId: 'tenant-1',
        name: 'Test',
        severity: [AlertSeverity.HIGH],
        levels: [
          { ...mockEscalationLevel, channels: [] },
        ],
      };

      const result = service.validatePolicy(dto);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('channel'))).toBe(true);
    });

    it('should warn for level with no users', () => {
      const dto: CreatePolicyDto = {
        tenantId: 'tenant-1',
        name: 'Test',
        severity: [AlertSeverity.HIGH],
        levels: [
          { ...mockEscalationLevel, notifyUserIds: [] },
        ],
      };

      const result = service.validatePolicy(dto);

      expect(result.warnings.some(w => w.includes('users'))).toBe(true);
    });

    it('should fail for negative repeat interval', () => {
      const dto: CreatePolicyDto = {
        tenantId: 'tenant-1',
        name: 'Test',
        severity: [AlertSeverity.HIGH],
        levels: [mockEscalationLevel],
        repeatIntervalMinutes: -1,
      };

      const result = service.validatePolicy(dto);

      expect(result.isValid).toBe(false);
    });

    it('should validate on-call schedule time format', () => {
      const dto: CreatePolicyDto = {
        tenantId: 'tenant-1',
        name: 'Test',
        severity: [AlertSeverity.HIGH],
        levels: [mockEscalationLevel],
        onCallSchedule: [
          {
            dayOfWeek: 1,
            startTime: 'invalid',
            endTime: '17:00',
            userId: 'user-1',
          },
        ],
      };

      const result = service.validatePolicy(dto);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('HH:mm'))).toBe(true);
    });
  });

  describe('addSuppressionWindow', () => {
    it('should add suppression window to policy', async () => {
      const policy = { ...mockPolicy, suppressionWindows: [] } as EscalationPolicy;
      repository.findOne.mockResolvedValue(policy);
      repository.save.mockImplementation(async (p) => p as EscalationPolicy);

      const window: SuppressionWindow = {
        id: 'window-1',
        name: 'Maintenance Window',
        startTime: new Date(),
        endTime: new Date(Date.now() + 3600000),
        reason: 'Scheduled maintenance',
        createdBy: 'admin',
        isRecurring: false,
      };

      const result = await service.addSuppressionWindow('policy-1', 'tenant-1', window);

      expect(result.suppressionWindows).toContain(window);
    });

    it('should initialize suppressionWindows array if undefined', async () => {
      const policy = { ...mockPolicy, suppressionWindows: undefined } as EscalationPolicy;
      repository.findOne.mockResolvedValue(policy);
      repository.save.mockImplementation(async (p) => p as EscalationPolicy);

      const window: SuppressionWindow = {
        id: 'window-1',
        name: 'Test',
        startTime: new Date(),
        endTime: new Date(),
        createdBy: 'admin',
        isRecurring: false,
      };

      const result = await service.addSuppressionWindow('policy-1', 'tenant-1', window);

      expect(result.suppressionWindows).toBeDefined();
      expect(result.suppressionWindows).toHaveLength(1);
    });
  });

  describe('removeSuppressionWindow', () => {
    it('should remove suppression window from policy', async () => {
      const window: SuppressionWindow = {
        id: 'window-1',
        name: 'Test',
        startTime: new Date(),
        endTime: new Date(),
        createdBy: 'admin',
        isRecurring: false,
      };

      const policy = { ...mockPolicy, suppressionWindows: [window] } as EscalationPolicy;
      repository.findOne.mockResolvedValue(policy);
      repository.save.mockImplementation(async (p) => p as EscalationPolicy);

      const result = await service.removeSuppressionWindow('policy-1', 'tenant-1', 'window-1');

      expect(result.suppressionWindows).toHaveLength(0);
    });

    it('should throw NotFoundException for non-existent window', async () => {
      const policy = { ...mockPolicy, suppressionWindows: [] } as EscalationPolicy;
      repository.findOne.mockResolvedValue(policy);

      await expect(
        service.removeSuppressionWindow('policy-1', 'tenant-1', 'window-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateOnCallSchedule', () => {
    it('should update on-call schedule', async () => {
      const policy = { ...mockPolicy } as EscalationPolicy;
      repository.findOne.mockResolvedValue(policy);
      repository.save.mockImplementation(async (p) => p as EscalationPolicy);

      const schedule: OnCallSchedule[] = [
        {
          dayOfWeek: 1,
          startTime: '09:00',
          endTime: '17:00',
          userId: 'user-1',
        },
      ];

      const result = await service.updateOnCallSchedule('policy-1', 'tenant-1', schedule);

      expect(result.onCallSchedule).toEqual(schedule);
    });
  });

  describe('getCurrentOnCallUser', () => {
    it('should return on-call user', async () => {
      const policy = {
        ...mockPolicy,
        getCurrentOnCall: jest.fn().mockReturnValue('user-1'),
      } as unknown as EscalationPolicy;

      repository.findOne.mockResolvedValue(policy);

      const result = await service.getCurrentOnCallUser('policy-1', 'tenant-1');

      expect(result).toBe('user-1');
    });

    it('should return null when no on-call user', async () => {
      const policy = {
        ...mockPolicy,
        getCurrentOnCall: jest.fn().mockReturnValue(undefined),
      } as unknown as EscalationPolicy;

      repository.findOne.mockResolvedValue(policy);

      const result = await service.getCurrentOnCallUser('policy-1', 'tenant-1');

      expect(result).toBeNull();
    });
  });

  describe('isInSuppressionWindow', () => {
    it('should return true when in suppression window', async () => {
      const policy = {
        ...mockPolicy,
        isInSuppressionWindow: jest.fn().mockReturnValue(true),
      } as unknown as EscalationPolicy;

      repository.findOne.mockResolvedValue(policy);

      const result = await service.isInSuppressionWindow('policy-1', 'tenant-1');

      expect(result).toBe(true);
    });

    it('should return false when not in suppression window', async () => {
      const policy = {
        ...mockPolicy,
        isInSuppressionWindow: jest.fn().mockReturnValue(false),
      } as unknown as EscalationPolicy;

      repository.findOne.mockResolvedValue(policy);

      const result = await service.isInSuppressionWindow('policy-1', 'tenant-1');

      expect(result).toBe(false);
    });
  });

  describe('clonePolicy', () => {
    it('should clone policy with new name', async () => {
      repository.findOne.mockResolvedValue(mockPolicy as EscalationPolicy);
      repository.create.mockImplementation((p) => p as EscalationPolicy);
      repository.save.mockImplementation(async (p) => ({ ...p, id: 'new-id' } as EscalationPolicy));

      const result = await service.clonePolicy('policy-1', 'tenant-1', 'Cloned Policy');

      expect(result.name).toBe('Cloned Policy');
      expect(result.isDefault).toBe(false);
    });
  });

  describe('getPoliciesBySeverity', () => {
    it('should return policies matching severity', async () => {
      const policies = [
        { ...mockPolicy, severity: [AlertSeverity.HIGH], isActive: true },
        { ...mockPolicy, id: 'policy-2', severity: [AlertSeverity.LOW], isActive: true },
      ] as unknown as EscalationPolicy[];

      repository.find.mockResolvedValue(policies);

      const result = await service.getPoliciesBySeverity('tenant-1', AlertSeverity.HIGH);

      expect(result).toHaveLength(1);
      expect(result[0].severity).toContain(AlertSeverity.HIGH);
    });
  });

  describe('cache management', () => {
    it('should clear cache when clearCache is called', async () => {
      repository.find.mockResolvedValue([mockPolicy as EscalationPolicy]);

      await service.getPolicies('tenant-1');
      service.clearCache();
      await service.getPolicies('tenant-1');

      expect(repository.find).toHaveBeenCalledTimes(2);
    });
  });
});
