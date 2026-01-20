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
});
