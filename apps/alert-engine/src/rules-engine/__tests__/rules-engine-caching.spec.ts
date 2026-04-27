import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RulesEngineService, RuleMatchStrategy } from '../rules-engine.service';
import { RuleEvaluatorService } from '../rule-evaluator.service';
import { AlertRule, AlertSeverity, AlertOperator } from '../../database/entities/alert-rule.entity';

/**
 * Tests for RulesEngineService caching functionality
 * Verifies that rule caching works correctly for performance optimization
 */
describe('RulesEngineService Caching', () => {
  let service: RulesEngineService;
  let mockRuleRepository: jest.Mocked<Repository<AlertRule>>;
  let mockRuleEvaluator: jest.Mocked<RuleEvaluatorService>;

  const mockRules: AlertRule[] = [
    {
      id: 'rule-1',
      tenantId: 'tenant-1',
      name: 'Temperature Alert',
      isActive: true,
      farmId: 'farm-1',
      pondId: null,
      sensorId: null,
      conditions: [
        {
          parameter: 'temperature',
          operator: AlertOperator.GT,
          threshold: 30,
          severity: AlertSeverity.HIGH,
        },
      ],
      notificationChannels: ['email'],
      recipients: [],
      cooldownMinutes: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as AlertRule,
    {
      id: 'rule-2',
      tenantId: 'tenant-1',
      name: 'pH Alert',
      isActive: true,
      farmId: 'farm-1',
      pondId: null,
      sensorId: null,
      conditions: [
        {
          parameter: 'ph',
          operator: AlertOperator.LT,
          threshold: 6.5,
          severity: AlertSeverity.MEDIUM,
        },
      ],
      notificationChannels: ['email'],
      recipients: [],
      cooldownMinutes: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as AlertRule,
  ];

  beforeEach(async () => {
    const mockQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(mockRules),
    };

    mockRuleRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    } as any;

    mockRuleEvaluator = {
      evaluate: jest.fn().mockResolvedValue({ matched: false, matchedConditions: [] }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RulesEngineService,
        {
          provide: getRepositoryToken(AlertRule),
          useValue: mockRuleRepository,
        },
        {
          provide: RuleEvaluatorService,
          useValue: mockRuleEvaluator,
        },
      ],
    }).compile();

    service = module.get<RulesEngineService>(RulesEngineService);
  });

  describe('Rule Caching', () => {
    it('should cache all rules under the same key', async () => {
      const request = {
        tenantId: 'tenant-1',
        context: { values: { temperature: 25 } },
        farmId: 'farm-1',
      };

      // First call should query the database
      await service.getApplicableRules(request);
      expect(mockRuleRepository.createQueryBuilder).toHaveBeenCalledTimes(1);

      // Second call should use cache
      await service.getApplicableRules(request);
      expect(mockRuleRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('should return all cached rules, not just one', async () => {
      const request = {
        tenantId: 'tenant-1',
        context: { values: { temperature: 25 } },
        farmId: 'farm-1',
      };

      // First call caches rules
      const rules1 = await service.getApplicableRules(request);
      expect(rules1).toHaveLength(2);

      // Second call should return all cached rules (not just one)
      const rules2 = await service.getApplicableRules(request);
      expect(rules2).toHaveLength(2);
      expect(rules2[0]!.id).toBe('rule-1');
      expect(rules2[1]!.id).toBe('rule-2');
    });

    it('should use different cache keys for different filters', async () => {
      const request1 = {
        tenantId: 'tenant-1',
        context: { values: { temperature: 25 } },
        farmId: 'farm-1',
      };

      const request2 = {
        tenantId: 'tenant-1',
        context: { values: { temperature: 25 } },
        farmId: 'farm-2',
      };

      await service.getApplicableRules(request1);
      await service.getApplicableRules(request2);

      // Should have been called twice for different farm IDs
      expect(mockRuleRepository.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it('should expire cache after TTL', async () => {
      jest.useFakeTimers();

      const request = {
        tenantId: 'tenant-1',
        context: { values: { temperature: 25 } },
      };

      // First call
      await service.getApplicableRules(request);
      expect(mockRuleRepository.createQueryBuilder).toHaveBeenCalledTimes(1);

      // Advance time past cache TTL (1 minute)
      jest.advanceTimersByTime(61000);

      // Should query database again
      await service.getApplicableRules(request);
      expect(mockRuleRepository.createQueryBuilder).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    });

    it('should invalidate cache when rule is created', async () => {
      const request = {
        tenantId: 'tenant-1',
        context: { values: { temperature: 25 } },
      };

      // Cache rules
      await service.getApplicableRules(request);
      expect(mockRuleRepository.createQueryBuilder).toHaveBeenCalledTimes(1);

      // Create new rule
      mockRuleRepository.create.mockReturnValue({ id: 'rule-3' } as AlertRule);
      mockRuleRepository.save.mockResolvedValue({ id: 'rule-3', tenantId: 'tenant-1' } as AlertRule);
      await service.createRule({ tenantId: 'tenant-1', name: 'New Rule' });

      // Cache should be invalidated, next call should query DB
      await service.getApplicableRules(request);
      expect(mockRuleRepository.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it('should invalidate cache when rule is updated', async () => {
      const request = {
        tenantId: 'tenant-1',
        context: { values: { temperature: 25 } },
      };

      // Cache rules
      await service.getApplicableRules(request);

      // Update rule
      mockRuleRepository.findOne.mockResolvedValue(mockRules[0]!);
      mockRuleRepository.save.mockResolvedValue({ ...mockRules[0]!, name: 'Updated' } as AlertRule);
      // updateRule grew a tenantId arg between (id, updates).
      await service.updateRule('rule-1', 'tenant-1', { name: 'Updated' });

      // Cache should be invalidated
      await service.getApplicableRules(request);
      expect(mockRuleRepository.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it('should invalidate cache when rule is deleted', async () => {
      const request = {
        tenantId: 'tenant-1',
        context: { values: { temperature: 25 } },
      };

      // Cache rules
      await service.getApplicableRules(request);

      // Delete rule
      mockRuleRepository.findOne.mockResolvedValue(mockRules[0]!);
      // deleteRule grew a tenantId arg.
      await service.deleteRule('rule-1', 'tenant-1');

      // Cache should be invalidated
      await service.getApplicableRules(request);
      expect(mockRuleRepository.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it('should provide accurate cache statistics', async () => {
      const request = {
        tenantId: 'tenant-1',
        context: { values: { temperature: 25 } },
      };

      // Initially empty cache
      let stats = service.getCacheStats();
      expect(stats.size).toBe(0);

      // Cache rules
      await service.getApplicableRules(request);

      // Should have one cache entry (for all rules under one key).
      // getCacheStats returns { size, keyCount } — the keys[] array
      // was removed from the public API to avoid leaking cache
      // internals; size assertion is sufficient invariant.
      stats = service.getCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.keyCount).toBe(1);
    });

    it('should clear all cache', async () => {
      const request = {
        tenantId: 'tenant-1',
        context: { values: { temperature: 25 } },
      };

      await service.getApplicableRules(request);
      expect(service.getCacheStats().size).toBe(1);

      service.clearCache();
      expect(service.getCacheStats().size).toBe(0);

      // Should query DB again
      await service.getApplicableRules(request);
      expect(mockRuleRepository.createQueryBuilder).toHaveBeenCalledTimes(2);
    });
  });
});
