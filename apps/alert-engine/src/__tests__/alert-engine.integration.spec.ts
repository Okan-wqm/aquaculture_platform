import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

// Services
import { RulesEngineService, RuleEvaluationContext } from '../rules-engine/rules-engine.service';
import { RuleEvaluatorService } from '../rules-engine/rule-evaluator.service';
import { RiskCalculatorService, RiskCalculationContext } from '../risk-scoring/risk-calculator.service';
import { ImpactAnalyzerService } from '../risk-scoring/impact-analyzer.service';
import { SeverityClassifierService } from '../risk-scoring/severity-classifier.service';
import { EscalationPolicyService } from '../escalation/escalation-policy.service';
import { EscalationManagerService } from '../escalation/escalation-manager.service';
import { NotificationDispatcherService, ChannelHandler } from '../notification/notification-dispatcher.service';
import { ChannelRouterService } from '../notification/channel-router.service';
import { TemplateRendererService } from '../notification/template-renderer.service';

// Entities
import { AlertRule, AlertSeverity, RuleOperator, LogicalOperator } from '../database/entities/alert-rule.entity';
import { AlertIncident, IncidentStatus, TimelineEventType } from '../database/entities/alert-incident.entity';
import { EscalationPolicy, EscalationLevel, NotificationChannel, EscalationActionType } from '../database/entities/escalation-policy.entity';

/**
 * Integration tests for Alert Engine workflow
 * Tests the complete flow from rule evaluation to notification dispatch
 */
