import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotificationDispatcherService,
  NotificationRequest,
  NotificationStatus,
  NotificationPriority,
  ChannelHandler,
  NOTIFICATION_EVENTS,
} from '../notification-dispatcher.service';
import { ChannelRouterService, RoutingDecision } from '../channel-router.service';
import { TemplateRendererService, RenderedNotification, TemplateContext } from '../template-renderer.service';
import { NotificationChannel } from '../../database/entities/escalation-policy.entity';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import { IncidentStatus } from '../../database/entities/alert-incident.entity';

describe('NotificationDispatcherService', () => {
  let service: NotificationDispatcherService;
  let channelRouter: jest.Mocked<ChannelRouterService>;
  let templateRenderer: jest.Mocked<TemplateRendererService>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  const mockRoutingDecision: RoutingDecision = {
    userId: 'user-1',
    channels: [NotificationChannel.EMAIL, NotificationChannel.SLACK],
    primaryChannel: NotificationChannel.EMAIL,
    reason: 'Default routing',
  };

  const mockRenderedNotification: RenderedNotification = {
    subject: 'Test Alert',
    body: 'This is a test notification',
    htmlBody: '<p>This is a test notification</p>',
    metadata: { templateId: 'default-email' },
  };

  const mockContext: TemplateContext = {
    incident: {
      id: 'incident-1',
      title: 'Test Incident',
      description: 'Test description',
      status: IncidentStatus.NEW,
    },
    severity: AlertSeverity.HIGH,
    escalationLevel: 1,
  };

  const mockRequest: NotificationRequest = {
    incidentId: 'incident-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    severity: AlertSeverity.HIGH,
    escalationLevel: 1,
    context: mockContext,
  };

  beforeEach(async () => {
    jest.useFakeTimers();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationDispatcherService,
        {
          provide: ChannelRouterService,
          useValue: {
            route: jest.fn(),
          },
        },
        {
          provide: TemplateRendererService,
          useValue: {
            render: jest.fn(),
          },
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<NotificationDispatcherService>(NotificationDispatcherService);
    channelRouter = module.get(ChannelRouterService);
    templateRenderer = module.get(TemplateRendererService);
    eventEmitter = module.get(EventEmitter2);

    // Default mocks
    channelRouter.route.mockReturnValue(mockRoutingDecision);
    templateRenderer.render.mockReturnValue(mockRenderedNotification);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('send', () => {
    it('should send notification through routed channels', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: true, messageId: 'msg-1' }),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);
      service.registerHandler(NotificationChannel.SLACK, mockHandler);

      const results = await service.send(mockRequest);

      expect(results).toHaveLength(2);
      expect(results.every(r => r.status === NotificationStatus.SENT)).toBe(true);
    });

    it('should return skipped status when no channels available', async () => {
      channelRouter.route.mockReturnValue({
        ...mockRoutingDecision,
        channels: [],
      });

      const results = await service.send(mockRequest);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe(NotificationStatus.SKIPPED);
    });

    it('should emit sent event on successful send', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: true }),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);
      channelRouter.route.mockReturnValue({
        ...mockRoutingDecision,
        channels: [NotificationChannel.EMAIL],
      });

      await service.send(mockRequest);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NOTIFICATION_EVENTS.SENT,
        expect.objectContaining({
          status: NotificationStatus.SENT,
        }),
      );
    });

    it('should use requested channels when provided', async () => {
      const requestWithChannels: NotificationRequest = {
        ...mockRequest,
        channels: [NotificationChannel.SMS],
      };

      await service.send(requestWithChannels);

      expect(channelRouter.route).toHaveBeenCalledWith(
        'user-1',
        AlertSeverity.HIGH,
        [NotificationChannel.SMS],
        expect.any(Object),
      );
    });

    it('should skip channel without handler', async () => {
      // Don't register any handlers
      const results = await service.send(mockRequest);

      expect(results.every(r => r.status === NotificationStatus.SKIPPED)).toBe(true);
    });
  });

  describe('sendBatch', () => {
    it('should send to multiple users', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: true }),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);
      channelRouter.route.mockReturnValue({
        ...mockRoutingDecision,
        channels: [NotificationChannel.EMAIL],
      });

      const result = await service.sendBatch({
        incidentId: 'incident-1',
        tenantId: 'tenant-1',
        userIds: ['user-1', 'user-2', 'user-3'],
        severity: AlertSeverity.HIGH,
        escalationLevel: 1,
        context: mockContext,
      });

      expect(result.totalUsers).toBe(3);
      expect(result.successCount).toBe(3);
    });

    it('should track success and failure counts', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn()
          .mockResolvedValueOnce({ success: true })
          .mockResolvedValueOnce({ success: false, error: 'Failed' })
          .mockResolvedValueOnce({ success: true }),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);
      service.setRetryConfig({ maxRetries: 0 }); // Disable retries for this test

      channelRouter.route.mockReturnValue({
        ...mockRoutingDecision,
        channels: [NotificationChannel.EMAIL],
      });

      const result = await service.sendBatch({
        incidentId: 'incident-1',
        tenantId: 'tenant-1',
        userIds: ['user-1', 'user-2', 'user-3'],
        severity: AlertSeverity.HIGH,
        escalationLevel: 1,
        context: mockContext,
      });

      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(1);
    });

    it('should emit batch completed event', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: true }),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);
      channelRouter.route.mockReturnValue({
        ...mockRoutingDecision,
        channels: [NotificationChannel.EMAIL],
      });

      await service.sendBatch({
        incidentId: 'incident-1',
        tenantId: 'tenant-1',
        userIds: ['user-1'],
        severity: AlertSeverity.HIGH,
        escalationLevel: 1,
        context: mockContext,
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NOTIFICATION_EVENTS.BATCH_COMPLETED,
        expect.any(Object),
      );
    });

    it('should include timing information', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: true }),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);
      channelRouter.route.mockReturnValue({
        ...mockRoutingDecision,
        channels: [NotificationChannel.EMAIL],
      });

      const result = await service.sendBatch({
        incidentId: 'incident-1',
        tenantId: 'tenant-1',
        userIds: ['user-1'],
        severity: AlertSeverity.HIGH,
        escalationLevel: 1,
        context: mockContext,
      });

      expect(result.startedAt).toBeInstanceOf(Date);
      expect(result.completedAt).toBeInstanceOf(Date);
    });
  });

  describe('sendToChannel', () => {
    it('should send notification to specific channel', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: true, messageId: 'msg-1' }),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);

      const result = await service.sendToChannel(
        'req-1',
        'user-1',
        NotificationChannel.EMAIL,
        mockContext,
        AlertSeverity.HIGH,
      );

      expect(result.status).toBe(NotificationStatus.SENT);
      expect(mockHandler.send).toHaveBeenCalled();
    });

    it('should render template for channel', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: true }),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);

      await service.sendToChannel(
        'req-1',
        'user-1',
        NotificationChannel.EMAIL,
        mockContext,
        AlertSeverity.HIGH,
      );

      expect(templateRenderer.render).toHaveBeenCalledWith(
        NotificationChannel.EMAIL,
        mockContext,
      );
    });

    it('should skip for unregistered channel', async () => {
      const result = await service.sendToChannel(
        'req-1',
        'user-1',
        NotificationChannel.SMS,
        mockContext,
        AlertSeverity.HIGH,
      );

      expect(result.status).toBe(NotificationStatus.SKIPPED);
      expect(result.error).toContain('No handler');
    });
  });

  describe('retry mechanism', () => {
    it('should retry on failure', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn()
          .mockResolvedValueOnce({ success: false, error: 'First attempt failed' })
          .mockResolvedValueOnce({ success: true }),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);
      service.setRetryConfig({ maxRetries: 3, initialDelayMs: 100 });

      channelRouter.route.mockReturnValue({
        ...mockRoutingDecision,
        channels: [NotificationChannel.EMAIL],
      });

      const resultPromise = service.send(mockRequest);

      // Advance timers for retry
      jest.advanceTimersByTime(200);

      const results = await resultPromise;

      expect(mockHandler.send).toHaveBeenCalledTimes(2);
      expect(results[0].status).toBe(NotificationStatus.SENT);
    });

    it('should emit failed event after max retries', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: false, error: 'Always fails' }),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);
      service.setRetryConfig({ maxRetries: 2, initialDelayMs: 100, maxDelayMs: 500, backoffMultiplier: 2 });

      channelRouter.route.mockReturnValue({
        ...mockRoutingDecision,
        channels: [NotificationChannel.EMAIL],
      });

      const resultPromise = service.send(mockRequest);

      // Advance through all retries
      jest.advanceTimersByTime(100); // First retry
      jest.advanceTimersByTime(200); // Second retry
      jest.advanceTimersByTime(400); // After max retries

      const results = await resultPromise;

      expect(results[0].status).toBe(NotificationStatus.FAILED);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NOTIFICATION_EVENTS.FAILED,
        expect.any(Object),
      );
    });

    it('should respect retry config', () => {
      const config = { maxRetries: 5, initialDelayMs: 2000 };
      service.setRetryConfig(config);

      const retrieved = service.getRetryConfig();

      expect(retrieved.maxRetries).toBe(5);
      expect(retrieved.initialDelayMs).toBe(2000);
    });
  });

  describe('handler management', () => {
    it('should register handler', () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn(),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);

      expect(service.hasHandler(NotificationChannel.EMAIL)).toBe(true);
    });

    it('should unregister handler', () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn(),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);
      const removed = service.unregisterHandler(NotificationChannel.EMAIL);

      expect(removed).toBe(true);
      expect(service.hasHandler(NotificationChannel.EMAIL)).toBe(false);
    });

    it('should return false when unregistering non-existent handler', () => {
      const removed = service.unregisterHandler(NotificationChannel.SMS);

      expect(removed).toBe(false);
    });

    it('should list registered handlers', () => {
      service.registerHandler(NotificationChannel.EMAIL, { send: jest.fn() });
      service.registerHandler(NotificationChannel.SLACK, { send: jest.fn() });

      const handlers = service.getRegisteredHandlers();

      expect(handlers).toContain(NotificationChannel.EMAIL);
      expect(handlers).toContain(NotificationChannel.SLACK);
    });
  });

  describe('queue management', () => {
    it('should queue notification', () => {
      const requestId = service.queueNotification(mockRequest);

      expect(requestId).toBeDefined();
      expect(service.getQueueSize()).toBe(1);
    });

    it('should process queued notifications', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: true }),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);
      channelRouter.route.mockReturnValue({
        ...mockRoutingDecision,
        channels: [NotificationChannel.EMAIL],
      });

      service.queueNotification(mockRequest);
      service.queueNotification(mockRequest);

      const processed = await service.processQueue();

      expect(processed).toBe(2);
      expect(service.getQueueSize()).toBe(0);
    });

    it('should clear queue', () => {
      service.queueNotification(mockRequest);
      service.queueNotification(mockRequest);

      const cleared = service.clearQueue();

      expect(cleared).toBe(2);
      expect(service.getQueueSize()).toBe(0);
    });
  });

  describe('markDelivered', () => {
    it('should emit delivered event', () => {
      service.markDelivered('req-1', NotificationChannel.EMAIL, 'user-1');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NOTIFICATION_EVENTS.DELIVERED,
        expect.objectContaining({
          requestId: 'req-1',
          channel: NotificationChannel.EMAIL,
          userId: 'user-1',
          status: NotificationStatus.DELIVERED,
        }),
      );
    });

    it('should include delivery timestamp', () => {
      service.markDelivered('req-1', NotificationChannel.EMAIL, 'user-1');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NOTIFICATION_EVENTS.DELIVERED,
        expect.objectContaining({
          deliveredAt: expect.any(Date),
        }),
      );
    });
  });

  describe('statistics', () => {
    it('should return notification statistics', () => {
      service.registerHandler(NotificationChannel.EMAIL, { send: jest.fn() });
      service.queueNotification(mockRequest);

      const stats = service.getStatistics();

      expect(stats.registeredHandlers).toBe(1);
      expect(stats.queuedNotifications).toBe(1);
    });
  });

  describe('testSend', () => {
    it('should send test notification', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: true }),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);

      const result = await service.testSend(NotificationChannel.EMAIL, 'user-1');

      expect(result.status).toBe(NotificationStatus.SENT);
      expect(mockHandler.send).toHaveBeenCalledWith(
        'user-1',
        expect.any(Object),
        expect.objectContaining({ isTest: true }),
      );
    });

    it('should use custom context when provided', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: true }),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);

      await service.testSend(NotificationChannel.EMAIL, 'user-1', mockContext);

      expect(templateRenderer.render).toHaveBeenCalledWith(
        NotificationChannel.EMAIL,
        mockContext,
      );
    });
  });

  describe('error handling', () => {
    it('should handle handler exceptions', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockRejectedValue(new Error('Handler crashed')),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);
      service.setRetryConfig({ maxRetries: 0 });

      channelRouter.route.mockReturnValue({
        ...mockRoutingDecision,
        channels: [NotificationChannel.EMAIL],
      });

      const results = await service.send(mockRequest);

      expect(results[0].status).toBe(NotificationStatus.FAILED);
      expect(results[0].error).toBe('Handler crashed');
    });

    it('should include retry count in result', async () => {
      const mockHandler: ChannelHandler = {
        send: jest.fn().mockResolvedValue({ success: false, error: 'Failed' }),
      };

      service.registerHandler(NotificationChannel.EMAIL, mockHandler);
      service.setRetryConfig({ maxRetries: 2, initialDelayMs: 100 });

      channelRouter.route.mockReturnValue({
        ...mockRoutingDecision,
        channels: [NotificationChannel.EMAIL],
      });

      const resultPromise = service.send(mockRequest);

      jest.advanceTimersByTime(100);
      jest.advanceTimersByTime(200);
      jest.advanceTimersByTime(400);

      const results = await resultPromise;

      expect(results[0].retryCount).toBe(2);
    });
  });
});
