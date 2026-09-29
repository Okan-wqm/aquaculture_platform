import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { EscalationPolicyService, CreatePolicyDto } from '../escalation-policy.service';
import {
  EscalationPolicy,
  EscalationLevel,
  EscalationActionType,
  EscalationRecipientRole,
  EscalationRecipientScope,
  NotificationChannel,
} from '../../database/entities/escalation-policy.entity';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';

describe('EscalationPolicyService', () => {
  let service: EscalationPolicyService;
  let repository: jest.Mocked<Repository<EscalationPolicy>>;

  const mockEscalationLevel: EscalationLevel = {
    level: 1,
    name: 'Level 1 - Initial Response',
    timeoutMinutes: 15,
    notifyUserIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'],
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
    suppresses: jest.fn().mockReturnValue(false),
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
      expect(result[0]!.isActive).toBe(true);
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

    it('does not fall back to the default policy for a severity it does not list', async () => {
      // SCENARIO: the only policy is the default and it covers LOW; a CRITICAL arrives.
      // EXPECTS: no match — a policy's severity list is its contract (the old
      //          fallback paged LOW recipients for anything, ALERT-CRITICAL-004).
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

      expect(result).toBeNull();
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

    it('rejects a level that pages nobody', () => {
      // SCENARIO: a level with no users, no role targets and no on-call schedule.
      // EXPECTS: an error, not a warning — such a level is a silent alarm.
      const dto: CreatePolicyDto = {
        tenantId: 'tenant-1',
        name: 'Test',
        severity: [AlertSeverity.HIGH],
        levels: [
          { ...mockEscalationLevel, notifyUserIds: [] },
        ],
      };

      const result = service.validatePolicy(dto);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('recipient'))).toBe(true);
    });

    it('accepts a level whose only recipients are role targets', () => {
      // SCENARIO: the seeded default shape — roles instead of explicit users.
      // EXPECTS: valid.
      const dto: CreatePolicyDto = {
        tenantId: 'tenant-1',
        name: 'Test',
        severity: [AlertSeverity.HIGH],
        levels: [
          {
            ...mockEscalationLevel,
            notifyUserIds: [],
            notifyRoles: [
              { role: EscalationRecipientRole.TENANT_ADMIN, scope: EscalationRecipientScope.TENANT },
            ],
          },
        ],
      };

      expect(service.validatePolicy(dto).isValid).toBe(true);
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

    it('rejects a free-text explicit recipient (V-S1b-6)', () => {
      // SCENARIO: an e-mail typed where a user id belongs.
      // EXPECTS: refused at write — it would name nobody at delivery time.
      const result = service.validatePolicy({
        name: 'Typo',
        severity: [AlertSeverity.CRITICAL],
        levels: [{ ...mockEscalationLevel, notifyUserIds: ['night.shift@farm.example'] }],
      });

      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('notifyUserIds must be user ids'))).toBe(true);
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

  describe('getPoliciesBySeverity', () => {
    it('should return policies matching severity', async () => {
      const policies = [
        { ...mockPolicy, severity: [AlertSeverity.HIGH], isActive: true },
        { ...mockPolicy, id: 'policy-2', severity: [AlertSeverity.LOW], isActive: true },
      ] as unknown as EscalationPolicy[];

      repository.find.mockResolvedValue(policies);

      const result = await service.getPoliciesBySeverity('tenant-1', AlertSeverity.HIGH);

      expect(result).toHaveLength(1);
      expect(result[0]!.severity).toContain(AlertSeverity.HIGH);
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
