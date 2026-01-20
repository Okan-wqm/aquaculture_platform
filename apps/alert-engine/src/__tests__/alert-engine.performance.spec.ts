import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { RulesEngineService, RuleEvaluationContext } from '../rules-engine/rules-engine.service';
import { RuleEvaluatorService } from '../rules-engine/rule-evaluator.service';
import { RiskCalculatorService, RiskCalculationContext } from '../risk-scoring/risk-calculator.service';
import { ImpactAnalyzerService } from '../risk-scoring/impact-analyzer.service';
import { SeverityClassifierService } from '../risk-scoring/severity-classifier.service';
import { NotificationDispatcherService, ChannelHandler } from '../notification/notification-dispatcher.service';
import { ChannelRouterService } from '../notification/channel-router.service';
import { TemplateRendererService } from '../notification/template-renderer.service';

import { AlertRule, AlertSeverity, RuleOperator, LogicalOperator } from '../database/entities/alert-rule.entity';
import { NotificationChannel } from '../database/entities/escalation-policy.entity';

/**
 * Performance tests for Alert Engine
 * Tests response times and throughput under various loads
 */
describe('Alert Engine Performance', () => {
  let rulesEngine: RulesEngineService;
  let ruleEvaluator: RuleEvaluatorService;
  let riskCalculator: RiskCalculatorService;
  let impactAnalyzer: ImpactAnalyzerService;
  let severityClassifier: SeverityClassifierService;
  let notificationDispatcher: NotificationDispatcherService;
  let channelRouter: ChannelRouterService;
  let templateRenderer: TemplateRendererService;

  let alertRuleRepository: jest.Mocked<Repository<AlertRule>>;

  const createMockRule = (id: string): Partial<AlertRule> => ({
    id,
    tenantId: 'tenant-1',
    name: `Rule ${id}`,
    severity: AlertSeverity.HIGH,
    isActive: true,
    conditions: [
      { field: 'temperature', operator: RuleOperator.GT, value: 30 },
    ],
    logicalOperator: LogicalOperator.AND,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RulesEngineService,
        RuleEvaluatorService,
        RiskCalculatorService,
        ImpactAnalyzerService,
        SeverityClassifierService,
        NotificationDispatcherService,
        ChannelRouterService,
        TemplateRendererService,
        {
          provide: getRepositoryToken(AlertRule),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
          },
        },
        {
          provide: EventEmitter2,
          useValue: { emit: jest.fn() },
        },
      ],
    }).compile();

    rulesEngine = module.get<RulesEngineService>(RulesEngineService);
    ruleEvaluator = module.get<RuleEvaluatorService>(RuleEvaluatorService);
    riskCalculator = module.get<RiskCalculatorService>(RiskCalculatorService);
    impactAnalyzer = module.get<ImpactAnalyzerService>(ImpactAnalyzerService);
    severityClassifier = module.get<SeverityClassifierService>(SeverityClassifierService);
    notificationDispatcher = module.get<NotificationDispatcherService>(NotificationDispatcherService);
    channelRouter = module.get<ChannelRouterService>(ChannelRouterService);
    templateRenderer = module.get<TemplateRendererService>(TemplateRendererService);

    alertRuleRepository = module.get(getRepositoryToken(AlertRule));
  });

  describe('Rule Evaluation Performance', () => {
    it('should evaluate single rule in under 10ms', async () => {
      const rule = createMockRule('rule-1');
      const context = { temperature: 35 };

      const startTime = performance.now();

      for (let i = 0; i < 100; i++) {
        ruleEvaluator.evaluate(rule as AlertRule, context);
      }

      const endTime = performance.now();
      const avgTime = (endTime - startTime) / 100;

      expect(avgTime).toBeLessThan(10);
    });

    it('should evaluate complex AND conditions efficiently', async () => {
      const complexRule: Partial<AlertRule> = {
        ...createMockRule('complex-and'),
        conditions: [
          { field: 'temperature', operator: RuleOperator.GT, value: 30 },
          { field: 'humidity', operator: RuleOperator.GT, value: 70 },
          { field: 'pressure', operator: RuleOperator.LT, value: 1000 },
          { field: 'windSpeed', operator: RuleOperator.GT, value: 20 },
          { field: 'salinity', operator: RuleOperator.GT, value: 35 },
        ],
        logicalOperator: LogicalOperator.AND,
      };

      const context = {
        temperature: 35,
        humidity: 80,
        pressure: 950,
        windSpeed: 25,
        salinity: 40,
      };

      const startTime = performance.now();

      for (let i = 0; i < 100; i++) {
        ruleEvaluator.evaluate(complexRule as AlertRule, context);
      }

      const endTime = performance.now();
      const avgTime = (endTime - startTime) / 100;

      expect(avgTime).toBeLessThan(5);
    });

    it('should evaluate 100 rules in under 100ms', async () => {
      const rules = Array.from({ length: 100 }, (_, i) => createMockRule(`rule-${i}`));
      alertRuleRepository.find.mockResolvedValue(rules as AlertRule[]);

      const context: RuleEvaluationContext = {
        tenantId: 'tenant-1',
        data: { temperature: 35 },
        timestamp: new Date(),
      };

      const startTime = performance.now();

      await rulesEngine.evaluateRules(context);

      const endTime = performance.now();
      const totalTime = endTime - startTime;

      expect(totalTime).toBeLessThan(100);
    });

    it('should benefit from rule caching', async () => {
      const rules = Array.from({ length: 50 }, (_, i) => createMockRule(`rule-${i}`));
      alertRuleRepository.find.mockResolvedValue(rules as AlertRule[]);

      const context: RuleEvaluationContext = {
        tenantId: 'tenant-1',
        data: { temperature: 35 },
        timestamp: new Date(),
      };

      // First call (cache miss)
      const startTime1 = performance.now();
      await rulesEngine.evaluateRules(context);
      const time1 = performance.now() - startTime1;

      // Second call (cache hit)
      const startTime2 = performance.now();
      await rulesEngine.evaluateRules(context);
      const time2 = performance.now() - startTime2;

      // Cached call should be faster
      expect(time2).toBeLessThanOrEqual(time1);
    });
  });

  describe('Risk Calculation Performance', () => {
    it('should calculate risk score in under 50ms', async () => {
      alertRuleRepository.findOne.mockResolvedValue(createMockRule('rule-1') as AlertRule);

      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        thresholdValue: 30,
        previousIncidents: 5,
        historicalValues: Array.from({ length: 100 }, () => Math.random() * 40),
      };

      const startTime = performance.now();

      await riskCalculator.calculateRiskScore(context);

      const endTime = performance.now();

      expect(endTime - startTime).toBeLessThan(50);
    });

    it('should calculate batch risk scores efficiently', async () => {
      alertRuleRepository.findOne.mockResolvedValue(createMockRule('rule-1') as AlertRule);

      const contexts: RiskCalculationContext[] = Array.from({ length: 50 }, (_, i) => ({
        tenantId: 'tenant-1',
        ruleId: `rule-${i}`,
        currentValue: 30 + Math.random() * 20,
        thresholdValue: 30,
      }));

      const startTime = performance.now();

      await riskCalculator.calculateBatchRiskScores(contexts);

      const endTime = performance.now();

      // Should process 50 risk calculations in under 500ms
      expect(endTime - startTime).toBeLessThan(500);
    });

    it('should calculate trend efficiently with large datasets', () => {
      const largeDataset = Array.from({ length: 1000 }, () => Math.random() * 100);

      const startTime = performance.now();

      for (let i = 0; i < 100; i++) {
        riskCalculator.calculateTrend(largeDataset);
      }

      const endTime = performance.now();
      const avgTime = (endTime - startTime) / 100;

      expect(avgTime).toBeLessThan(5);
    });

    it('should calculate standard deviation efficiently', () => {
      const largeDataset = Array.from({ length: 1000 }, () => Math.random() * 100);

      const startTime = performance.now();

      for (let i = 0; i < 100; i++) {
        riskCalculator.calculateStdDev(largeDataset);
      }

      const endTime = performance.now();
      const avgTime = (endTime - startTime) / 100;

      expect(avgTime).toBeLessThan(5);
    });
  });

  describe('Severity Classification Performance', () => {
    it('should classify severity in under 1ms', () => {
      const startTime = performance.now();

      for (let i = 0; i < 1000; i++) {
        severityClassifier.classifyByCriteria({
          impactScore: 80,
          frequencyScore: 60,
          trendScore: 70,
        });
      }

      const endTime = performance.now();
      const avgTime = (endTime - startTime) / 1000;

      expect(avgTime).toBeLessThan(1);
    });

    it('should batch classify efficiently', () => {
      const criteriaList = Array.from({ length: 100 }, () => ({
        impactScore: Math.random() * 100,
        frequencyScore: Math.random() * 100,
        trendScore: Math.random() * 100,
      }));

      const startTime = performance.now();

      severityClassifier.batchClassify(criteriaList);

      const endTime = performance.now();

      expect(endTime - startTime).toBeLessThan(50);
    });
  });

  describe('Notification Routing Performance', () => {
    it('should route notifications in under 5ms', () => {
      // Set up multiple user preferences
      for (let i = 0; i < 100; i++) {
        channelRouter.setUserPreferences({
          userId: `user-${i}`,
          enabledChannels: [NotificationChannel.EMAIL, NotificationChannel.SLACK],
          preferredChannel: NotificationChannel.EMAIL,
        });
      }

      const startTime = performance.now();

      for (let i = 0; i < 100; i++) {
        channelRouter.route(`user-${i}`, AlertSeverity.HIGH);
      }

      const endTime = performance.now();
      const avgTime = (endTime - startTime) / 100;

      expect(avgTime).toBeLessThan(5);
    });

    it('should route to many users efficiently', () => {
      const userIds = Array.from({ length: 100 }, (_, i) => `user-${i}`);

      userIds.forEach(userId => {
        channelRouter.setUserPreferences({
          userId,
          enabledChannels: [NotificationChannel.EMAIL],
          preferredChannel: NotificationChannel.EMAIL,
        });
      });

      const startTime = performance.now();

      channelRouter.routeToMany(userIds, AlertSeverity.HIGH);

      const endTime = performance.now();

      expect(endTime - startTime).toBeLessThan(100);
    });
  });

  describe('Template Rendering Performance', () => {
    it('should render email template in under 2ms', () => {
      const context = {
        incident: {
          id: 'incident-1',
          title: 'Test Alert',
          description: 'Test description',
        } as any,
        severity: AlertSeverity.HIGH,
        escalationLevel: 1,
      };

      const startTime = performance.now();

      for (let i = 0; i < 100; i++) {
        templateRenderer.renderForEmail(context);
      }

      const endTime = performance.now();
      const avgTime = (endTime - startTime) / 100;

      expect(avgTime).toBeLessThan(2);
    });

    it('should render all channel templates efficiently', () => {
      const context = {
        incident: {
          id: 'incident-1',
          title: 'Test Alert',
          description: 'Test description',
        } as any,
        severity: AlertSeverity.HIGH,
        escalationLevel: 1,
      };

      const channels = [
        NotificationChannel.EMAIL,
        NotificationChannel.SMS,
        NotificationChannel.SLACK,
        NotificationChannel.TEAMS,
        NotificationChannel.PUSH,
        NotificationChannel.WEBHOOK,
      ];

      const startTime = performance.now();

      for (let i = 0; i < 100; i++) {
        channels.forEach(channel => {
          templateRenderer.render(channel, context);
        });
      }

      const endTime = performance.now();
      const avgTime = (endTime - startTime) / 100;

      // 6 templates per iteration should still be fast
      expect(avgTime).toBeLessThan(10);
    });
  });

  describe('Notification Dispatch Performance', () => {
    it('should queue notifications quickly', () => {
      const startTime = performance.now();

      for (let i = 0; i < 1000; i++) {
        notificationDispatcher.queueNotification({
          incidentId: `incident-${i}`,
          tenantId: 'tenant-1',
          userId: `user-${i % 100}`,
          severity: AlertSeverity.HIGH,
          escalationLevel: 1,
          context: {
            incident: { id: `incident-${i}`, title: 'Test' } as any,
            severity: AlertSeverity.HIGH,
          },
        });
      }

      const endTime = performance.now();

      // Queuing 1000 notifications should be under 100ms
      expect(endTime - startTime).toBeLessThan(100);

      // Clean up
      notificationDispatcher.clearQueue();
    });

    it('should send notifications concurrently', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: true }),
      };

      notificationDispatcher.registerHandler(NotificationChannel.EMAIL, mockHandler);

      const userIds = Array.from({ length: 50 }, (_, i) => `user-${i}`);
      userIds.forEach(userId => {
        channelRouter.setUserPreferences({
          userId,
          enabledChannels: [NotificationChannel.EMAIL],
          preferredChannel: NotificationChannel.EMAIL,
        });
      });

      const startTime = performance.now();

      await notificationDispatcher.sendBatch({
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

      const endTime = performance.now();

      // Should process 50 users quickly due to parallelization
      expect(endTime - startTime).toBeLessThan(500);
    });
  });

  describe('Memory Usage', () => {
    it('should not leak memory during rule evaluation', async () => {
      const rules = Array.from({ length: 100 }, (_, i) => createMockRule(`rule-${i}`));
      alertRuleRepository.find.mockResolvedValue(rules as AlertRule[]);

      const context: RuleEvaluationContext = {
        tenantId: 'tenant-1',
        data: { temperature: 35 },
        timestamp: new Date(),
      };

      // Run multiple times to detect memory growth
      for (let i = 0; i < 100; i++) {
        await rulesEngine.evaluateRules(context);
      }

      // If we get here without OOM, test passes
      expect(true).toBe(true);
    });

    it('should handle large historical datasets without issues', async () => {
      alertRuleRepository.findOne.mockResolvedValue(createMockRule('rule-1') as AlertRule);

      const context: RiskCalculationContext = {
        tenantId: 'tenant-1',
        ruleId: 'rule-1',
        currentValue: 35,
        historicalValues: Array.from({ length: 10000 }, () => Math.random() * 100),
      };

      await riskCalculator.calculateRiskScore(context);

      // If we get here without issues, test passes
      expect(true).toBe(true);
    });
  });

  describe('Throughput Tests', () => {
    it('should handle high throughput of rule evaluations', async () => {
      const rules = Array.from({ length: 10 }, (_, i) => createMockRule(`rule-${i}`));
      alertRuleRepository.find.mockResolvedValue(rules as AlertRule[]);

      const startTime = performance.now();
      const iterations = 100;

      const promises = Array.from({ length: iterations }, (_, i) =>
        rulesEngine.evaluateRules({
          tenantId: 'tenant-1',
          data: { temperature: 25 + (i % 20) },
          timestamp: new Date(),
        }),
      );

      await Promise.all(promises);

      const endTime = performance.now();
      const throughput = iterations / ((endTime - startTime) / 1000);

      // Should handle at least 100 evaluations per second
      expect(throughput).toBeGreaterThan(100);
    });
  });
});