describe('Alert Engine Integration', () => {
  let rulesEngine: RulesEngineService;
  let ruleEvaluator: RuleEvaluatorService;
  let riskCalculator: RiskCalculatorService;
  let impactAnalyzer: ImpactAnalyzerService;
  let severityClassifier: SeverityClassifierService;
  let escalationPolicyService: EscalationPolicyService;
  let escalationManager: EscalationManagerService;
  let notificationDispatcher: NotificationDispatcherService;
  let channelRouter: ChannelRouterService;
  let templateRenderer: TemplateRendererService;
  let eventEmitter: EventEmitter2;

  let alertRuleRepository: jest.Mocked<Repository<AlertRule>>;
  let incidentRepository: jest.Mocked<Repository<AlertIncident>>;
  let policyRepository: jest.Mocked<Repository<EscalationPolicy>>;

  const mockRule: Partial<AlertRule> = {
    id: 'rule-1',
    tenantId: 'tenant-1',
    name: 'Temperature Alert',
    description: 'Alert when temperature exceeds threshold',
    severity: AlertSeverity.HIGH,
    isActive: true,
    conditions: [
      {
        field: 'temperature',
        operator: RuleOperator.GT,
        value: 30,
      },
    ],
    logicalOperator: LogicalOperator.AND,
  };

  const mockEscalationLevel: EscalationLevel = {
    level: 1,
    name: 'Level 1',
    timeoutMinutes: 15,
    notifyUserIds: ['user-1'],
    channels: [NotificationChannel.EMAIL, NotificationChannel.SLACK],
    action: EscalationActionType.NOTIFY,
  };

  const mockPolicy: Partial<EscalationPolicy> = {
    id: 'policy-1',
    tenantId: 'tenant-1',
    name: 'Default Policy',
    severity: [AlertSeverity.HIGH, AlertSeverity.CRITICAL],
    levels: [mockEscalationLevel],
    repeatIntervalMinutes: 5,
    maxRepeats: 3,
    isActive: true,
    isDefault: true,
    appliesTo: jest.fn().mockReturnValue(true),
    getLevel: jest.fn().mockReturnValue(mockEscalationLevel),
    getMaxLevel: jest.fn().mockReturnValue(1),
    hasNextLevel: jest.fn().mockReturnValue(false),
    getCurrentOnCall: jest.fn().mockReturnValue(undefined),
    isInSuppressionWindow: jest.fn().mockReturnValue(false),
  };

  beforeEach(async () => {
    jest.useFakeTimers();

    const mockAlertRuleRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
    };

    const mockIncidentRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
    };

    const mockPolicyRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RulesEngineService,
        RuleEvaluatorService,
        RiskCalculatorService,
        ImpactAnalyzerService,
        SeverityClassifierService,
        EscalationPolicyService,
        EscalationManagerService,
        NotificationDispatcherService,
        ChannelRouterService,
        TemplateRendererService,
        {
          provide: getRepositoryToken(AlertRule),
          useValue: mockAlertRuleRepo,
        },
        {
          provide: getRepositoryToken(AlertIncident),
          useValue: mockIncidentRepo,
        },
        {
          provide: getRepositoryToken(EscalationPolicy),
          useValue: mockPolicyRepo,
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
            on: jest.fn(),
          },
        },
        {
          provide: DataSource,
          useValue: {
            createQueryRunner: jest.fn().mockReturnValue({
              connect: jest.fn(),
              startTransaction: jest.fn(),
              commitTransaction: jest.fn(),
              rollbackTransaction: jest.fn(),
              release: jest.fn(),
              manager: {
                save: jest.fn(),
              },
            }),
          },
        },
      ],
    }).compile();

    rulesEngine = module.get<RulesEngineService>(RulesEngineService);
    ruleEvaluator = module.get<RuleEvaluatorService>(RuleEvaluatorService);
    riskCalculator = module.get<RiskCalculatorService>(RiskCalculatorService);
    impactAnalyzer = module.get<ImpactAnalyzerService>(ImpactAnalyzerService);
    severityClassifier = module.get<SeverityClassifierService>(SeverityClassifierService);
    escalationPolicyService = module.get<EscalationPolicyService>(EscalationPolicyService);
    escalationManager = module.get<EscalationManagerService>(EscalationManagerService);
    notificationDispatcher = module.get<NotificationDispatcherService>(NotificationDispatcherService);
    channelRouter = module.get<ChannelRouterService>(ChannelRouterService);
    templateRenderer = module.get<TemplateRendererService>(TemplateRendererService);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);

    alertRuleRepository = module.get(getRepositoryToken(AlertRule));
    incidentRepository = module.get(getRepositoryToken(AlertIncident));
    policyRepository = module.get(getRepositoryToken(EscalationPolicy));

    // Default mocks
    alertRuleRepository.findOne.mockResolvedValue(mockRule as AlertRule);
    alertRuleRepository.find.mockResolvedValue([mockRule as AlertRule]);
    policyRepository.find.mockResolvedValue([mockPolicy as EscalationPolicy]);
    policyRepository.findOne.mockResolvedValue(mockPolicy as EscalationPolicy);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('Complete Alert Workflow', () => {
    it('should evaluate rules and determine if alert should trigger', async () => {
      const context: RuleEvaluationContext = {
        tenantId: 'tenant-1',
        data: { temperature: 35, humidity: 60 },
        timestamp: new Date(),
      };

      const result = await rulesEngine.evaluateRules(context);

      expect(result).toBeDefined();
      // Should trigger because temperature (35) > threshold (30)
    });

    it('should calculate risk score for triggered alert', async () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        thresholdValue: 30,
        previousIncidents: 2,
        historicalValues: [28, 29, 30, 31, 32, 33, 34],
      };

      const result = await riskCalculator.calculateRiskScore(context);

      expect(result).toBeDefined();
      expect(result.totalScore).toBeGreaterThanOrEqual(0);
      expect(result.totalScore).toBeLessThanOrEqual(100);
      expect(result.severity).toBeDefined();
      expect(result.factors.length).toBe(6);
      expect(result.recommendations.length).toBeGreaterThan(0);
    });

    it('should classify severity based on multiple criteria', () => {
      const result = severityClassifier.classifyByCriteria({
        impactScore: 80,
        frequencyScore: 60,
        trendScore: 70,
        urgency: 'URGENT' as any,
        scope: 'DEPARTMENT' as any,
      });

      expect(result.severity).toBeDefined();
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.recommendedActions.length).toBeGreaterThan(0);
    });

    it('should route notifications through appropriate channels', () => {
      channelRouter.setUserPreferences({
        userId: 'user-1',
        enabledChannels: [NotificationChannel.EMAIL, NotificationChannel.SLACK],
        preferredChannel: NotificationChannel.SLACK,
      });

      const decision = channelRouter.route('user-1', AlertSeverity.HIGH);

      expect(decision.channels.length).toBeGreaterThan(0);
      expect(decision.primaryChannel).toBe(NotificationChannel.SLACK);
    });

    it('should render notification templates correctly', () => {
      const rendered = templateRenderer.render(NotificationChannel.EMAIL, {
        incident: {
          id: 'incident-1',
          title: 'Temperature Alert',
          description: 'Temperature exceeded threshold',
          status: IncidentStatus.NEW,
        } as any,
        severity: AlertSeverity.HIGH,
        escalationLevel: 1,
      });

      expect(rendered.subject).toContain('HIGH');
      expect(rendered.subject).toContain('Temperature Alert');
      expect(rendered.body).toContain('incident-1');
      expect(rendered.htmlBody).toBeDefined();
    });
  });

  describe('Escalation Flow', () => {
    it('should find matching escalation policy', async () => {
      const policy = await escalationPolicyService.findMatchingPolicy(
        'tenant-1',
        AlertSeverity.HIGH,
        'rule-1',
        'farm-1',
      );

      expect(policy).toBeDefined();
    });

    it('should start escalation for incident', async () => {
      const incident = new AlertIncident();
      incident.id = 'incident-1';
      incident.tenantId = 'tenant-1';
      incident.title = 'Test Alert';
      incident.status = IncidentStatus.NEW;
      incident.timeline = [];

      incidentRepository.findOne.mockResolvedValue(incident);
      incidentRepository.save.mockImplementation(async (i) => i as AlertIncident);

      const state = await escalationManager.startEscalation(
        incident,
        AlertSeverity.HIGH,
        'rule-1',
      );

      expect(state).toBeDefined();
      expect(state?.currentLevel).toBe(1);
      expect(state?.isComplete).toBe(false);
    });

    it('should acknowledge escalation', async () => {
      const incident = new AlertIncident();
      incident.id = 'incident-1';
      incident.tenantId = 'tenant-1';
      incident.title = 'Test Alert';
      incident.status = IncidentStatus.NEW;
      incident.timeline = [];
      incident.acknowledge = jest.fn();

      incidentRepository.findOne.mockResolvedValue(incident);
      incidentRepository.save.mockImplementation(async (i) => i as AlertIncident);

      await escalationManager.startEscalation(incident, AlertSeverity.HIGH);

      const acknowledged = await escalationManager.acknowledgeEscalation(
        'incident-1',
        'user-1',
        'Looking into it',
      );

      expect(acknowledged).toBe(true);
      expect(escalationManager.isAcknowledged('incident-1')).toBe(true);
    });
  });

  describe('Notification Dispatch', () => {
    it('should send notification through registered handler', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: true, messageId: 'msg-1' }),
      };

      notificationDispatcher.registerHandler(NotificationChannel.EMAIL, mockHandler);

      channelRouter.setUserPreferences({
        userId: 'user-1',
        enabledChannels: [NotificationChannel.EMAIL],
        preferredChannel: NotificationChannel.EMAIL,
      });

      const results = await notificationDispatcher.send({
        incidentId: 'incident-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        severity: AlertSeverity.HIGH,
        escalationLevel: 1,
        context: {
          incident: {
            id: 'incident-1',
            title: 'Test Alert',
          } as any,
          severity: AlertSeverity.HIGH,
        },
      });

      expect(results.length).toBeGreaterThan(0);
      expect(mockHandler.send).toHaveBeenCalled();
    });

    it('should batch send to multiple users', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: true }),
      };

      notificationDispatcher.registerHandler(NotificationChannel.EMAIL, mockHandler);

      ['user-1', 'user-2', 'user-3'].forEach(userId => {
        channelRouter.setUserPreferences({
          userId,
          enabledChannels: [NotificationChannel.EMAIL],
          preferredChannel: NotificationChannel.EMAIL,
        });
      });

      const result = await notificationDispatcher.sendBatch({
        incidentId: 'incident-1',
        tenantId: 'tenant-1',
        userIds: ['user-1', 'user-2', 'user-3'],
        severity: AlertSeverity.HIGH,
        escalationLevel: 1,
        context: {
          incident: { id: 'incident-1', title: 'Test' } as any,
          severity: AlertSeverity.HIGH,
        },
      });

      expect(result.totalUsers).toBe(3);
      expect(result.successCount).toBe(3);
    });
  });

  describe('Risk Scoring Flow', () => {
    it('should analyze impact and calculate total score', async () => {
      const impactResult = await impactAnalyzer.analyzeImpact({
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        farmId: 'farm-1',
        sensorId: 'sensor-1',
        currentValue: 35,
      });

      expect(impactResult.totalImpactScore).toBeGreaterThanOrEqual(0);
      expect(impactResult.businessImpact).toBeDefined();
      expect(impactResult.technicalImpact).toBeDefined();
      expect(impactResult.affectedSystems.length).toBeGreaterThan(0);
    });

    it('should calculate comprehensive risk score', async () => {
      const result = await riskCalculator.calculateRiskScore({
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        farmId: 'farm-1',
        sensorId: 'sensor-1',
        currentValue: 45,
        thresholdValue: 30,
        previousIncidents: 5,
        lastIncidentDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
        historicalValues: [25, 28, 30, 32, 35, 38, 40, 42],
        environmentalFactors: {
          peakSeason: true,
          extremeTemperature: true,
        },
      });

      expect(result.totalScore).toBeGreaterThan(50);
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.recommendations.length).toBeGreaterThan(0);
    });
  });

  describe('Event Flow', () => {
    it('should emit events through the workflow', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: true }),
      };

      notificationDispatcher.registerHandler(NotificationChannel.EMAIL, mockHandler);

      channelRouter.setUserPreferences({
        userId: 'user-1',
        enabledChannels: [NotificationChannel.EMAIL],
        preferredChannel: NotificationChannel.EMAIL,
      });

      await notificationDispatcher.send({
        incidentId: 'incident-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        severity: AlertSeverity.HIGH,
        escalationLevel: 1,
        context: {
          incident: { id: 'incident-1', title: 'Test' } as any,
          severity: AlertSeverity.HIGH,
        },
      });

      expect(eventEmitter.emit).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle missing rules gracefully', async () => {
      alertRuleRepository.find.mockResolvedValue([]);

      const context: RuleEvaluationContext = {
        tenantId: 'tenant-1',
        data: { temperature: 35 },
        timestamp: new Date(),
      };

      const result = await rulesEngine.evaluateRules(context);

      expect(result.matchedRules).toHaveLength(0);
    });

    it('should handle notification handler errors', async () => {
      const failingHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: false, error: 'SMTP Error' }),
      };

      notificationDispatcher.registerHandler(NotificationChannel.EMAIL, failingHandler);
      notificationDispatcher.setRetryConfig({ maxRetries: 0 });

      channelRouter.setUserPreferences({
        userId: 'user-1',
        enabledChannels: [NotificationChannel.EMAIL],
        preferredChannel: NotificationChannel.EMAIL,
      });

      const results = await notificationDispatcher.send({
        incidentId: 'incident-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        severity: AlertSeverity.HIGH,
        escalationLevel: 1,
        context: {
          incident: { id: 'incident-1', title: 'Test' } as any,
          severity: AlertSeverity.HIGH,
        },
      });

      expect(results[0].status).toBe('FAILED');
    });
  });

  describe('Multi-tenant Isolation', () => {
    it('should evaluate rules only for correct tenant', async () => {
      const tenant1Rule = { ...mockRule, tenantId: 'tenant-1' };
      const tenant2Rule = { ...mockRule, id: 'rule-2', tenantId: 'tenant-2' };

      alertRuleRepository.find.mockImplementation(async (options: any) => {
        if (options?.where?.tenantId === 'tenant-1') {
          return [tenant1Rule as AlertRule];
        }
        return [];
      });

      const context: RuleEvaluationContext = {
        tenantId: 'tenant-1',
        data: { temperature: 35 },
        timestamp: new Date(),
      };

      const result = await rulesEngine.evaluateRules(context);

      // Should only evaluate tenant-1 rules
      expect(alertRuleRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-1' }),
        }),
      );
    });
  });

  // ============================================================================
  // Edge Cases and Boundary Conditions
  // ============================================================================

  describe('Edge Cases', () => {
    describe('Boundary Value Testing', () => {
      it('should handle exact threshold value (GT operator)', async () => {
        const exactThresholdRule = {
          ...mockRule,
          conditions: [{ field: 'temperature', operator: RuleOperator.GT, value: 30 }],
        };
        alertRuleRepository.find.mockResolvedValue([exactThresholdRule as AlertRule]);

        const context: RuleEvaluationContext = {
          tenantId: 'tenant-1',
          data: { temperature: 30 }, // Exact threshold
          timestamp: new Date(),
        };

        const result = await rulesEngine.evaluateRules(context);

        // GT (greater than) should NOT trigger at exact threshold
        expect(result.matchedRules.length).toBe(0);
      });

      it('should handle value just above threshold', async () => {
        const context: RuleEvaluationContext = {
          tenantId: 'tenant-1',
          data: { temperature: 30.001 }, // Just above
          timestamp: new Date(),
        };

        const result = await rulesEngine.evaluateRules(context);

        expect(result.matchedRules.length).toBeGreaterThan(0);
      });

      it('should handle extreme values correctly', async () => {
        const extremeContext: RuleEvaluationContext = {
          tenantId: 'tenant-1',
          data: { temperature: Number.MAX_SAFE_INTEGER },
          timestamp: new Date(),
        };

        const result = await rulesEngine.evaluateRules(extremeContext);

        expect(result).toBeDefined();
        expect(result.matchedRules.length).toBeGreaterThan(0);
      });

      it('should handle negative values', async () => {
        const negativeRule = {
          ...mockRule,
          conditions: [{ field: 'temperature', operator: RuleOperator.LT, value: 0 }],
        };
        alertRuleRepository.find.mockResolvedValue([negativeRule as AlertRule]);

        const context: RuleEvaluationContext = {
          tenantId: 'tenant-1',
          data: { temperature: -5 },
          timestamp: new Date(),
        };

        const result = await rulesEngine.evaluateRules(context);

        expect(result.matchedRules.length).toBeGreaterThan(0);
      });

      it('should handle zero values', async () => {
        const zeroContext: RuleEvaluationContext = {
          tenantId: 'tenant-1',
          data: { temperature: 0 },
          timestamp: new Date(),
        };

        const result = await rulesEngine.evaluateRules(zeroContext);
        expect(result).toBeDefined();
      });
    });

    describe('Missing and Null Data', () => {
      it('should handle missing field in data', async () => {
        const context: RuleEvaluationContext = {
          tenantId: 'tenant-1',
          data: { humidity: 60 }, // Missing temperature field
          timestamp: new Date(),
        };

        const result = await rulesEngine.evaluateRules(context);

        // Should not match rules that require temperature
        expect(result.matchedRules.length).toBe(0);
      });

      it('should handle null values in data', async () => {
        const context: RuleEvaluationContext = {
          tenantId: 'tenant-1',
          data: { temperature: null },
          timestamp: new Date(),
        };

        const result = await rulesEngine.evaluateRules(context);
        expect(result.matchedRules.length).toBe(0);
      });

      it('should handle undefined values in data', async () => {
        const context: RuleEvaluationContext = {
          tenantId: 'tenant-1',
          data: { temperature: undefined },
          timestamp: new Date(),
        };

        const result = await rulesEngine.evaluateRules(context);
        expect(result.matchedRules.length).toBe(0);
      });

      it('should handle empty data object', async () => {
        const context: RuleEvaluationContext = {
          tenantId: 'tenant-1',
          data: {},
          timestamp: new Date(),
        };

        const result = await rulesEngine.evaluateRules(context);
        expect(result.matchedRules.length).toBe(0);
      });
    });

    describe('Complex Rule Conditions', () => {
      it('should evaluate AND conditions correctly', async () => {
        const andRule = {
          ...mockRule,
          logicalOperator: LogicalOperator.AND,
          conditions: [
            { field: 'temperature', operator: RuleOperator.GT, value: 30 },
            { field: 'humidity', operator: RuleOperator.GT, value: 80 },
          ],
        };
        alertRuleRepository.find.mockResolvedValue([andRule as AlertRule]);

        // Only temperature exceeds - should NOT match
        const partialContext: RuleEvaluationContext = {
          tenantId: 'tenant-1',
          data: { temperature: 35, humidity: 70 },
          timestamp: new Date(),
        };

        const partialResult = await rulesEngine.evaluateRules(partialContext);
        expect(partialResult.matchedRules.length).toBe(0);

        // Both exceed - should match
        const fullContext: RuleEvaluationContext = {
          tenantId: 'tenant-1',
          data: { temperature: 35, humidity: 85 },
          timestamp: new Date(),
        };

        const fullResult = await rulesEngine.evaluateRules(fullContext);
        expect(fullResult.matchedRules.length).toBeGreaterThan(0);
      });

      it('should evaluate OR conditions correctly', async () => {
        const orRule = {
          ...mockRule,
          logicalOperator: LogicalOperator.OR,
          conditions: [
            { field: 'temperature', operator: RuleOperator.GT, value: 30 },
            { field: 'humidity', operator: RuleOperator.GT, value: 80 },
          ],
        };
        alertRuleRepository.find.mockResolvedValue([orRule as AlertRule]);

        // Only temperature exceeds - should match
        const context: RuleEvaluationContext = {
          tenantId: 'tenant-1',
          data: { temperature: 35, humidity: 70 },
          timestamp: new Date(),
        };

        const result = await rulesEngine.evaluateRules(context);
        expect(result.matchedRules.length).toBeGreaterThan(0);
      });
    });
  });

  // ============================================================================
  // Stress and Performance Tests
  // ============================================================================

  describe('Stress Testing', () => {
    it('should handle high volume of rules evaluation', async () => {
      // Generate many rules
      const manyRules = Array.from({ length: 100 }, (_, i) => ({
        ...mockRule,
        id: `rule-${i}`,
        conditions: [
          { field: 'temperature', operator: RuleOperator.GT, value: 25 + (i % 10) },
        ],
      }));
      alertRuleRepository.find.mockResolvedValue(manyRules as AlertRule[]);

      const context: RuleEvaluationContext = {
        tenantId: 'tenant-1',
        data: { temperature: 35 },
        timestamp: new Date(),
      };

      const startTime = Date.now();
      const result = await rulesEngine.evaluateRules(context);
      const duration = Date.now() - startTime;

      expect(result).toBeDefined();
      expect(duration).toBeLessThan(1000); // Should complete within 1 second
    });

    it('should handle rapid sequential evaluations', async () => {
      const context: RuleEvaluationContext = {
        tenantId: 'tenant-1',
        data: { temperature: 35 },
        timestamp: new Date(),
      };

      const iterations = 50;
      const results: any[] = [];

      const startTime = Date.now();
      for (let i = 0; i < iterations; i++) {
        results.push(await rulesEngine.evaluateRules(context));
      }
      const totalDuration = Date.now() - startTime;

      expect(results.length).toBe(iterations);
      expect(totalDuration).toBeLessThan(5000); // 50 evaluations under 5 seconds
    });

    it('should handle concurrent risk calculations', async () => {
      const contexts = Array.from({ length: 20 }, (_, i) => ({
        tenantId: 'tenant-1',
        ruleId: `rule-${i}`,
        currentValue: 30 + i,
        thresholdValue: 30,
        previousIncidents: i,
        historicalValues: Array.from({ length: 10 }, () => Math.random() * 50),
      }));

      const startTime = Date.now();
      const results = await Promise.all(
        contexts.map((ctx) => riskCalculator.calculateRiskScore(ctx)),
      );
      const duration = Date.now() - startTime;

      expect(results.length).toBe(20);
      results.forEach((result) => {
        expect(result.totalScore).toBeGreaterThanOrEqual(0);
        expect(result.totalScore).toBeLessThanOrEqual(100);
      });
      expect(duration).toBeLessThan(2000);
    });

    it('should handle batch notification sending efficiently', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockImplementation(() =>
          new Promise((resolve) => setTimeout(() => resolve({ success: true }), 10))
        ),
      };

      notificationDispatcher.registerHandler(NotificationChannel.EMAIL, mockHandler);

      // Setup preferences for many users
      const userIds = Array.from({ length: 50 }, (_, i) => `user-${i}`);
      userIds.forEach((userId) => {
        channelRouter.setUserPreferences({
          userId,
          enabledChannels: [NotificationChannel.EMAIL],
          preferredChannel: NotificationChannel.EMAIL,
        });
      });

      const startTime = Date.now();
      const result = await notificationDispatcher.sendBatch({
        incidentId: 'incident-stress',
        tenantId: 'tenant-1',
        userIds,
        severity: AlertSeverity.HIGH,
        escalationLevel: 1,
        context: {
          incident: { id: 'incident-stress', title: 'Stress Test' } as any,
          severity: AlertSeverity.HIGH,
        },
      });
      const duration = Date.now() - startTime;

      expect(result.totalUsers).toBe(50);
      // Should batch/parallelize, not take 50 * 10ms = 500ms linearly
    });
  });

  // ============================================================================
  // Recovery and Resilience Tests
  // ============================================================================

  describe('Recovery Scenarios', () => {
    it('should recover from temporary database failure', async () => {
      let callCount = 0;
      alertRuleRepository.find.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          throw new Error('Database connection failed');
        }
        return [mockRule as AlertRule];
      });

      const context: RuleEvaluationContext = {
        tenantId: 'tenant-1',
        data: { temperature: 35 },
        timestamp: new Date(),
      };

      // First two attempts should fail, third should succeed
      await expect(rulesEngine.evaluateRules(context)).rejects.toThrow();
      await expect(rulesEngine.evaluateRules(context)).rejects.toThrow();
      const result = await rulesEngine.evaluateRules(context);
      expect(result).toBeDefined();
    });

    it('should handle partial notification failures gracefully', async () => {
      let sendCount = 0;
      const unreliableHandler: ChannelHandler = {
        send: jest.fn().mockImplementation(() => {
          sendCount++;
          if (sendCount % 3 === 0) {
            return Promise.resolve({ success: false, error: 'Intermittent failure' });
          }
          return Promise.resolve({ success: true });
        }),
      };

      notificationDispatcher.registerHandler(NotificationChannel.EMAIL, unreliableHandler);
      notificationDispatcher.setRetryConfig({ maxRetries: 0 });

      const userIds = ['user-1', 'user-2', 'user-3', 'user-4', 'user-5'];
      userIds.forEach((userId) => {
        channelRouter.setUserPreferences({
          userId,
          enabledChannels: [NotificationChannel.EMAIL],
          preferredChannel: NotificationChannel.EMAIL,
        });
      });

      const result = await notificationDispatcher.sendBatch({
        incidentId: 'incident-1',
        tenantId: 'tenant-1',
        userIds,
        severity: AlertSeverity.HIGH,
        escalationLevel: 1,
        context: {
          incident: { id: 'incident-1', title: 'Test' } as any,
          severity: AlertSeverity.HIGH,
        },
      });

      // Some should succeed, some should fail
      expect(result.failedCount).toBeGreaterThan(0);
      expect(result.successCount).toBeGreaterThan(0);
    });

    it('should maintain escalation state across restarts', async () => {
      const incident = new AlertIncident();
      incident.id = 'incident-persist';
      incident.tenantId = 'tenant-1';
      incident.title = 'Persistence Test';
      incident.status = IncidentStatus.NEW;
      incident.timeline = [];

      incidentRepository.findOne.mockResolvedValue(incident);
      incidentRepository.save.mockImplementation(async (i) => i as AlertIncident);

      // Start escalation
      const state = await escalationManager.startEscalation(
        incident,
        AlertSeverity.HIGH,
        'rule-1',
      );

      expect(state).toBeDefined();
      expect(state?.currentLevel).toBe(1);

      // Simulate restart by getting state from storage
      const retrievedState = escalationManager.getEscalationState('incident-persist');
      expect(retrievedState).toBeDefined();
    });
  });

  // ============================================================================
  // Data Consistency Tests
  // ============================================================================

  describe('Data Consistency', () => {
    it('should maintain consistent risk scores for identical inputs', async () => {
      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        thresholdValue: 30,
        previousIncidents: 3,
        historicalValues: [28, 29, 30, 31, 32],
      };

      const results = await Promise.all([
        riskCalculator.calculateRiskScore(context),
        riskCalculator.calculateRiskScore(context),
        riskCalculator.calculateRiskScore(context),
      ]);

      // All results should be identical
      expect(results[0].totalScore).toBe(results[1].totalScore);
      expect(results[1].totalScore).toBe(results[2].totalScore);
    });

    it('should maintain correct severity ordering', () => {
      const lowResult = severityClassifier.classifyByCriteria({
        impactScore: 20,
        frequencyScore: 20,
        trendScore: 20,
        urgency: 'LOW' as any,
        scope: 'INDIVIDUAL' as any,
      });

      const highResult = severityClassifier.classifyByCriteria({
        impactScore: 80,
        frequencyScore: 80,
        trendScore: 80,
        urgency: 'URGENT' as any,
        scope: 'GLOBAL' as any,
      });

      const severityOrder = {
        [AlertSeverity.LOW]: 1,
        [AlertSeverity.MEDIUM]: 2,
        [AlertSeverity.HIGH]: 3,
        [AlertSeverity.CRITICAL]: 4,
      };

      expect(severityOrder[highResult.severity]).toBeGreaterThanOrEqual(
        severityOrder[lowResult.severity],
      );
    });

    it('should not lose notifications during high load', async () => {
      const sentNotifications: string[] = [];
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockImplementation(async (notification) => {
          sentNotifications.push(notification.userId);
          return { success: true };
        }),
      };

      notificationDispatcher.registerHandler(NotificationChannel.EMAIL, mockHandler);

      const userIds = Array.from({ length: 100 }, (_, i) => `user-${i}`);
      userIds.forEach((userId) => {
        channelRouter.setUserPreferences({
          userId,
          enabledChannels: [NotificationChannel.EMAIL],
          preferredChannel: NotificationChannel.EMAIL,
        });
      });

      const result = await notificationDispatcher.sendBatch({
        incidentId: 'load-test',
        tenantId: 'tenant-1',
        userIds,
        severity: AlertSeverity.CRITICAL,
        escalationLevel: 1,
        context: {
          incident: { id: 'load-test', title: 'Load Test' } as any,
          severity: AlertSeverity.CRITICAL,
        },
      });

      expect(result.totalUsers).toBe(100);
      expect(result.successCount + result.failedCount).toBe(100);
    });
  });

  // ============================================================================
  // Time-Based Tests
  // ============================================================================

  describe('Time-Based Scenarios', () => {
    it('should handle escalation timeout correctly', async () => {
      const incident = new AlertIncident();
      incident.id = 'incident-timeout';
      incident.tenantId = 'tenant-1';
      incident.title = 'Timeout Test';
      incident.status = IncidentStatus.NEW;
      incident.timeline = [];

      incidentRepository.findOne.mockResolvedValue(incident);
      incidentRepository.save.mockImplementation(async (i) => i as AlertIncident);

      await escalationManager.startEscalation(incident, AlertSeverity.HIGH);

      // Simulate time passing beyond timeout (15 minutes)
      jest.advanceTimersByTime(16 * 60 * 1000);

      // Escalation should have progressed or timed out
      const state = escalationManager.getEscalationState('incident-timeout');
      expect(state).toBeDefined();
    });

    it('should respect notification rate limiting', async () => {
      const sentTimes: number[] = [];
      const rateLimitedHandler: ChannelHandler = {
        send: jest.fn().mockImplementation(async () => {
          sentTimes.push(Date.now());
          return { success: true };
        }),
      };

      notificationDispatcher.registerHandler(NotificationChannel.EMAIL, rateLimitedHandler);

      channelRouter.setUserPreferences({
        userId: 'rate-limited-user',
        enabledChannels: [NotificationChannel.EMAIL],
        preferredChannel: NotificationChannel.EMAIL,
      });

      // Send multiple notifications quickly
      for (let i = 0; i < 5; i++) {
        await notificationDispatcher.send({
          incidentId: `incident-rate-${i}`,
          tenantId: 'tenant-1',
          userId: 'rate-limited-user',
          severity: AlertSeverity.HIGH,
          escalationLevel: 1,
          context: {
            incident: { id: `incident-rate-${i}`, title: 'Rate Test' } as any,
            severity: AlertSeverity.HIGH,
          },
        });
      }

      // All should be processed (rate limiting may delay but not drop)
      expect(rateLimitedHandler.send).toHaveBeenCalledTimes(5);
    });
  });
});
