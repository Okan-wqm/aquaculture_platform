import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  RiskCalculatorService,
  RiskFactorCategory,
  RiskCalculationContext,
  RiskFactor,
} from '../risk-calculator.service';
import { ImpactAnalyzerService, ImpactAnalysisResult, ImpactLevel, ImpactCategory } from '../impact-analyzer.service';
import { SeverityClassifierService } from '../severity-classifier.service';
import { AlertRule, AlertSeverity } from '../../database/entities/alert-rule.entity';

describe('RiskCalculatorService', () => {
  let service: RiskCalculatorService;
  let alertRuleRepository: jest.Mocked<Repository<AlertRule>>;
  let impactAnalyzer: jest.Mocked<ImpactAnalyzerService>;
  let severityClassifier: jest.Mocked<SeverityClassifierService>;

  const mockAlertRule: Partial<AlertRule> = {
    id: 'rule-1',
    tenantId: 'tenant-1',
    name: 'Temperature Alert',
    severity: AlertSeverity.HIGH,
    isActive: true,
  };

  const mockImpactResult: ImpactAnalysisResult = {
    totalImpactScore: 60,
    businessImpact: {
      category: ImpactCategory.BUSINESS,
      level: ImpactLevel.MEDIUM,
      score: 50,
      factors: ['Farm operations affected'],
    },
    technicalImpact: {
      category: ImpactCategory.TECHNICAL,
      level: ImpactLevel.MEDIUM,
      score: 55,
      factors: ['Sensor monitoring affected'],
    },
    financialImpact: {
      category: ImpactCategory.FINANCIAL,
      level: ImpactLevel.LOW,
      score: 30,
      factors: ['Potential production losses'],
    },
    complianceImpact: {
      category: ImpactCategory.COMPLIANCE,
      level: ImpactLevel.LOW,
      score: 25,
      factors: ['Environmental compliance monitoring affected'],
    },
    affectedSystems: ['Sensor Network', 'Farm Management System'],
    estimatedDowntime: 60,
    estimatedCost: 5000,
    summary: 'Medium impact on farm operations',
    analyzedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RiskCalculatorService,
        {
          provide: getRepositoryToken(AlertRule),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: ImpactAnalyzerService,
          useValue: {
            analyzeImpact: jest.fn(),
          },
        },
        {
          provide: SeverityClassifierService,
          useValue: {
            classifyBySCore: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<RiskCalculatorService>(RiskCalculatorService);
    alertRuleRepository = module.get(getRepositoryToken(AlertRule));
    impactAnalyzer = module.get(ImpactAnalyzerService);
    severityClassifier = module.get(SeverityClassifierService);

    // Default mocks
    alertRuleRepository.findOne.mockResolvedValue(mockAlertRule as AlertRule);
    impactAnalyzer.analyzeImpact.mockResolvedValue(mockImpactResult);
    severityClassifier.classifyBySCore.mockReturnValue(AlertSeverity.HIGH);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('calculateRiskScore', () => {
    const baseContext: RiskCalculationContext = {
      tenantId: 'tenant-1',
      ruleId: 'rule-1',
      currentValue: 35,
      thresholdValue: 30,
    };

    it('should calculate risk score for basic context', async () => {
      const result = await service.calculateRiskScore(baseContext);

      expect(result).toBeDefined();
      expect(result.totalScore).toBeGreaterThanOrEqual(0);
      expect(result.totalScore).toBeLessThanOrEqual(100);
      expect(result.normalizedScore).toBeGreaterThanOrEqual(0);
      expect(result.normalizedScore).toBeLessThanOrEqual(1);
      expect(result.factors).toHaveLength(6);
      expect(result.severity).toBeDefined();
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.calculatedAt).toBeInstanceOf(Date);
    });

    it('should include all risk factor categories', async () => {
      const result = await service.calculateRiskScore(baseContext);

      const categories = result.factors.map(f => f.category);
      expect(categories).toContain(RiskFactorCategory.FREQUENCY);
      expect(categories).toContain(RiskFactorCategory.SEVERITY);
      expect(categories).toContain(RiskFactorCategory.IMPACT);
      expect(categories).toContain(RiskFactorCategory.HISTORY);
      expect(categories).toContain(RiskFactorCategory.CONTEXT);
      expect(categories).toContain(RiskFactorCategory.TREND);
    });

    it('should call impact analyzer with correct context', async () => {
      await service.calculateRiskScore({
        ...baseContext,
        farmId: 'farm-1',
        sensorId: 'sensor-1',
      });

      expect(impactAnalyzer.analyzeImpact).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        farmId: 'farm-1',
        sensorId: 'sensor-1',
        currentValue: 35,
      });
    });

    it('should generate recommendations based on risk score', async () => {
      const result = await service.calculateRiskScore(baseContext);

      expect(result.recommendations).toBeDefined();
      expect(Array.isArray(result.recommendations)).toBe(true);
    });

    it('should calculate higher risk for more historical incidents', async () => {
      const lowIncidentContext: RiskCalculationContext = {
        ...baseContext,
        previousIncidents: 1,
      };

      const highIncidentContext: RiskCalculationContext = {
        ...baseContext,
        previousIncidents: 15,
      };

      const lowResult = await service.calculateRiskScore(lowIncidentContext);
      const highResult = await service.calculateRiskScore(highIncidentContext);

      const lowFrequencyFactor = lowResult.factors.find(
        f => f.category === RiskFactorCategory.FREQUENCY
      );
      const highFrequencyFactor = highResult.factors.find(
        f => f.category === RiskFactorCategory.FREQUENCY
      );

      expect(highFrequencyFactor!.value).toBeGreaterThan(lowFrequencyFactor!.value);
    });

    it('should increase frequency factor for recent incidents', async () => {
      const recentContext: RiskCalculationContext = {
        ...baseContext,
        previousIncidents: 5,
        lastIncidentDate: new Date(), // today
      };

      const oldContext: RiskCalculationContext = {
        ...baseContext,
        previousIncidents: 5,
        lastIncidentDate: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 60 days ago
      };

      const recentResult = await service.calculateRiskScore(recentContext);
      const oldResult = await service.calculateRiskScore(oldContext);

      const recentFactor = recentResult.factors.find(
        f => f.category === RiskFactorCategory.FREQUENCY
      );
      const oldFactor = oldResult.factors.find(
        f => f.category === RiskFactorCategory.FREQUENCY
      );

      expect(recentFactor!.value).toBeGreaterThan(oldFactor!.value);
    });

    it('should handle missing rule gracefully', async () => {
      alertRuleRepository.findOne.mockResolvedValue(null);

      const result = await service.calculateRiskScore(baseContext);

      expect(result).toBeDefined();
      expect(result.totalScore).toBeGreaterThanOrEqual(0);
    });

    it('should calculate severity factor based on rule severity', async () => {
      // Test with CRITICAL severity rule
      alertRuleRepository.findOne.mockResolvedValue({
        ...mockAlertRule,
        severity: AlertSeverity.CRITICAL,
      } as AlertRule);

      const criticalResult = await service.calculateRiskScore(baseContext);
      const criticalSeverityFactor = criticalResult.factors.find(
        f => f.category === RiskFactorCategory.SEVERITY
      );

      // Test with LOW severity rule
      alertRuleRepository.findOne.mockResolvedValue({
        ...mockAlertRule,
        severity: AlertSeverity.LOW,
      } as AlertRule);

      const lowResult = await service.calculateRiskScore(baseContext);
      const lowSeverityFactor = lowResult.factors.find(
        f => f.category === RiskFactorCategory.SEVERITY
      );

      expect(criticalSeverityFactor!.value).toBeGreaterThan(lowSeverityFactor!.value);
    });

    it('should adjust severity factor based on threshold deviation', async () => {
      const smallDeviationContext: RiskCalculationContext = {
        ...baseContext,
        currentValue: 31,
        thresholdValue: 30,
      };

      const largeDeviationContext: RiskCalculationContext = {
        ...baseContext,
        currentValue: 50,
        thresholdValue: 30,
      };

      const smallResult = await service.calculateRiskScore(smallDeviationContext);
      const largeResult = await service.calculateRiskScore(largeDeviationContext);

      const smallFactor = smallResult.factors.find(
        f => f.category === RiskFactorCategory.SEVERITY
      );
      const largeFactor = largeResult.factors.find(
        f => f.category === RiskFactorCategory.SEVERITY
      );

      expect(largeFactor!.value).toBeGreaterThan(smallFactor!.value);
    });
  });

  describe('calculateWeightedScore', () => {
    it('should calculate weighted average of factors', () => {
      const factors: RiskFactor[] = [
        { category: RiskFactorCategory.SEVERITY, name: 'Test', value: 100, weight: 0.5 },
        { category: RiskFactorCategory.IMPACT, name: 'Test', value: 0, weight: 0.5 },
      ];

      const score = service.calculateWeightedScore(factors);

      expect(score).toBe(50);
    });

    it('should handle different weights correctly', () => {
      const factors: RiskFactor[] = [
        { category: RiskFactorCategory.SEVERITY, name: 'Test', value: 100, weight: 0.75 },
        { category: RiskFactorCategory.IMPACT, name: 'Test', value: 0, weight: 0.25 },
      ];

      const score = service.calculateWeightedScore(factors);

      expect(score).toBe(75);
    });

    it('should cap score at 100', () => {
      const factors: RiskFactor[] = [
        { category: RiskFactorCategory.SEVERITY, name: 'Test', value: 150, weight: 1.0 },
      ];

      const score = service.calculateWeightedScore(factors);

      expect(score).toBeLessThanOrEqual(100);
    });

    it('should floor score at 0', () => {
      const factors: RiskFactor[] = [
        { category: RiskFactorCategory.SEVERITY, name: 'Test', value: -50, weight: 1.0 },
      ];

      const score = service.calculateWeightedScore(factors);

      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('should return 0 for empty factors', () => {
      const score = service.calculateWeightedScore([]);

      expect(score).toBe(0);
    });

    it('should handle zero total weight', () => {
      const factors: RiskFactor[] = [
        { category: RiskFactorCategory.SEVERITY, name: 'Test', value: 50, weight: 0 },
      ];

      const score = service.calculateWeightedScore(factors);

      expect(score).toBe(0);
    });
  });

  describe('calculateFrequencyFactor', () => {
    it('should return low value for no previous incidents', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        previousIncidents: 0,
      };

      const factor = service.calculateFrequencyFactor(context);

      expect(factor.value).toBe(10);
      expect(factor.category).toBe(RiskFactorCategory.FREQUENCY);
    });

    it('should return high value for many previous incidents', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        previousIncidents: 15,
      };

      const factor = service.calculateFrequencyFactor(context);

      expect(factor.value).toBe(90);
    });

    it('should increase value for very recent incidents', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        previousIncidents: 5,
        lastIncidentDate: new Date(Date.now() - 1000 * 60 * 60), // 1 hour ago
      };

      const factor = service.calculateFrequencyFactor(context);

      expect(factor.value).toBe(70); // 50 + 20 for recent
    });

    it('should decrease value for old incidents', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        previousIncidents: 5,
        lastIncidentDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60), // 60 days ago
      };

      const factor = service.calculateFrequencyFactor(context);

      expect(factor.value).toBe(40); // 50 - 10 for old
    });
  });

  describe('calculateHistoryFactor', () => {
    it('should return default value when no historical data', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      };

      const factor = service.calculateHistoryFactor(context);

      expect(factor.value).toBe(50);
      expect(factor.category).toBe(RiskFactorCategory.HISTORY);
    });

    it('should return high value for z-score > 3', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 100,
        historicalValues: [20, 21, 19, 20, 22, 18, 20, 21], // Mean ~20, StdDev ~1.2
      };

      const factor = service.calculateHistoryFactor(context);

      expect(factor.value).toBe(95);
    });

    it('should return moderate value for z-score between 1 and 2', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 25,
        historicalValues: [20, 21, 19, 20, 22, 18, 20, 21], // Mean ~20
      };

      const factor = service.calculateHistoryFactor(context);

      expect(factor.value).toBe(80);
    });

    it('should return low value for normal deviation', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 20,
        historicalValues: [20, 21, 19, 20, 22, 18, 20, 21],
      };

      const factor = service.calculateHistoryFactor(context);

      expect(factor.value).toBe(30);
    });
  });

  describe('calculateTrendFactor', () => {
    it('should return default for insufficient historical data', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        historicalValues: [20, 21], // Only 2 values
      };

      const factor = service.calculateTrendFactor(context);

      expect(factor.value).toBe(50);
    });

    it('should return high value for strongly increasing trend', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        historicalValues: [10, 20, 30, 40, 50, 60, 70],
      };

      const factor = service.calculateTrendFactor(context);

      expect(factor.value).toBeGreaterThan(70);
    });

    it('should return low value for strongly decreasing trend', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        historicalValues: [70, 60, 50, 40, 30, 20, 10],
      };

      const factor = service.calculateTrendFactor(context);

      expect(factor.value).toBeLessThan(30);
    });

    it('should return moderate value for stable trend', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        historicalValues: [20, 21, 19, 20, 21, 20, 19],
      };

      const factor = service.calculateTrendFactor(context);

      expect(factor.value).toBeGreaterThanOrEqual(35);
      expect(factor.value).toBeLessThanOrEqual(65);
    });
  });

  describe('calculateContextFactor', () => {
    it('should return default for no environmental factors', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      };

      const factor = service.calculateContextFactor(context);

      expect(factor.value).toBe(50);
    });

    it('should increase for storm warning', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        environmentalFactors: {
          stormWarning: true,
        },
      };

      const factor = service.calculateContextFactor(context);

      expect(factor.value).toBe(70);
    });

    it('should increase for multiple environmental factors', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        environmentalFactors: {
          stormWarning: true,
          extremeTemperature: true,
          peakSeason: true,
        },
      };

      const factor = service.calculateContextFactor(context);

      expect(factor.value).toBe(95);
    });

    it('should decrease for scheduled maintenance', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        environmentalFactors: {
          maintenanceScheduled: true,
        },
      };

      const factor = service.calculateContextFactor(context);

      expect(factor.value).toBe(40);
    });

    it('should cap at 100', () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        environmentalFactors: {
          stormWarning: true,
          extremeTemperature: true,
          peakSeason: true,
          criticalOperation: true,
        },
      };

      const factor = service.calculateContextFactor(context);

      expect(factor.value).toBeLessThanOrEqual(100);
    });
  });

  describe('calculateTrend', () => {
    it('should return 0 for single value', () => {
      const trend = service.calculateTrend([50]);

      expect(trend).toBe(0);
    });

    it('should return positive trend for increasing values', () => {
      const trend = service.calculateTrend([10, 20, 30, 40, 50]);

      expect(trend).toBeGreaterThan(0);
    });

    it('should return negative trend for decreasing values', () => {
      const trend = service.calculateTrend([50, 40, 30, 20, 10]);

      expect(trend).toBeLessThan(0);
    });

    it('should return near-zero trend for stable values', () => {
      const trend = service.calculateTrend([50, 50, 50, 50, 50]);

      expect(Math.abs(trend)).toBeLessThan(0.01);
    });
  });

  describe('calculateStdDev', () => {
    it('should return 0 for empty array', () => {
      const stdDev = service.calculateStdDev([]);

      expect(stdDev).toBe(0);
    });

    it('should return 0 for identical values', () => {
      const stdDev = service.calculateStdDev([5, 5, 5, 5, 5]);

      expect(stdDev).toBe(0);
    });

    it('should calculate correct standard deviation', () => {
      const stdDev = service.calculateStdDev([2, 4, 4, 4, 5, 5, 7, 9]);

      expect(stdDev).toBeCloseTo(2, 0);
    });
  });

  describe('calculateConfidence', () => {
    it('should return base confidence for minimal data', () => {
      const factors: RiskFactor[] = [
        { category: RiskFactorCategory.FREQUENCY, name: 'Test', value: 50, weight: 0.2 },
      ];
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      };

      const confidence = service.calculateConfidence(factors, context);

      expect(confidence).toBeGreaterThanOrEqual(0.5);
      expect(confidence).toBeLessThan(0.7);
    });

    it('should increase confidence with more historical data', () => {
      const factors: RiskFactor[] = [];
      const contextWithHistory: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        historicalValues: Array(20).fill(30),
      };
      const contextWithoutHistory: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      };

      const confidenceWithHistory = service.calculateConfidence(factors, contextWithHistory);
      const confidenceWithout = service.calculateConfidence(factors, contextWithoutHistory);

      expect(confidenceWithHistory).toBeGreaterThan(confidenceWithout);
    });

    it('should increase confidence with incident history', () => {
      const factors: RiskFactor[] = [];
      const contextWithIncidents: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        previousIncidents: 5,
      };
      const contextWithout: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      };

      const confidenceWith = service.calculateConfidence(factors, contextWithIncidents);
      const confidenceWithout = service.calculateConfidence(factors, contextWithout);

      expect(confidenceWith).toBeGreaterThan(confidenceWithout);
    });

    it('should cap confidence at 1', () => {
      const factors: RiskFactor[] = Array(10).fill({
        category: RiskFactorCategory.FREQUENCY,
        name: 'Test',
        value: 50,
        weight: 0.1,
      });
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        historicalValues: Array(100).fill(30),
        previousIncidents: 10,
        environmentalFactors: { factor1: true },
      };

      const confidence = service.calculateConfidence(factors, context);

      expect(confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('generateRecommendations', () => {
    it('should generate critical recommendations for high scores', () => {
      const factors: RiskFactor[] = [];
      const recommendations = service.generateRecommendations(90, factors);

      expect(recommendations).toContain('Immediate attention required - critical risk level');
      expect(recommendations).toContain('Consider emergency response procedures');
    });

    it('should generate high priority recommendations', () => {
      const factors: RiskFactor[] = [];
      const recommendations = service.generateRecommendations(75, factors);

      expect(recommendations).toContain('High priority attention needed');
    });

    it('should generate medium priority recommendations', () => {
      const factors: RiskFactor[] = [];
      const recommendations = service.generateRecommendations(50, factors);

      expect(recommendations).toContain('Monitor closely for changes');
    });

    it('should add frequency-specific recommendations', () => {
      const factors: RiskFactor[] = [
        { category: RiskFactorCategory.FREQUENCY, name: 'Test', value: 80, weight: 0.15 },
      ];
      const recommendations = service.generateRecommendations(50, factors);

      expect(recommendations).toContain('High incident frequency - investigate root cause');
    });

    it('should add trend-specific recommendations', () => {
      const factors: RiskFactor[] = [
        { category: RiskFactorCategory.TREND, name: 'Test', value: 85, weight: 0.1 },
      ];
      const recommendations = service.generateRecommendations(50, factors);

      expect(recommendations).toContain('Negative trend detected - implement preventive measures');
    });

    it('should add impact-specific recommendations', () => {
      const factors: RiskFactor[] = [
        { category: RiskFactorCategory.IMPACT, name: 'Test', value: 85, weight: 0.25 },
      ];
      const recommendations = service.generateRecommendations(50, factors);

      expect(recommendations).toContain('High business impact - escalate to management');
    });
  });

  describe('threshold management', () => {
    it('should set and get thresholds', () => {
      service.setThresholds({ critical: 90, high: 70 });
      const thresholds = service.getThresholds();

      expect(thresholds.critical).toBe(90);
      expect(thresholds.high).toBe(70);
    });

    it('should preserve other thresholds when updating', () => {
      service.setThresholds({ critical: 90 });
      const thresholds = service.getThresholds();

      expect(thresholds.critical).toBe(90);
      expect(thresholds.high).toBe(65); // Default
      expect(thresholds.medium).toBe(40); // Default
    });
  });

  describe('weight management', () => {
    it('should set and get weights', () => {
      service.setWeights({ [RiskFactorCategory.SEVERITY]: 0.5 });
      const weights = service.getWeights();

      expect(weights[RiskFactorCategory.SEVERITY]).toBe(0.5);
    });

    it('should reject invalid weights', () => {
      service.setWeights({ [RiskFactorCategory.SEVERITY]: 1.5 });
      const weights = service.getWeights();

      expect(weights[RiskFactorCategory.SEVERITY]).toBe(0.25); // Default unchanged
    });

    it('should reject negative weights', () => {
      service.setWeights({ [RiskFactorCategory.SEVERITY]: -0.5 });
      const weights = service.getWeights();

      expect(weights[RiskFactorCategory.SEVERITY]).toBe(0.25); // Default unchanged
    });
  });

  describe('calculateBatchRiskScores', () => {
    it('should calculate risk scores for multiple contexts', async () => {
      const contexts: RiskCalculationContext[] = [
        { tenantId: 'tenant-1', ruleId: 'rule-1', currentValue: 35 },
        { tenantId: 'tenant-1', ruleId: 'rule-2', currentValue: 45 },
        { tenantId: 'tenant-1', ruleId: 'rule-3', currentValue: 55 },
      ];

      const results = await service.calculateBatchRiskScores(contexts);

      expect(results.size).toBe(3);
      expect(results.has('rule-1')).toBe(true);
      expect(results.has('rule-2')).toBe(true);
      expect(results.has('rule-3')).toBe(true);
    });

    it('should handle errors gracefully and continue processing', async () => {
      alertRuleRepository.findOne.mockImplementation(async (options: any) => {
        if (options.where.id === 'rule-2') {
          throw new Error('Database error');
        }
        return mockAlertRule as AlertRule;
      });

      const contexts: RiskCalculationContext[] = [
        { tenantId: 'tenant-1', ruleId: 'rule-1', currentValue: 35 },
        { tenantId: 'tenant-1', ruleId: 'rule-2', currentValue: 45 },
        { tenantId: 'tenant-1', ruleId: 'rule-3', currentValue: 55 },
      ];

      const results = await service.calculateBatchRiskScores(contexts);

      expect(results.size).toBe(2);
      expect(results.has('rule-1')).toBe(true);
      expect(results.has('rule-2')).toBe(false);
      expect(results.has('rule-3')).toBe(true);
    });
  });

  describe('getFactorsByCategory', () => {
    it('should filter factors by category', () => {
      const factors: RiskFactor[] = [
        { category: RiskFactorCategory.FREQUENCY, name: 'F1', value: 50, weight: 0.1 },
        { category: RiskFactorCategory.SEVERITY, name: 'S1', value: 60, weight: 0.2 },
        { category: RiskFactorCategory.FREQUENCY, name: 'F2', value: 70, weight: 0.1 },
      ];

      const frequencyFactors = service.getFactorsByCategory(factors, RiskFactorCategory.FREQUENCY);

      expect(frequencyFactors).toHaveLength(2);
      expect(frequencyFactors.every(f => f.category === RiskFactorCategory.FREQUENCY)).toBe(true);
    });

    it('should return empty array for non-existent category', () => {
      const factors: RiskFactor[] = [
        { category: RiskFactorCategory.FREQUENCY, name: 'F1', value: 50, weight: 0.1 },
      ];

      const impactFactors = service.getFactorsByCategory(factors, RiskFactorCategory.IMPACT);

      expect(impactFactors).toHaveLength(0);
    });
  });

  describe('compareRiskScores', () => {
    it('should return positive when first score is higher', () => {
      const score1 = { totalScore: 80 } as any;
      const score2 = { totalScore: 60 } as any;

      const result = service.compareRiskScores(score1, score2);

      expect(result).toBeGreaterThan(0);
    });

    it('should return negative when first score is lower', () => {
      const score1 = { totalScore: 40 } as any;
      const score2 = { totalScore: 60 } as any;

      const result = service.compareRiskScores(score1, score2);

      expect(result).toBeLessThan(0);
    });

    it('should return zero when scores are equal', () => {
      const score1 = { totalScore: 60 } as any;
      const score2 = { totalScore: 60 } as any;

      const result = service.compareRiskScores(score1, score2);

      expect(result).toBe(0);
    });
  });
});
