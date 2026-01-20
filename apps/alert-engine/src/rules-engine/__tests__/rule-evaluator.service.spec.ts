import { Test, TestingModule } from '@nestjs/testing';
import {
  RuleEvaluatorService,
  EvaluationContext,
  LogicalOperator,
  ComplexCondition,
} from '../rule-evaluator.service';
import {
  AlertRule,
  AlertCondition,
  AlertOperator,
  AlertSeverity,
} from '../../database/entities/alert-rule.entity';

describe('RuleEvaluatorService', () => {
  let service: RuleEvaluatorService;

  // Helper to create mock rule
  const createMockRule = (conditions: AlertCondition[]): AlertRule => {
    const rule = new AlertRule();
    rule.id = 'rule-123';
    rule.name = 'Test Rule';
    rule.tenantId = 'tenant-123';
    rule.conditions = conditions;
    rule.isActive = true;
    return rule;
  };

  // Helper to create mock condition
  const createCondition = (
    parameter: string,
    operator: AlertOperator,
    threshold: number,
    severity: AlertSeverity = AlertSeverity.WARNING,
  ): AlertCondition => ({
    parameter,
    operator,
    threshold,
    severity,
  });

  // Helper to create evaluation context
  const createContext = (values: Record<string, number | string | boolean | null>): EvaluationContext => ({
    values,
    timestamp: new Date(),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RuleEvaluatorService],
    }).compile();

    service = module.get<RuleEvaluatorService>(RuleEvaluatorService);
  });

  // ============================================================================
  // RULE EVALUATION (Kural Değerlendirme)
  // ============================================================================

  describe('Basic Rule Evaluation', () => {
    it('should evaluate threshold-based rule (greater than) successfully', async () => {
      const condition = createCondition('temperature', AlertOperator.GT, 30);
      const rule = createMockRule([condition]);
      const context = createContext({ temperature: 35 });

      const result = await service.evaluate(rule, context);

      expect(result.matched).toBe(true);
      expect(result.matchedConditions).toHaveLength(1);
      expect(result.matchedConditions[0].parameter).toBe('temperature');
    });

    it('should evaluate threshold-based rule (less than) successfully', async () => {
      const condition = createCondition('ph', AlertOperator.LT, 6.5);
      const rule = createMockRule([condition]);
      const context = createContext({ ph: 6.0 });

      const result = await service.evaluate(rule, context);

      expect(result.matched).toBe(true);
    });

    it('should evaluate threshold-based rule (greater than or equal) successfully', async () => {
      const condition = createCondition('dissolvedOxygen', AlertOperator.GTE, 5);
      const rule = createMockRule([condition]);
      const context = createContext({ dissolvedOxygen: 5 });

      const result = await service.evaluate(rule, context);

      expect(result.matched).toBe(true);
    });

    it('should evaluate threshold-based rule (less than or equal) successfully', async () => {
      const condition = createCondition('salinity', AlertOperator.LTE, 35);
      const rule = createMockRule([condition]);
      const context = createContext({ salinity: 35 });

      const result = await service.evaluate(rule, context);

      expect(result.matched).toBe(true);
    });

    it('should evaluate threshold-based rule (equal) successfully', async () => {
      const condition = createCondition('status', AlertOperator.EQ, 1);
      const rule = createMockRule([condition]);
      const context = createContext({ status: 1 });

      const result = await service.evaluate(rule, context);

      expect(result.matched).toBe(true);
    });

    it('should return false when condition is not met', async () => {
      const condition = createCondition('temperature', AlertOperator.GT, 30);
      const rule = createMockRule([condition]);
      const context = createContext({ temperature: 25 });

      const result = await service.evaluate(rule, context);

      expect(result.matched).toBe(false);
      expect(result.matchedConditions).toHaveLength(0);
    });

    it('should evaluate multiple conditions with OR logic (default)', async () => {
      const conditions = [
        createCondition('temperature', AlertOperator.GT, 35),
        createCondition('ph', AlertOperator.LT, 6),
      ];
      const rule = createMockRule(conditions);
      const context = createContext({ temperature: 30, ph: 5.5 }); // Only pH matches

      const result = await service.evaluate(rule, context);

      expect(result.matched).toBe(true);
      expect(result.matchedConditions).toHaveLength(1);
      expect(result.matchedConditions[0].parameter).toBe('ph');
    });

    it('should handle empty rule set without error', async () => {
      const rule = createMockRule([]);
      const context = createContext({ temperature: 25 });

      const result = await service.evaluate(rule, context);

      expect(result.matched).toBe(false);
      expect(result.matchedConditions).toHaveLength(0);
    });

    it('should handle null values safely', async () => {
      const condition = createCondition('temperature', AlertOperator.GT, 30);
      const rule = createMockRule([condition]);
      const context = createContext({ temperature: null });

      const result = await service.evaluate(rule, context);

      expect(result.matched).toBe(false);
    });

    it('should handle undefined values safely', async () => {
      const condition = createCondition('temperature', AlertOperator.GT, 30);
      const rule = createMockRule([condition]);
      const context = createContext({});

      const result = await service.evaluate(rule, context);

      expect(result.matched).toBe(false);
    });

    it('should record evaluation time', async () => {
      const condition = createCondition('temperature', AlertOperator.GT, 30);
      const rule = createMockRule([condition]);
      const context = createContext({ temperature: 35 });

      const result = await service.evaluate(rule, context);

      expect(result.evaluationTime).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeInstanceOf(Date);
    });
  });

  // ============================================================================
  // AND OPERATOR TESTS
  // ============================================================================

  describe('AND Operator Evaluation', () => {
    it('should match when ALL conditions are met', async () => {
      const conditions = [
        createCondition('temperature', AlertOperator.GT, 25),
        createCondition('ph', AlertOperator.LT, 7),
      ];
      const rule = createMockRule(conditions);
      const context = createContext({ temperature: 30, ph: 6.5 });

      const result = await service.evaluateWithAnd(rule, context);

      expect(result.matched).toBe(true);
      expect(result.matchedConditions).toHaveLength(2);
    });

    it('should NOT match when ANY condition fails', async () => {
      const conditions = [
        createCondition('temperature', AlertOperator.GT, 25),
        createCondition('ph', AlertOperator.LT, 6), // This will fail
      ];
      const rule = createMockRule(conditions);
      const context = createContext({ temperature: 30, ph: 6.5 });

      const result = await service.evaluateWithAnd(rule, context);

      expect(result.matched).toBe(false);
      expect(result.matchedConditions).toHaveLength(0);
    });

    it('should short-circuit on first failure', async () => {
      const conditions = [
        createCondition('temperature', AlertOperator.GT, 100), // Will fail first
        createCondition('ph', AlertOperator.LT, 7),
        createCondition('oxygen', AlertOperator.GT, 5),
      ];
      const rule = createMockRule(conditions);
      const context = createContext({ temperature: 30, ph: 6.5, oxygen: 6 });

      const result = await service.evaluateWithAnd(rule, context);

      expect(result.matched).toBe(false);
      // Only first condition should be evaluated due to short-circuit
      expect(result.allResults.length).toBeLessThanOrEqual(1);
    });
  });

  // ============================================================================
  // COMPLEX NESTED CONDITIONS
  // ============================================================================

  describe('Complex Nested Conditions', () => {
    it('should evaluate nested AND conditions', async () => {
      const complex: ComplexCondition = {
        type: 'group',
        operator: LogicalOperator.AND,
        children: [
          {
            type: 'simple',
            condition: createCondition('temperature', AlertOperator.GT, 25),
          },
          {
            type: 'simple',
            condition: createCondition('ph', AlertOperator.LT, 7),
          },
        ],
      };
      const context = createContext({ temperature: 30, ph: 6.5 });

      const result = await service.evaluateComplex(complex, context);

      expect(result).toBe(true);
    });

    it('should evaluate nested OR conditions', async () => {
      const complex: ComplexCondition = {
        type: 'group',
        operator: LogicalOperator.OR,
        children: [
          {
            type: 'simple',
            condition: createCondition('temperature', AlertOperator.GT, 35),
          },
          {
            type: 'simple',
            condition: createCondition('ph', AlertOperator.LT, 7),
          },
        ],
      };
      const context = createContext({ temperature: 30, ph: 6.5 });

      const result = await service.evaluateComplex(complex, context);

      expect(result).toBe(true); // pH < 7 matches
    });

    it('should evaluate NOT conditions', async () => {
      const complex: ComplexCondition = {
        type: 'group',
        operator: LogicalOperator.NOT,
        children: [
          {
            type: 'simple',
            condition: createCondition('temperature', AlertOperator.GT, 35),
          },
        ],
      };
      const context = createContext({ temperature: 30 });

      const result = await service.evaluateComplex(complex, context);

      expect(result).toBe(true); // NOT (30 > 35) = NOT false = true
    });

    it('should evaluate deeply nested conditions', async () => {
      // (temp > 25 AND (ph < 7 OR oxygen < 5))
      const complex: ComplexCondition = {
        type: 'group',
        operator: LogicalOperator.AND,
        children: [
          {
            type: 'simple',
            condition: createCondition('temperature', AlertOperator.GT, 25),
          },
          {
            type: 'group',
            operator: LogicalOperator.OR,
            children: [
              {
                type: 'simple',
                condition: createCondition('ph', AlertOperator.LT, 7),
              },
              {
                type: 'simple',
                condition: createCondition('oxygen', AlertOperator.LT, 5),
              },
            ],
          },
        ],
      };
      const context = createContext({ temperature: 30, ph: 7.5, oxygen: 4 });

      const result = await service.evaluateComplex(complex, context);

      expect(result).toBe(true); // temp > 25 AND (ph !< 7 OR oxygen < 5)
    });
  });

  // ============================================================================
  // THRESHOLD-BASED RULES
  // ============================================================================

  describe('Threshold Rules', () => {
    it('evaluateGreaterThan: should return true when value > threshold', () => {
      expect(service.evaluateGreaterThan(10, 5)).toBe(true);
      expect(service.evaluateGreaterThan(5, 10)).toBe(false);
      expect(service.evaluateGreaterThan(5, 5)).toBe(false);
    });

    it('evaluateLessThan: should return true when value < threshold', () => {
      expect(service.evaluateLessThan(5, 10)).toBe(true);
      expect(service.evaluateLessThan(10, 5)).toBe(false);
      expect(service.evaluateLessThan(5, 5)).toBe(false);
    });

    it('evaluateBetween: should return true when value in range', () => {
      expect(service.evaluateBetween(5, 1, 10)).toBe(true);
      expect(service.evaluateBetween(1, 1, 10)).toBe(true);
      expect(service.evaluateBetween(10, 1, 10)).toBe(true);
      expect(service.evaluateBetween(0, 1, 10)).toBe(false);
      expect(service.evaluateBetween(11, 1, 10)).toBe(false);
    });
  });

  // ============================================================================
  // RATE-OF-CHANGE RULES
  // ============================================================================

  describe('Rate-of-Change Rules', () => {
    it('should detect percentage increase', () => {
      const result = service.evaluateRateOfChange(110, 100, 5, 'increase');
      expect(result).toBe(true); // 10% increase >= 5%

      const result2 = service.evaluateRateOfChange(104, 100, 5, 'increase');
      expect(result2).toBe(false); // 4% increase < 5%
    });

    it('should detect percentage decrease', () => {
      const result = service.evaluateRateOfChange(90, 100, 5, 'decrease');
      expect(result).toBe(true); // 10% decrease >= 5%

      const result2 = service.evaluateRateOfChange(96, 100, 5, 'decrease');
      expect(result2).toBe(false); // 4% decrease < 5%
    });

    it('should detect any direction change', () => {
      expect(service.evaluateRateOfChange(110, 100, 5, 'any')).toBe(true);
      expect(service.evaluateRateOfChange(90, 100, 5, 'any')).toBe(true);
      expect(service.evaluateRateOfChange(103, 100, 5, 'any')).toBe(false);
    });

    it('should handle zero previous value', () => {
      const result = service.evaluateRateOfChange(10, 0, 5, 'any');
      expect(result).toBe(true); // Any change from 0
    });

    it('should evaluate rate_of_change_ parameter prefix', async () => {
      const condition = createCondition('rate_of_change_temperature', AlertOperator.GT, 10);
      const rule = createMockRule([condition]);
      const context: EvaluationContext = {
        values: { temperature: 33 },
        previousValues: { temperature: 30 },
      };

      const result = await service.evaluate(rule, context);

      expect(result.matched).toBe(true); // 10% increase
    });
  });

  // ============================================================================
  // CONSECUTIVE OCCURRENCE RULES
  // ============================================================================

  describe('Consecutive Occurrence Rules', () => {
    it('should detect consecutive occurrences', () => {
      const occurrences = [false, false, true, true, true, false];
      expect(service.evaluateConsecutiveOccurrences(occurrences, 3)).toBe(true);
    });

    it('should NOT detect when not enough consecutive', () => {
      const occurrences = [false, true, true, false, true, true];
      expect(service.evaluateConsecutiveOccurrences(occurrences, 3)).toBe(false);
    });

    it('should detect at the end of array', () => {
      const occurrences = [false, false, true, true, true];
      expect(service.evaluateConsecutiveOccurrences(occurrences, 3)).toBe(true);
    });

    it('should handle empty array', () => {
      expect(service.evaluateConsecutiveOccurrences([], 3)).toBe(false);
    });

    it('should handle all true array', () => {
      const occurrences = [true, true, true, true, true];
      expect(service.evaluateConsecutiveOccurrences(occurrences, 3)).toBe(true);
    });
  });

  // ============================================================================
  // TIME-WINDOW RULES
  // ============================================================================

  describe('Time-Window Rules', () => {
    it('should detect N events in M minutes', () => {
      const now = new Date();
      const timestamps = [
        new Date(now.getTime() - 1 * 60 * 1000), // 1 min ago
        new Date(now.getTime() - 2 * 60 * 1000), // 2 min ago
        new Date(now.getTime() - 3 * 60 * 1000), // 3 min ago
      ];

      expect(service.evaluateTimeWindow(timestamps, 5, 3)).toBe(true);
    });

    it('should NOT detect when not enough events in window', () => {
      const now = new Date();
      const timestamps = [
        new Date(now.getTime() - 10 * 60 * 1000), // 10 min ago
        new Date(now.getTime() - 20 * 60 * 1000), // 20 min ago
      ];

      expect(service.evaluateTimeWindow(timestamps, 5, 3)).toBe(false);
    });

    it('should exclude events outside window', () => {
      const now = new Date();
      const timestamps = [
        new Date(now.getTime() - 1 * 60 * 1000), // In window
        new Date(now.getTime() - 2 * 60 * 1000), // In window
        new Date(now.getTime() - 10 * 60 * 1000), // Outside 5-min window
      ];

      expect(service.evaluateTimeWindow(timestamps, 5, 3)).toBe(false);
    });
  });

  // ============================================================================
  // AGGREGATION RULES
  // ============================================================================

  describe('Aggregation Rules', () => {
    const values = [10, 20, 30, 40, 50];

    it('should evaluate average aggregation', () => {
      // Average = 30
      expect(service.evaluateAggregation(values, 'avg', AlertOperator.EQ, 30)).toBe(true);
      expect(service.evaluateAggregation(values, 'avg', AlertOperator.GT, 25)).toBe(true);
    });

    it('should evaluate sum aggregation', () => {
      // Sum = 150
      expect(service.evaluateAggregation(values, 'sum', AlertOperator.EQ, 150)).toBe(true);
      expect(service.evaluateAggregation(values, 'sum', AlertOperator.GT, 100)).toBe(true);
    });

    it('should evaluate count aggregation', () => {
      expect(service.evaluateAggregation(values, 'count', AlertOperator.EQ, 5)).toBe(true);
    });

    it('should evaluate min aggregation', () => {
      expect(service.evaluateAggregation(values, 'min', AlertOperator.EQ, 10)).toBe(true);
    });

    it('should evaluate max aggregation', () => {
      expect(service.evaluateAggregation(values, 'max', AlertOperator.EQ, 50)).toBe(true);
    });

    it('should handle empty values array', () => {
      expect(service.evaluateAggregation([], 'avg', AlertOperator.EQ, 0)).toBe(false);
    });
  });

  // ============================================================================
  // REGEX PATTERN MATCHING
  // ============================================================================

  describe('Regex Pattern Matching', () => {
    it('should match valid patterns', () => {
      expect(service.evaluateRegex('error-500', '^error-\\d+$')).toBe(true);
      expect(service.evaluateRegex('warning', '^warn')).toBe(true);
      expect(service.evaluateRegex('sensor_temp_001', 'temp')).toBe(true);
    });

    it('should NOT match invalid patterns', () => {
      expect(service.evaluateRegex('success', '^error')).toBe(false);
    });

    it('should handle invalid regex gracefully', () => {
      expect(service.evaluateRegex('test', '[invalid regex')).toBe(false);
    });
  });

  // ============================================================================
  // DATE RANGE RULES
  // ============================================================================

  describe('Date Range Rules', () => {
    it('should match date within range', () => {
      const date = new Date('2024-06-15');
      const start = new Date('2024-01-01');
      const end = new Date('2024-12-31');

      expect(service.evaluateDateRange(date, start, end)).toBe(true);
    });

    it('should match date at boundaries', () => {
      const start = new Date('2024-01-01');
      const end = new Date('2024-12-31');

      expect(service.evaluateDateRange(start, start, end)).toBe(true);
      expect(service.evaluateDateRange(end, start, end)).toBe(true);
    });

    it('should NOT match date outside range', () => {
      const date = new Date('2025-06-15');
      const start = new Date('2024-01-01');
      const end = new Date('2024-12-31');

      expect(service.evaluateDateRange(date, start, end)).toBe(false);
    });
  });

  // ============================================================================
  // TIME-OF-DAY RULES
  // ============================================================================

  describe('Time-of-Day Rules', () => {
    it('should match time within range', () => {
      const date = new Date('2024-06-15T14:30:00');
      expect(service.evaluateTimeOfDay(date, '09:00', '18:00')).toBe(true);
    });

    it('should handle overnight ranges', () => {
      const nightDate = new Date('2024-06-15T23:30:00');
      expect(service.evaluateTimeOfDay(nightDate, '22:00', '06:00')).toBe(true);

      const earlyMorning = new Date('2024-06-15T04:00:00');
      expect(service.evaluateTimeOfDay(earlyMorning, '22:00', '06:00')).toBe(true);
    });

    it('should NOT match time outside range', () => {
      const date = new Date('2024-06-15T20:30:00');
      expect(service.evaluateTimeOfDay(date, '09:00', '18:00')).toBe(false);
    });
  });

  // ============================================================================
  // ABSENCE RULES
  // ============================================================================

  describe('Absence Rules', () => {
    it('should detect absence when no event ever occurred', () => {
      expect(service.evaluateAbsence(null, 5)).toBe(true);
    });

    it('should detect absence when last event too old', () => {
      const lastEvent = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
      expect(service.evaluateAbsence(lastEvent, 5)).toBe(true);
    });

    it('should NOT detect absence when recent event', () => {
      const lastEvent = new Date(Date.now() - 2 * 60 * 1000); // 2 min ago
      expect(service.evaluateAbsence(lastEvent, 5)).toBe(false);
    });
  });

  // ============================================================================
  // ANOMALY DETECTION
  // ============================================================================

  describe('Anomaly Detection', () => {
    it('should detect anomaly with z-score', () => {
      const historical = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]; // Mean=10, StdDev≈0
      expect(service.evaluateAnomaly(50, historical, 2)).toBe(true); // Far from mean
    });

    it('should NOT detect anomaly for normal value', () => {
      const historical = [8, 9, 10, 11, 12, 10, 9, 11, 10, 10];
      expect(service.evaluateAnomaly(10, historical, 2)).toBe(false);
    });

    it('should require minimum historical data', () => {
      const historical = [10, 10, 10]; // Only 3 values
      expect(service.evaluateAnomaly(100, historical, 2)).toBe(false);
    });

    it('should handle zero standard deviation', () => {
      const historical = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
      expect(service.evaluateAnomaly(11, historical, 2)).toBe(true);
      expect(service.evaluateAnomaly(10, historical, 2)).toBe(false);
    });
  });

  // ============================================================================
  // CONTEXT VARIABLE RESOLUTION
  // ============================================================================

  describe('Context Variable Resolution', () => {
    it('should resolve direct values', async () => {
      const condition = createCondition('temperature', AlertOperator.GT, 30);
      const rule = createMockRule([condition]);
      const context = createContext({ temperature: 35 });

      const result = await service.evaluate(rule, context);
      expect(result.matched).toBe(true);
    });

    it('should resolve local variables', async () => {
      const condition = createCondition('localTemp', AlertOperator.GT, 30);
      const rule = createMockRule([condition]);
      const context: EvaluationContext = {
        values: {},
        localVars: { localTemp: 35 },
      };

      const result = await service.evaluate(rule, context);
      expect(result.matched).toBe(true);
    });

    it('should resolve global variables', async () => {
      const condition = createCondition('globalThreshold', AlertOperator.LT, 100);
      const rule = createMockRule([condition]);
      const context: EvaluationContext = {
        values: {},
        globalVars: { globalThreshold: 50 },
      };

      const result = await service.evaluate(rule, context);
      expect(result.matched).toBe(true);
    });

    it('should handle undefined variables with default', async () => {
      const condition = createCondition('missingVar', AlertOperator.GT, 0);
      const rule = createMockRule([condition]);
      const context = createContext({});

      const result = await service.evaluate(rule, context);
      expect(result.matched).toBe(false);
    });

    it('should perform type coercion for string values', async () => {
      const condition = createCondition('stringValue', AlertOperator.GT, 10);
      const rule = createMockRule([condition]);
      const context = createContext({ stringValue: '25' as any });

      const result = await service.evaluate(rule, context);
      expect(result.matched).toBe(true);
    });
  });

  // ============================================================================
  // EDGE CASES
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle NaN values', async () => {
      const condition = createCondition('temperature', AlertOperator.GT, 30);
      const rule = createMockRule([condition]);
      const context = createContext({ temperature: NaN as any });

      const result = await service.evaluate(rule, context);
      expect(result.matched).toBe(false);
    });

    it('should handle Infinity values', async () => {
      const condition = createCondition('value', AlertOperator.GT, 1000);
      const rule = createMockRule([condition]);
      const context = createContext({ value: Infinity as any });

      const result = await service.evaluate(rule, context);
      expect(result.matched).toBe(true);
    });

    it('should handle negative values', async () => {
      const condition = createCondition('temperature', AlertOperator.LT, 0);
      const rule = createMockRule([condition]);
      const context = createContext({ temperature: -10 });

      const result = await service.evaluate(rule, context);
      expect(result.matched).toBe(true);
    });

    it('should handle very large numbers', async () => {
      const condition = createCondition('count', AlertOperator.GT, 1e10);
      const rule = createMockRule([condition]);
      const context = createContext({ count: 1e11 });

      const result = await service.evaluate(rule, context);
      expect(result.matched).toBe(true);
    });

    it('should handle very small decimal numbers', async () => {
      const condition = createCondition('precision', AlertOperator.LT, 0.0001);
      const rule = createMockRule([condition]);
      const context = createContext({ precision: 0.00001 });

      const result = await service.evaluate(rule, context);
      expect(result.matched).toBe(true);
    });
  });

  // ============================================================================
  // PERFORMANCE TESTS
  // ============================================================================

  describe('Performance', () => {
    it('should evaluate simple rule under 50ms', async () => {
      const condition = createCondition('temperature', AlertOperator.GT, 30);
      const rule = createMockRule([condition]);
      const context = createContext({ temperature: 35 });

      const start = Date.now();
      await service.evaluate(rule, context);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(50);
    });

    it('should handle many conditions efficiently', async () => {
      const conditions = Array.from({ length: 100 }, (_, i) =>
        createCondition(`param${i}`, AlertOperator.GT, i),
      );
      const rule = createMockRule(conditions);

      const values: Record<string, number> = {};
      for (let i = 0; i < 100; i++) {
        values[`param${i}`] = i + 1; // All will match
      }
      const context = createContext(values);

      const start = Date.now();
      const result = await service.evaluate(rule, context);
      const duration = Date.now() - start;

      expect(result.matched).toBe(true);
      expect(result.matchedConditions).toHaveLength(100);
      expect(duration).toBeLessThan(100);
    });
  });
});
