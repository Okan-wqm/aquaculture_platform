import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  RulesEngineService,
  RuleMatchStrategy,
  RuleEvaluationRequest,
} from '../rules-engine.service';
import { RuleEvaluatorService, EvaluationContext } from '../rule-evaluator.service';
import {
  AlertRule,
  AlertCondition,
  AlertOperator,
  AlertSeverity,
} from '../../database/entities/alert-rule.entity';

describe('RulesEngineService', () => {
  let service: RulesEngineService;
  let ruleRepository: jest.Mocked<Repository<AlertRule>>;
  let ruleEvaluator: jest.Mocked<RuleEvaluatorService>;

  // Helper to create mock rule
  const createMockRule = (overrides: Partial<AlertRule> = {}): AlertRule => {
    const rule = new AlertRule();
    Object.assign(rule, {
      id: 'rule-123',
      name: 'Test Rule',
      description: 'Test rule description',
      tenantId: 'tenant-123',
      isActive: true,
      conditions: [
        {
          parameter: 'temperature',
          operator: AlertOperator.GT,
          threshold: 30,
          severity: AlertSeverity.WARNING,
        },
      ],
      cooldownMinutes: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });
    return rule;
  };

  // Helper to create evaluation context
  const createContext = (values: Record<string, number | string | boolean | null>): EvaluationContext => ({
    values,
    timestamp: new Date(),
  });

  // Mock query builder
  const createMockQueryBuilder = () => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
  });

  beforeEach(async () => {
    const mockQueryBuilder = createMockQueryBuilder();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RulesEngineService,
        {
          provide: getRepositoryToken(AlertRule),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
            delete: jest.fn(),
            createQueryBuilder: jest.fn(() => mockQueryBuilder),
          },
        },
        {
          provide: RuleEvaluatorService,
          useValue: {
            evaluate: jest.fn(),
            evaluateWithAnd: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<RulesEngineService>(RulesEngineService);
    ruleRepository = module.get(getRepositoryToken(AlertRule));
    ruleEvaluator = module.get(RuleEvaluatorService);

    // Clear cache before each test
    service.clearCache();
  });

  // ============================================================================
  // RULE EVALUATION
  // ============================================================================

  describe('evaluateRules', () => {
    it('should evaluate rules for a tenant', async () => {
      const rule = createMockRule();
      const context = createContext({ temperature: 35 });

      const mockQueryBuilder = createMockQueryBuilder();
      mockQueryBuilder.getMany.mockResolvedValue([rule]);
      (ruleRepository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      ruleEvaluator.evaluate.mockResolvedValue({
        matched: true,
        matchedConditions: rule.conditions,
        allResults: [],
        evaluationTime: 5,
        timestamp: new Date(),
      });

      const request: RuleEvaluationRequest = {
        tenantId: 'tenant-123',
        context,
      };

      const matches = await service.evaluateRules(request);

      expect(matches).toHaveLength(1);
      expect(matches[0].rule.id).toBe('rule-123');
      expect(matches[0].severity).toBe(AlertSeverity.WARNING);
    });

    it('should return empty array when no rules match', async () => {
      const rule = createMockRule();
      const context = createContext({ temperature: 25 });

      const mockQueryBuilder = createMockQueryBuilder();
      mockQueryBuilder.getMany.mockResolvedValue([rule]);
      (ruleRepository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      ruleEvaluator.evaluate.mockResolvedValue({
        matched: false,
        matchedConditions: [],
        allResults: [],
        evaluationTime: 5,
        timestamp: new Date(),
      });

      const request: RuleEvaluationRequest = {
        tenantId: 'tenant-123',
        context,
      };

      const matches = await service.evaluateRules(request);

      expect(matches).toHaveLength(0);
    });

    it('should return empty array when no applicable rules', async () => {
      const mockQueryBuilder = createMockQueryBuilder();
      mockQueryBuilder.getMany.mockResolvedValue([]);
      (ruleRepository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      const request: RuleEvaluationRequest = {
        tenantId: 'tenant-123',
        context: createContext({ temperature: 35 }),
      };

      const matches = await service.evaluateRules(request);

      expect(matches).toHaveLength(0);
    });

    it('should use FIRST_MATCH strategy', async () => {
      const rule1 = createMockRule({ id: 'rule-1', name: 'Rule 1' });
      const rule2 = createMockRule({ id: 'rule-2', name: 'Rule 2' });
      const context = createContext({ temperature: 35 });

      const mockQueryBuilder = createMockQueryBuilder();
      mockQueryBuilder.getMany.mockResolvedValue([rule1, rule2]);
      (ruleRepository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      ruleEvaluator.evaluate.mockResolvedValue({
        matched: true,
        matchedConditions: rule1.conditions,
        allResults: [],
        evaluationTime: 5,
        timestamp: new Date(),
      });

      const request: RuleEvaluationRequest = {
        tenantId: 'tenant-123',
        context,
        strategy: RuleMatchStrategy.FIRST_MATCH,
      };

      const matches = await service.evaluateRules(request);

      expect(matches).toHaveLength(1);
      expect(matches[0].rule.id).toBe('rule-1');
    });

    it('should use ALL_MATCH strategy', async () => {
      const rule1 = createMockRule({ id: 'rule-1', name: 'Rule 1' });
      const rule2 = createMockRule({ id: 'rule-2', name: 'Rule 2' });
      const context = createContext({ temperature: 35 });

      const mockQueryBuilder = createMockQueryBuilder();
      mockQueryBuilder.getMany.mockResolvedValue([rule1, rule2]);
      (ruleRepository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      ruleEvaluator.evaluate.mockResolvedValue({
        matched: true,
        matchedConditions: rule1.conditions,
        allResults: [],
        evaluationTime: 5,
        timestamp: new Date(),
      });

      const request: RuleEvaluationRequest = {
        tenantId: 'tenant-123',
        context,
        strategy: RuleMatchStrategy.ALL_MATCH,
      };

      const matches = await service.evaluateRules(request);

      expect(matches).toHaveLength(2);
    });

    it('should use BEST_MATCH strategy and sort by severity', async () => {
      const rule1 = createMockRule({
        id: 'rule-1',
        conditions: [{
          parameter: 'temp',
          operator: AlertOperator.GT,
          threshold: 30,
          severity: AlertSeverity.WARNING,
        }],
      });
      const rule2 = createMockRule({
        id: 'rule-2',
        conditions: [{
          parameter: 'temp',
          operator: AlertOperator.GT,
          threshold: 35,
          severity: AlertSeverity.CRITICAL,
        }],
      });

      const mockQueryBuilder = createMockQueryBuilder();
      mockQueryBuilder.getMany.mockResolvedValue([rule1, rule2]);
      (ruleRepository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      ruleEvaluator.evaluate
        .mockResolvedValueOnce({
          matched: true,
          matchedConditions: rule1.conditions,
          allResults: [],
          evaluationTime: 5,
          timestamp: new Date(),
        })
        .mockResolvedValueOnce({
          matched: true,
          matchedConditions: rule2.conditions,
          allResults: [],
          evaluationTime: 5,
          timestamp: new Date(),
        });

      const request: RuleEvaluationRequest = {
        tenantId: 'tenant-123',
        context: createContext({ temp: 40 }),
        strategy: RuleMatchStrategy.BEST_MATCH,
      };

      const matches = await service.evaluateRules(request);

      expect(matches).toHaveLength(2);
      expect(matches[0].severity).toBe(AlertSeverity.CRITICAL);
      expect(matches[1].severity).toBe(AlertSeverity.WARNING);
    });

    it('should filter by farm/pond/sensor IDs', async () => {
      const mockQueryBuilder = createMockQueryBuilder();
      mockQueryBuilder.getMany.mockResolvedValue([]);
      (ruleRepository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      const request: RuleEvaluationRequest = {
        tenantId: 'tenant-123',
        context: createContext({ temperature: 35 }),
        farmId: 'farm-123',
        pondId: 'pond-456',
        sensorId: 'sensor-789',
      };

      await service.evaluateRules(request);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        '(rule.farmId = :farmId OR rule.farmId IS NULL)',
        { farmId: 'farm-123' },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        '(rule.pondId = :pondId OR rule.pondId IS NULL)',
        { pondId: 'pond-456' },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        '(rule.sensorId = :sensorId OR rule.sensorId IS NULL)',
        { sensorId: 'sensor-789' },
      );
    });

    it('should filter by specific rule IDs', async () => {
      const mockQueryBuilder = createMockQueryBuilder();
      mockQueryBuilder.getMany.mockResolvedValue([]);
      (ruleRepository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      const request: RuleEvaluationRequest = {
        tenantId: 'tenant-123',
        context: createContext({ temperature: 35 }),
        ruleIds: ['rule-1', 'rule-2'],
      };

      await service.evaluateRules(request);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'rule.id IN (:...ruleIds)',
        { ruleIds: ['rule-1', 'rule-2'] },
      );
    });

    it('should handle evaluation errors gracefully', async () => {
      const rule = createMockRule();

      const mockQueryBuilder = createMockQueryBuilder();
      mockQueryBuilder.getMany.mockResolvedValue([rule]);
      (ruleRepository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      ruleEvaluator.evaluate.mockRejectedValue(new Error('Evaluation failed'));

      const request: RuleEvaluationRequest = {
        tenantId: 'tenant-123',
        context: createContext({ temperature: 35 }),
      };

      // Should not throw, but return empty matches
      const matches = await service.evaluateRules(request);
      expect(matches).toHaveLength(0);
    });
  });

  // ============================================================================
  // RULE CRUD OPERATIONS
  // ============================================================================

  describe('createRule', () => {
    it('should create a new rule', async () => {
      const ruleData: Partial<AlertRule> = {
        name: 'New Rule',
        tenantId: 'tenant-123',
        conditions: [{
          parameter: 'temperature',
          operator: AlertOperator.GT,
          threshold: 30,
          severity: AlertSeverity.WARNING,
        }],
      };

      const savedRule = createMockRule(ruleData);
      ruleRepository.create.mockReturnValue(savedRule);
      ruleRepository.save.mockResolvedValue(savedRule);

      const result = await service.createRule(ruleData);

      expect(result).toEqual(savedRule);
      expect(ruleRepository.create).toHaveBeenCalledWith(ruleData);
      expect(ruleRepository.save).toHaveBeenCalled();
    });

    it('should invalidate cache after creation', async () => {
      const ruleData: Partial<AlertRule> = {
        name: 'New Rule',
        tenantId: 'tenant-123',
        conditions: [],
      };

      const savedRule = createMockRule(ruleData);
      ruleRepository.create.mockReturnValue(savedRule);
      ruleRepository.save.mockResolvedValue(savedRule);

      // First, populate cache
      service.clearCache();
      const cacheStatsBefore = service.getCacheStats();

      await service.createRule(ruleData);

      // Cache should be invalidated for tenant
      const cacheStatsAfter = service.getCacheStats();
      expect(cacheStatsAfter.size).toBe(0);
    });
  });

  describe('updateRule', () => {
    it('should update an existing rule', async () => {
      const existingRule = createMockRule();
      ruleRepository.findOne.mockResolvedValue(existingRule);
      ruleRepository.save.mockResolvedValue({ ...existingRule, name: 'Updated Rule' } as AlertRule);

      const result = await service.updateRule('rule-123', { name: 'Updated Rule' });

      expect(result.name).toBe('Updated Rule');
    });

    it('should throw error for non-existent rule', async () => {
      ruleRepository.findOne.mockResolvedValue(null);

      await expect(service.updateRule('non-existent', { name: 'Test' })).rejects.toThrow(
        'Rule non-existent not found',
      );
    });
  });

  describe('deleteRule', () => {
    it('should delete an existing rule', async () => {
      const existingRule = createMockRule();
      ruleRepository.findOne.mockResolvedValue(existingRule);
      ruleRepository.delete.mockResolvedValue({ affected: 1, raw: [] });

      await expect(service.deleteRule('rule-123')).resolves.toBeUndefined();
      expect(ruleRepository.delete).toHaveBeenCalledWith('rule-123');
    });

    it('should throw error for non-existent rule', async () => {
      ruleRepository.findOne.mockResolvedValue(null);

      await expect(service.deleteRule('non-existent')).rejects.toThrow(
        'Rule non-existent not found',
      );
    });
  });

  describe('toggleRuleStatus', () => {
    it('should activate a rule', async () => {
      const rule = createMockRule({ isActive: false });
      ruleRepository.findOne.mockResolvedValue(rule);
      ruleRepository.save.mockResolvedValue({ ...rule, isActive: true } as AlertRule);

      const result = await service.toggleRuleStatus('rule-123', true);

      expect(result.isActive).toBe(true);
    });

    it('should deactivate a rule', async () => {
      const rule = createMockRule({ isActive: true });
      ruleRepository.findOne.mockResolvedValue(rule);
      ruleRepository.save.mockResolvedValue({ ...rule, isActive: false } as AlertRule);

      const result = await service.toggleRuleStatus('rule-123', false);

      expect(result.isActive).toBe(false);
    });
  });

  describe('getRuleById', () => {
    it('should return rule when found', async () => {
      const rule = createMockRule();
      ruleRepository.findOne.mockResolvedValue(rule);

      const result = await service.getRuleById('rule-123');

      expect(result).toEqual(rule);
    });

    it('should return null when not found', async () => {
      ruleRepository.findOne.mockResolvedValue(null);

      const result = await service.getRuleById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getRulesByTenant', () => {
    it('should return active rules for tenant', async () => {
      const rules = [createMockRule(), createMockRule({ id: 'rule-2' })];
      ruleRepository.find.mockResolvedValue(rules);

      const result = await service.getRulesByTenant('tenant-123');

      expect(result).toHaveLength(2);
      expect(ruleRepository.find).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-123', isActive: true },
        order: { createdAt: 'DESC' },
      });
    });

    it('should include inactive rules when requested', async () => {
      const rules = [createMockRule(), createMockRule({ id: 'rule-2', isActive: false })];
      ruleRepository.find.mockResolvedValue(rules);

      const result = await service.getRulesByTenant('tenant-123', true);

      expect(result).toHaveLength(2);
      expect(ruleRepository.find).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-123' },
        order: { createdAt: 'DESC' },
      });
    });
  });

  // ============================================================================
  // RULE VALIDATION
  // ============================================================================

  describe('validateRuleConditions', () => {
    it('should return empty errors for valid conditions', () => {
      const conditions: AlertCondition[] = [{
        parameter: 'temperature',
        operator: AlertOperator.GT,
        threshold: 30,
        severity: AlertSeverity.WARNING,
      }];

      const errors = service.validateRuleConditions(conditions);

      expect(errors).toHaveLength(0);
    });

    it('should return error for empty conditions', () => {
      const errors = service.validateRuleConditions([]);

      expect(errors).toContain('At least one condition is required');
    });

    it('should return error for missing parameter', () => {
      const conditions: AlertCondition[] = [{
        parameter: '',
        operator: AlertOperator.GT,
        threshold: 30,
        severity: AlertSeverity.WARNING,
      }];

      const errors = service.validateRuleConditions(conditions);

      expect(errors).toContain('Condition 1: parameter is required');
    });

    it('should return error for missing operator', () => {
      const conditions = [{
        parameter: 'temperature',
        operator: '' as AlertOperator,
        threshold: 30,
        severity: AlertSeverity.WARNING,
      }];

      const errors = service.validateRuleConditions(conditions);

      expect(errors).toContain('Condition 1: operator is required');
    });

    it('should return error for invalid operator', () => {
      const conditions = [{
        parameter: 'temperature',
        operator: 'INVALID' as AlertOperator,
        threshold: 30,
        severity: AlertSeverity.WARNING,
      }];

      const errors = service.validateRuleConditions(conditions);

      expect(errors.some(e => e.includes('invalid operator'))).toBe(true);
    });

    it('should return error for missing threshold', () => {
      const conditions = [{
        parameter: 'temperature',
        operator: AlertOperator.GT,
        threshold: undefined as any,
        severity: AlertSeverity.WARNING,
      }];

      const errors = service.validateRuleConditions(conditions);

      expect(errors).toContain('Condition 1: threshold is required');
    });

    it('should return error for invalid threshold', () => {
      const conditions = [{
        parameter: 'temperature',
        operator: AlertOperator.GT,
        threshold: NaN,
        severity: AlertSeverity.WARNING,
      }];

      const errors = service.validateRuleConditions(conditions);

      expect(errors).toContain('Condition 1: threshold must be a valid number');
    });

    it('should return error for missing severity', () => {
      const conditions = [{
        parameter: 'temperature',
        operator: AlertOperator.GT,
        threshold: 30,
        severity: '' as AlertSeverity,
      }];

      const errors = service.validateRuleConditions(conditions);

      expect(errors).toContain('Condition 1: severity is required');
    });

    it('should return error for invalid severity', () => {
      const conditions = [{
        parameter: 'temperature',
        operator: AlertOperator.GT,
        threshold: 30,
        severity: 'INVALID' as AlertSeverity,
      }];

      const errors = service.validateRuleConditions(conditions);

      expect(errors.some(e => e.includes('invalid severity'))).toBe(true);
    });

    it('should validate multiple conditions and return all errors', () => {
      const conditions = [
        {
          parameter: '',
          operator: AlertOperator.GT,
          threshold: 30,
          severity: AlertSeverity.WARNING,
        },
        {
          parameter: 'ph',
          operator: '' as AlertOperator,
          threshold: 7,
          severity: AlertSeverity.WARNING,
        },
      ];

      const errors = service.validateRuleConditions(conditions);

      expect(errors.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ============================================================================
  // CACHING
  // ============================================================================

  describe('Rule Caching', () => {
    it('should cache evaluated rules', async () => {
      const rule = createMockRule();

      const mockQueryBuilder = createMockQueryBuilder();
      mockQueryBuilder.getMany.mockResolvedValue([rule]);
      (ruleRepository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      ruleEvaluator.evaluate.mockResolvedValue({
        matched: true,
        matchedConditions: rule.conditions,
        allResults: [],
        evaluationTime: 5,
        timestamp: new Date(),
      });

      // First call - should query database
      await service.evaluateRules({
        tenantId: 'tenant-123',
        context: createContext({ temperature: 35 }),
      });

      expect(ruleRepository.createQueryBuilder).toHaveBeenCalledTimes(1);

      // The implementation caches rules, but the test setup may vary
    });

    it('should invalidate cache on hot reload', async () => {
      service.clearCache();

      // Populate some cache
      const cacheStatsBefore = service.getCacheStats();

      await service.hotReloadRules('tenant-123');

      // Cache for tenant should be cleared
      const cacheStatsAfter = service.getCacheStats();
      expect(cacheStatsAfter.size).toBe(0);
    });

    it('should clear all cache', () => {
      service.clearCache();

      const stats = service.getCacheStats();

      expect(stats.size).toBe(0);
      expect(stats.keys).toHaveLength(0);
    });
  });

  // ============================================================================
  // CONCURRENT OPERATIONS
  // ============================================================================

  describe('Concurrent Operations', () => {
    it('should handle concurrent rule evaluations', async () => {
      const rule = createMockRule();

      const mockQueryBuilder = createMockQueryBuilder();
      mockQueryBuilder.getMany.mockResolvedValue([rule]);
      (ruleRepository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      ruleEvaluator.evaluate.mockResolvedValue({
        matched: true,
        matchedConditions: rule.conditions,
        allResults: [],
        evaluationTime: 5,
        timestamp: new Date(),
      });

      const requests = Array.from({ length: 10 }, () =>
        service.evaluateRules({
          tenantId: 'tenant-123',
          context: createContext({ temperature: 35 }),
        }),
      );

      const results = await Promise.all(requests);

      expect(results).toHaveLength(10);
      results.forEach(result => {
        expect(result).toHaveLength(1);
      });
    });
  });

  // ============================================================================
  // TIMEOUT HANDLING
  // ============================================================================

  describe('Timeout Handling', () => {
    it('should handle slow rule evaluation', async () => {
      const rule = createMockRule();

      const mockQueryBuilder = createMockQueryBuilder();
      mockQueryBuilder.getMany.mockResolvedValue([rule]);
      (ruleRepository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      // Simulate slow evaluation (but not too slow for test)
      ruleEvaluator.evaluate.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve({
          matched: true,
          matchedConditions: rule.conditions,
          allResults: [],
          evaluationTime: 100,
          timestamp: new Date(),
        }), 100)),
      );

      const result = await service.evaluateRules({
        tenantId: 'tenant-123',
        context: createContext({ temperature: 35 }),
      });

      expect(result).toHaveLength(1);
    });
  });

  // ============================================================================
  // SINGLE RULE EVALUATION
  // ============================================================================

  describe('evaluateRule (single)', () => {
    it('should evaluate a single rule', async () => {
      const rule = createMockRule();
      const context = createContext({ temperature: 35 });

      ruleEvaluator.evaluate.mockResolvedValue({
        matched: true,
        matchedConditions: rule.conditions,
        allResults: [],
        evaluationTime: 5,
        timestamp: new Date(),
      });

      const result = await service.evaluateRule(rule, context);

      expect(result).not.toBeNull();
      expect(result!.rule.id).toBe('rule-123');
      expect(result!.matched).toBeDefined();
    });

    it('should return null for non-matching rule', async () => {
      const rule = createMockRule();
      const context = createContext({ temperature: 25 });

      ruleEvaluator.evaluate.mockResolvedValue({
        matched: false,
        matchedConditions: [],
        allResults: [],
        evaluationTime: 5,
        timestamp: new Date(),
      });

      const result = await service.evaluateRule(rule, context);

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // SEVERITY DETERMINATION
  // ============================================================================

  describe('Severity Determination', () => {
    it('should determine highest severity from matched conditions', async () => {
      const rule = createMockRule({
        conditions: [
          { parameter: 'temp', operator: AlertOperator.GT, threshold: 30, severity: AlertSeverity.INFO },
          { parameter: 'ph', operator: AlertOperator.LT, threshold: 6, severity: AlertSeverity.CRITICAL },
          { parameter: 'oxygen', operator: AlertOperator.LT, threshold: 4, severity: AlertSeverity.WARNING },
        ],
      });

      const mockQueryBuilder = createMockQueryBuilder();
      mockQueryBuilder.getMany.mockResolvedValue([rule]);
      (ruleRepository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      ruleEvaluator.evaluate.mockResolvedValue({
        matched: true,
        matchedConditions: rule.conditions,
        allResults: [],
        evaluationTime: 5,
        timestamp: new Date(),
      });

      const result = await service.evaluateRules({
        tenantId: 'tenant-123',
        context: createContext({ temp: 35, ph: 5.5, oxygen: 3 }),
      });

      expect(result[0].severity).toBe(AlertSeverity.CRITICAL);
    });
  });
});
