import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ImpactAnalyzerService,
  ImpactCategory,
  ImpactLevel,
  ImpactAnalysisContext,
  AssetConfiguration,
} from '../impact-analyzer.service';
import { AlertRule, AlertSeverity } from '../../database/entities/alert-rule.entity';

describe('ImpactAnalyzerService', () => {
  let service: ImpactAnalyzerService;
  let alertRuleRepository: jest.Mocked<Repository<AlertRule>>;

  const mockAlertRule: Partial<AlertRule> = {
    id: 'rule-1',
    tenantId: 'tenant-1',
    name: 'Temperature Alert',
    severity: AlertSeverity.HIGH,
    isActive: true,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImpactAnalyzerService,
        {
          provide: getRepositoryToken(AlertRule),
          useValue: {
            findOne: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ImpactAnalyzerService>(ImpactAnalyzerService);
    alertRuleRepository = module.get(getRepositoryToken(AlertRule));

    alertRuleRepository.findOne.mockResolvedValue(mockAlertRule as AlertRule);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('analyzeImpact', () => {
    const baseContext: ImpactAnalysisContext = {
      tenantId: 'tenant-1',
      ruleId: 'rule-1',
      currentValue: 35,
    };

    it('should analyze impact for basic context', async () => {
      const result = await service.analyzeImpact(baseContext);

      expect(result).toBeDefined();
      expect(result.totalImpactScore).toBeGreaterThanOrEqual(0);
      expect(result.totalImpactScore).toBeLessThanOrEqual(100);
      expect(result.businessImpact).toBeDefined();
      expect(result.technicalImpact).toBeDefined();
      expect(result.financialImpact).toBeDefined();
      expect(result.complianceImpact).toBeDefined();
      expect(result.analyzedAt).toBeInstanceOf(Date);
    });

    it('should include all impact categories', async () => {
      const result = await service.analyzeImpact(baseContext);

      expect(result.businessImpact.category).toBe(ImpactCategory.BUSINESS);
      expect(result.technicalImpact.category).toBe(ImpactCategory.TECHNICAL);
      expect(result.financialImpact.category).toBe(ImpactCategory.FINANCIAL);
      expect(result.complianceImpact.category).toBe(ImpactCategory.COMPLIANCE);
      expect(result.operationalImpact?.category).toBe(ImpactCategory.OPERATIONAL);
      expect(result.environmentalImpact?.category).toBe(ImpactCategory.ENVIRONMENTAL);
      expect(result.reputationImpact?.category).toBe(ImpactCategory.REPUTATION);
    });

    it('should increase impact for critical severity rules', async () => {
      alertRuleRepository.findOne.mockResolvedValueOnce({
        ...mockAlertRule,
        severity: AlertSeverity.CRITICAL,
      } as AlertRule);
      const criticalResult = await service.analyzeImpact(baseContext);

      alertRuleRepository.findOne.mockResolvedValueOnce({
        ...mockAlertRule,
        severity: AlertSeverity.LOW,
      } as AlertRule);
      const lowResult = await service.analyzeImpact(baseContext);

      expect(criticalResult.totalImpactScore).toBeGreaterThan(lowResult.totalImpactScore);
    });

    it('should include affected systems', async () => {
      const contextWithFarm: ImpactAnalysisContext = {
        ...baseContext,
        farmId: 'farm-1',
        sensorId: 'sensor-1',
      };

      const result = await service.analyzeImpact(contextWithFarm);

      expect(result.affectedSystems).toContain('Sensor Network');
      expect(result.affectedSystems).toContain('Farm Management System');
    });

    it('should estimate downtime', async () => {
      const result = await service.analyzeImpact(baseContext);

      expect(result.estimatedDowntime).toBeDefined();
      expect(typeof result.estimatedDowntime).toBe('number');
    });

    it('should estimate cost', async () => {
      const result = await service.analyzeImpact(baseContext);

      expect(result.estimatedCost).toBeDefined();
      expect(typeof result.estimatedCost).toBe('number');
    });

    it('should generate summary', async () => {
      const result = await service.analyzeImpact(baseContext);

      expect(result.summary).toBeDefined();
      expect(typeof result.summary).toBe('string');
      expect(result.summary.length).toBeGreaterThan(0);
    });
  });

  describe('analyzeBusinessImpact', () => {
    it('should calculate business impact with severity weight', () => {
      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      };

      const result = service.analyzeBusinessImpact(context, 1.0);

      expect(result.category).toBe(ImpactCategory.BUSINESS);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.level).toBeDefined();
      expect(result.factors).toBeDefined();
    });

    it('should increase impact for affected processes', () => {
      const contextWithProcesses: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        affectedProcesses: ['process-1', 'process-2', 'process-3'],
      };
      const contextWithout: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      };

      const withProcesses = service.analyzeBusinessImpact(contextWithProcesses, 1.0);
      const without = service.analyzeBusinessImpact(contextWithout, 1.0);

      expect(withProcesses.score).toBeGreaterThan(without.score);
      expect(withProcesses.factors).toContain('3 business processes affected');
    });

    it('should increase impact for critical assets', () => {
      // Register critical asset
      service.registerAsset({
        id: 'asset-1',
        name: 'Critical Pump',
        criticality: 5,
        dependencies: [],
        businessValue: 100000,
      });

      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        affectedAssets: ['asset-1'],
      };

      const result = service.analyzeBusinessImpact(context, 1.0);

      expect(result.factors.some(f => f.includes('critical assets'))).toBe(true);
    });

    it('should increase impact for farm context', () => {
      const contextWithFarm: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        farmId: 'farm-1',
      };
      const contextWithout: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      };

      const withFarm = service.analyzeBusinessImpact(contextWithFarm, 1.0);
      const without = service.analyzeBusinessImpact(contextWithout, 1.0);

      expect(withFarm.score).toBeGreaterThan(without.score);
      expect(withFarm.factors).toContain('Farm operations may be affected');
    });

    it('should suggest mitigation based on level', () => {
      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        affectedProcesses: Array(10).fill('process'),
        farmId: 'farm-1',
      };

      const result = service.analyzeBusinessImpact(context, 1.0);

      expect(result.mitigation).toBeDefined();
      expect(typeof result.mitigation).toBe('string');
    });
  });

  describe('analyzeTechnicalImpact', () => {
    it('should calculate technical impact', () => {
      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      };

      const result = service.analyzeTechnicalImpact(context, 1.0);

      expect(result.category).toBe(ImpactCategory.TECHNICAL);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('should increase impact for sensor issues', () => {
      const contextWithSensor: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        sensorId: 'sensor-1',
      };
      const contextWithout: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      };

      const withSensor = service.analyzeTechnicalImpact(contextWithSensor, 1.0);
      const without = service.analyzeTechnicalImpact(contextWithout, 1.0);

      expect(withSensor.score).toBeGreaterThan(without.score);
      expect(withSensor.factors).toContain('Sensor monitoring affected');
    });

    it('should consider asset dependencies', () => {
      service.registerAsset({
        id: 'asset-1',
        name: 'Main Controller',
        criticality: 4,
        dependencies: ['dep-1', 'dep-2', 'dep-3'],
        businessValue: 50000,
      });

      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        affectedAssets: ['asset-1'],
      };

      const result = service.analyzeTechnicalImpact(context, 1.0);

      expect(result.factors.some(f => f.includes('dependencies'))).toBe(true);
    });

    it('should increase impact for significant value deviation', () => {
      const contextHighValue: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 150,
      };
      const contextNormalValue: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      };

      const highResult = service.analyzeTechnicalImpact(contextHighValue, 1.0);
      const normalResult = service.analyzeTechnicalImpact(contextNormalValue, 1.0);

      expect(highResult.score).toBeGreaterThan(normalResult.score);
    });
  });

  describe('analyzeFinancialImpact', () => {
    it('should calculate financial impact', () => {
      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      };

      const result = service.analyzeFinancialImpact(context, 1.0);

      expect(result.category).toBe(ImpactCategory.FINANCIAL);
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('should calculate potential loss from assets', () => {
      service.registerAsset({
        id: 'asset-1',
        name: 'Expensive Equipment',
        criticality: 4,
        dependencies: [],
        businessValue: 100000,
      });

      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        affectedAssets: ['asset-1'],
      };

      const result = service.analyzeFinancialImpact(context, 1.0);

      expect(result.factors.some(f => f.includes('financial exposure'))).toBe(true);
    });

    it('should increase impact for farm operations', () => {
      const contextWithFarm: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        farmId: 'farm-1',
      };

      const result = service.analyzeFinancialImpact(contextWithFarm, 1.0);

      expect(result.factors).toContain('Potential production losses');
    });
  });

  describe('analyzeComplianceImpact', () => {
    it('should calculate compliance impact', () => {
      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      };

      const result = service.analyzeComplianceImpact(context, 1.0);

      expect(result.category).toBe(ImpactCategory.COMPLIANCE);
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('should increase impact for SLA risks', () => {
      service.registerAsset({
        id: 'asset-1',
        name: 'Critical Service',
        criticality: 5,
        dependencies: [],
        businessValue: 50000,
        slaRequirements: {
          uptime: 99.99,
          responseTime: 100,
        },
      });

      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        affectedAssets: ['asset-1'],
      };

      const result = service.analyzeComplianceImpact(context, 1.0);

      expect(result.factors.some(f => f.includes('SLA'))).toBe(true);
    });

    it('should increase impact for environmental compliance', () => {
      const contextWithFarm: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        farmId: 'farm-1',
      };

      const result = service.analyzeComplianceImpact(contextWithFarm, 1.0);

      expect(result.factors).toContain('Environmental compliance monitoring affected');
    });
  });

  describe('analyzeOperationalImpact', () => {
    it('should calculate operational impact', () => {
      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      };

      const result = service.analyzeOperationalImpact(context, 1.0);

      expect(result.category).toBe(ImpactCategory.OPERATIONAL);
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('should increase impact for affected processes', () => {
      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        affectedProcesses: ['feeding', 'monitoring', 'harvesting'],
      };

      const result = service.analyzeOperationalImpact(context, 1.0);

      expect(result.factors).toContain('Operational workflows disrupted');
    });

    it('should increase impact for sensor issues', () => {
      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        sensorId: 'sensor-1',
      };

      const result = service.analyzeOperationalImpact(context, 1.0);

      expect(result.factors).toContain('Real-time monitoring capability affected');
    });
  });

  describe('analyzeEnvironmentalImpact', () => {
    it('should calculate environmental impact', () => {
      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      };

      const result = service.analyzeEnvironmentalImpact(context, 1.0);

      expect(result.category).toBe(ImpactCategory.ENVIRONMENTAL);
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('should increase impact for farm context', () => {
      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        farmId: 'farm-1',
      };

      const result = service.analyzeEnvironmentalImpact(context, 1.0);

      expect(result.factors).toContain('Aquatic ecosystem monitoring affected');
    });

    it('should increase impact for sensor issues', () => {
      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        sensorId: 'sensor-1',
      };

      const result = service.analyzeEnvironmentalImpact(context, 1.0);

      expect(result.factors).toContain('Environmental sensor data may be compromised');
    });
  });

  describe('analyzeReputationImpact', () => {
    it('should calculate reputation impact', () => {
      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      };

      const result = service.analyzeReputationImpact(context, 1.0);

      expect(result.category).toBe(ImpactCategory.REPUTATION);
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('should increase impact for critical customer-facing assets', () => {
      service.registerAsset({
        id: 'asset-1',
        name: 'Customer Portal',
        criticality: 5,
        dependencies: [],
        businessValue: 100000,
      });

      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        affectedAssets: ['asset-1'],
      };

      const result = service.analyzeReputationImpact(context, 1.0);

      expect(result.factors).toContain('Customer-facing systems potentially affected');
    });
  });

  describe('calculateTotalImpactScore', () => {
    it('should calculate weighted average of impacts', () => {
      const impacts = [
        { category: ImpactCategory.BUSINESS, level: ImpactLevel.HIGH, score: 80, factors: [] },
        { category: ImpactCategory.TECHNICAL, level: ImpactLevel.MEDIUM, score: 50, factors: [] },
        { category: ImpactCategory.FINANCIAL, level: ImpactLevel.LOW, score: 30, factors: [] },
        { category: ImpactCategory.COMPLIANCE, level: ImpactLevel.LOW, score: 20, factors: [] },
      ];

      const total = service.calculateTotalImpactScore(impacts);

      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(100);
    });

    it('should handle empty impacts', () => {
      const total = service.calculateTotalImpactScore([]);

      expect(total).toBe(0);
    });

    it('should weight business impact more heavily', () => {
      const highBusinessImpact = [
        { category: ImpactCategory.BUSINESS, level: ImpactLevel.CRITICAL, score: 100, factors: [] },
        { category: ImpactCategory.TECHNICAL, level: ImpactLevel.LOW, score: 20, factors: [] },
      ];

      const highTechnicalImpact = [
        { category: ImpactCategory.BUSINESS, level: ImpactLevel.LOW, score: 20, factors: [] },
        { category: ImpactCategory.TECHNICAL, level: ImpactLevel.CRITICAL, score: 100, factors: [] },
      ];

      const businessTotal = service.calculateTotalImpactScore(highBusinessImpact);
      const technicalTotal = service.calculateTotalImpactScore(highTechnicalImpact);

      expect(businessTotal).toBeGreaterThan(technicalTotal);
    });
  });

  describe('scoreToLevel', () => {
    it('should return CRITICAL for score >= 80', () => {
      expect(service.scoreToLevel(80)).toBe(ImpactLevel.CRITICAL);
      expect(service.scoreToLevel(100)).toBe(ImpactLevel.CRITICAL);
    });

    it('should return HIGH for score >= 60', () => {
      expect(service.scoreToLevel(60)).toBe(ImpactLevel.HIGH);
      expect(service.scoreToLevel(79)).toBe(ImpactLevel.HIGH);
    });

    it('should return MEDIUM for score >= 40', () => {
      expect(service.scoreToLevel(40)).toBe(ImpactLevel.MEDIUM);
      expect(service.scoreToLevel(59)).toBe(ImpactLevel.MEDIUM);
    });

    it('should return LOW for score >= 20', () => {
      expect(service.scoreToLevel(20)).toBe(ImpactLevel.LOW);
      expect(service.scoreToLevel(39)).toBe(ImpactLevel.LOW);
    });

    it('should return NEGLIGIBLE for score < 20', () => {
      expect(service.scoreToLevel(0)).toBe(ImpactLevel.NEGLIGIBLE);
      expect(service.scoreToLevel(19)).toBe(ImpactLevel.NEGLIGIBLE);
    });
  });

  describe('identifyAffectedSystems', () => {
    it('should identify sensor network for sensor context', () => {
      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        sensorId: 'sensor-1',
      };

      const systems = service.identifyAffectedSystems(context);

      expect(systems).toContain('Sensor Network');
    });

    it('should identify farm systems for farm context', () => {
      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        farmId: 'farm-1',
      };

      const systems = service.identifyAffectedSystems(context);

      expect(systems).toContain('Farm Management System');
      expect(systems).toContain('Environmental Monitoring');
    });

    it('should identify asset management for affected assets', () => {
      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        affectedAssets: ['asset-1'],
      };

      const systems = service.identifyAffectedSystems(context);

      expect(systems).toContain('Asset Management');
    });

    it('should identify process automation for affected processes', () => {
      const context: ImpactAnalysisContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        affectedProcesses: ['feeding'],
      };

      const systems = service.identifyAffectedSystems(context);

      expect(systems).toContain('Process Automation');
    });
  });

  describe('estimateDowntime', () => {
    it('should estimate higher downtime for critical severity', () => {
      const criticalDowntime = service.estimateDowntime(80, AlertSeverity.CRITICAL);
      const lowDowntime = service.estimateDowntime(80, AlertSeverity.LOW);

      expect(criticalDowntime).toBeGreaterThan(lowDowntime);
    });

    it('should scale downtime with impact score', () => {
      const highImpact = service.estimateDowntime(100, AlertSeverity.HIGH);
      const lowImpact = service.estimateDowntime(25, AlertSeverity.HIGH);

      expect(highImpact).toBeGreaterThan(lowImpact);
    });

    it('should return 0 for INFO severity', () => {
      const downtime = service.estimateDowntime(50, AlertSeverity.INFO);

      expect(downtime).toBe(0);
    });
  });

  describe('estimateCost', () => {
    it('should calculate base cost from impact score', () => {
      const cost = service.estimateCost(50, {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
      });

      expect(cost).toBe(5000); // 50 * 100
    });

    it('should add asset value to cost', () => {
      service.registerAsset({
        id: 'asset-1',
        name: 'Expensive Equipment',
        criticality: 4,
        dependencies: [],
        businessValue: 50000,
      });

      const cost = service.estimateCost(50, {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        affectedAssets: ['asset-1'],
      });

      expect(cost).toBeGreaterThan(5000);
    });
  });

  describe('generateSummary', () => {
    it('should include overall level in summary', () => {
      const impacts = [
        { category: ImpactCategory.BUSINESS, level: ImpactLevel.HIGH, score: 70, factors: [] },
      ];

      const summary = service.generateSummary(70, impacts);

      expect(summary).toContain('HIGH');
    });

    it('should include high concern areas', () => {
      const impacts = [
        { category: ImpactCategory.BUSINESS, level: ImpactLevel.HIGH, score: 75, factors: [] },
        { category: ImpactCategory.FINANCIAL, level: ImpactLevel.HIGH, score: 80, factors: [] },
      ];

      const summary = service.generateSummary(75, impacts);

      expect(summary).toContain('business');
      expect(summary).toContain('financial');
    });
  });

  describe('asset management', () => {
    it('should register and retrieve asset configuration', () => {
      const config: AssetConfiguration = {
        id: 'asset-1',
        name: 'Test Asset',
        criticality: 4,
        dependencies: ['dep-1'],
        businessValue: 25000,
      };

      service.registerAsset(config);
      const retrieved = service.getAssetConfiguration('asset-1');

      expect(retrieved).toEqual(config);
    });

    it('should return undefined for unknown asset', () => {
      const retrieved = service.getAssetConfiguration('unknown-asset');

      expect(retrieved).toBeUndefined();
    });

    it('should overwrite existing asset on re-registration', () => {
      service.registerAsset({
        id: 'asset-1',
        name: 'Old Name',
        criticality: 2,
        dependencies: [],
        businessValue: 10000,
      });

      service.registerAsset({
        id: 'asset-1',
        name: 'New Name',
        criticality: 5,
        dependencies: [],
        businessValue: 50000,
      });

      const retrieved = service.getAssetConfiguration('asset-1');

      expect(retrieved?.name).toBe('New Name');
      expect(retrieved?.criticality).toBe(5);
    });
  });
});
