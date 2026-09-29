import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxPublisher } from '@platform/outbox';
import type { BaseEvent } from '@platform/event-contracts';
import { RedisService } from '@aquaculture/backend-common/redis';
import {
  EscalationManagerService,
  EscalationStart,
  EscalationState,
  AcknowledgmentRecord,
  NotificationRecord,
  ESCALATION_EVENTS,
} from '../escalation-manager.service';
import { AlertAuditService } from '../../audit/alert-audit.service';
import { EscalationPolicyService } from '../escalation-policy.service';
import {
  EscalationPolicy,
  EscalationLevel,
  EscalationActionType,
  NotificationChannel,
} from '../../database/entities/escalation-policy.entity';
import {
  AlertIncident,
  IncidentStatus,
  TimelineEventType,
} from '../../database/entities/alert-incident.entity';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';

// Timers, the missed-escalation sweep and restore run the incident lookup inside
// the escalation's tenant context, which requires a canonical tenant UUID.
const TENANT_ID = '7f6b08ab-90e2-46d3-8a11-2b3c4d5e6f70';

/** A first escalation of a HIGH incident. */
const HIGH_START: EscalationStart = { severity: AlertSeverity.HIGH };

/**
 * The claim's query-builder chain (V-S1a-4). `execute` answers how many rows
 * the conditional UPDATE claimed: 1 = this caller won the level.
 */
function claimQueryBuilder(affected = 1): Record<string, jest.Mock> {
  const qb: Record<string, jest.Mock> = {};
  for (const step of ['update', 'set', 'where', 'andWhere', 'setParameter', 'returning']) {
    qb[step] = jest.fn(() => qb);
  }
  qb['execute'] = jest.fn().mockResolvedValue({ affected, raw: [] });
  return qb;
}

describe('EscalationManagerService', () => {
  let service: EscalationManagerService;
  let incidentRepository: jest.Mocked<Repository<AlertIncident>>;
  let policyService: jest.Mocked<EscalationPolicyService>;
  let eventEmitter: jest.Mocked<EventEmitter2>;
  let redisService: jest.Mocked<RedisService>;
  // Transaction manager mock (ALERT-CRITICAL-001): escalation-level write +
  // AlertEscalated enqueue commit atomically on this single manager.
  let txManager: { createQueryBuilder: jest.Mock };
  let claim: Record<string, jest.Mock>;
  let outbox: { enqueue: jest.Mock };

  // In-memory store for Redis mock
  const redisStore: Map<string, string> = new Map();
  const redisSets: Map<string, Set<string>> = new Map();

  const mockLevel1: EscalationLevel = {
    level: 1,
    name: 'Level 1 - Initial',
    timeoutMinutes: 15,
    notifyUserIds: ['user-1'],
    channels: [NotificationChannel.EMAIL],
    action: EscalationActionType.NOTIFY,
  };

  const mockLevel2: EscalationLevel = {
    level: 2,
    name: 'Level 2 - Escalated',
    timeoutMinutes: 30,
    notifyUserIds: ['user-2', 'user-3'],
    channels: [NotificationChannel.EMAIL, NotificationChannel.SMS],
    action: EscalationActionType.ESCALATE_TO_MANAGER,
  };

  const mockPolicy: Partial<EscalationPolicy> = {
    id: 'policy-1',
    tenantId: TENANT_ID,
    name: 'Test Policy',
    severity: [AlertSeverity.HIGH, AlertSeverity.CRITICAL],
    levels: [mockLevel1, mockLevel2],
    repeatIntervalMinutes: 5,
    maxRepeats: 3,
    isActive: true,
    getLevel: jest.fn((level: number) => {
      if (level === 1) return mockLevel1;
      if (level === 2) return mockLevel2;
      return undefined;
    }),
    getMaxLevel: jest.fn().mockReturnValue(2),
    hasNextLevel: jest.fn((level: number) => level < 2),
    getNextLevel: jest.fn((level: number) => {
      if (level === 1) return mockLevel2;
      return undefined;
    }),
    getCurrentOnCall: jest.fn().mockReturnValue(undefined),
    suppresses: jest.fn().mockReturnValue(false),
  };

  const mockIncident: Partial<AlertIncident> = {
    id: 'incident-1',
    tenantId: TENANT_ID,
    title: 'Test Alert',
    description: 'Test description',
    status: IncidentStatus.NEW,
    escalationLevel: 0,
    acknowledge: jest.fn(),
    addTimelineEvent: jest.fn(),
    timeline: [],
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    redisStore.clear();
    redisSets.clear();

    const mockRedisService = {
      setJson: jest.fn().mockImplementation(async (key: string, value: any, _ttl?: number) => {
        redisStore.set(key, JSON.stringify(value));
      }),
      getJson: jest.fn().mockImplementation(async (key: string) => {
        const value = redisStore.get(key);
        return value ? JSON.parse(value) : null;
      }),
      del: jest.fn().mockImplementation(async (key: string) => {
        const hadValue = redisStore.delete(key);
        const hadSet = redisSets.delete(key);
        return hadValue || hadSet ? 1 : 0;
      }),
      keys: jest.fn().mockImplementation(async (pattern: string) => {
        const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
        return Array.from(redisStore.keys()).filter(k => regex.test(k));
      }),
      scan: jest.fn().mockImplementation(async (pattern: string) => {
        const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
        return Array.from(redisStore.keys()).filter(k => regex.test(k));
      }),
      setNx: jest.fn().mockImplementation(async (key: string, value: string, _ttl?: number) => {
        if (redisStore.has(key)) return false;
        redisStore.set(key, value);
        return true;
      }),
      sadd: jest.fn().mockImplementation(async (key: string, ...members: string[]) => {
        const set = redisSets.get(key) ?? new Set<string>();
        let added = 0;
        for (const member of members) {
          if (!set.has(member)) {
            added += 1;
          }
          set.add(member);
        }
        redisSets.set(key, set);
        return added;
      }),
      srem: jest.fn().mockImplementation(async (key: string, ...members: string[]) => {
        const set = redisSets.get(key);
        if (!set) return 0;
        let removed = 0;
        for (const member of members) {
          if (set.delete(member)) {
            removed += 1;
          }
        }
        if (set.size === 0) {
          redisSets.delete(key);
        }
        return removed;
      }),
      smembers: jest.fn().mockImplementation(async (key: string) => {
        return Array.from(redisSets.get(key) ?? []);
      }),
    };

    claim = claimQueryBuilder();
    txManager = { createQueryBuilder: jest.fn(() => claim) };
    outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };

    // Structural typing of the transaction callback against the mock manager
    // shape — cast-free. `useValue` is untyped so Nest accepts the literal
    // without asserting DataSource compatibility.
    const mockDataSource = {
      transaction: (
        cb: (m: typeof txManager) => Promise<unknown>,
      ): Promise<unknown> => cb(txManager),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EscalationManagerService,
        {
          provide: getRepositoryToken(AlertIncident),
          useValue: {
            findOne: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: EscalationPolicyService,
          useValue: {
            findMatchingPolicy: jest.fn(),
            getPolicy: jest.fn(),
          },
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
        { provide: DataSource, useValue: mockDataSource },
        { provide: OutboxPublisher, useValue: outbox },
        { provide: AlertAuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    service = module.get<EscalationManagerService>(EscalationManagerService);
    incidentRepository = module.get(getRepositoryToken(AlertIncident));
    policyService = module.get(EscalationPolicyService);
    eventEmitter = module.get(EventEmitter2);
    redisService = module.get(RedisService);

    // Default mocks
    policyService.findMatchingPolicy.mockResolvedValue(mockPolicy as EscalationPolicy);
    policyService.getPolicy.mockResolvedValue(mockPolicy as EscalationPolicy);
    incidentRepository.findOne.mockResolvedValue(mockIncident as AlertIncident);
    incidentRepository.save.mockImplementation(async (i) => i as AlertIncident);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('startEscalation', () => {
    it('claims level 1, pages and keeps the ladder state', async () => {
      // SCENARIO: a HIGH incident matching the policy.
      // EXPECTS: 'escalated', one AlertEscalated, an active level-1 ladder in Redis.
      const outcome = await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      expect(outcome).toBe('escalated');
      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
      const state = await service.getEscalationState('incident-1');
      expect(state).toMatchObject({ incidentId: 'incident-1', currentLevel: 1, isComplete: false });
    });

    it('pages nobody twice when a concurrent delivery already claimed level 1', async () => {
      // SCENARIO: the conditional UPDATE claims no row (another delivery won).
      // EXPECTS: 'already-claimed' and NO AlertEscalated from this caller.
      claim['execute']!.mockResolvedValue({ affected: 0, raw: [] });

      const outcome = await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      expect(outcome).toBe('already-claimed');
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('uses the tenant-admin hard floor for a HIGH incident no policy covers', async () => {
      // SCENARIO: no policy matches a HIGH incident (V-S1a-2c).
      // EXPECTS: escalated to TENANT_ADMIN tenant-wide by push + e-mail.
      policyService.findMatchingPolicy.mockResolvedValue(null);

      const outcome = await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      expect(outcome).toBe('escalated');
      const [event] = outbox.enqueue.mock.calls[0] as [Record<string, unknown>];
      expect(event).toMatchObject({
        tenantWideRecipientRoles: ['TENANT_ADMIN'],
        channels: ['push', 'email'],
      });
    });

    it('is not covered when no policy matches a WARNING incident', async () => {
      policyService.findMatchingPolicy.mockResolvedValue(null);

      const outcome = await service.startEscalation(mockIncident as AlertIncident, {
        severity: AlertSeverity.WARNING,
      });

      expect(outcome).toBe('not-covered');
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('returns suppressed and emits the suppressed event when a window silences the policy', async () => {
      const suppressedPolicy: Partial<EscalationPolicy> = {
        ...mockPolicy,
        suppresses: jest.fn().mockReturnValue(true),
      };
      policyService.findMatchingPolicy.mockResolvedValue(suppressedPolicy as EscalationPolicy);

      const outcome = await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      expect(outcome).toBe('suppressed');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        ESCALATION_EVENTS.SUPPRESSED,
        expect.any(Object),
      );
    });

    it('should set escalation timeout', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      // Verify timer was set by checking if escalation happens after timeout
      expect(await service.isEscalating('incident-1')).toBe(true);
    });

    it('should emit escalated event', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        ESCALATION_EVENTS.ESCALATED,
        expect.objectContaining({
          incidentId: 'incident-1',
          level: 1,
        }),
      );
    });
  });

  describe('executeEscalationLevel', () => {
    it('should execute escalation for specified level', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      const result = await service.executeEscalationLevel(
        mockIncident as AlertIncident,
        mockPolicy as EscalationPolicy,
        1,
        0,
      );

      expect(result.success).toBe(true);
      expect(result.toLevel).toBe(1);
    });

    it('should fail for non-existent level', async () => {
      const result = await service.executeEscalationLevel(
        mockIncident as AlertIncident,
        mockPolicy as EscalationPolicy,
        99,
        98,
      );

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('should update incident escalation level', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      await service.executeEscalationLevel(
        mockIncident as AlertIncident,
        mockPolicy as EscalationPolicy,
        1,
        0,
      );

      // V-S1a-4: the level is CLAIMED by a conditional UPDATE on the
      // transaction manager (atomic with the outbox enqueue), never a
      // full-entity save of a stale read.
      expect(txManager.createQueryBuilder).toHaveBeenCalled();
      expect(claim['andWhere']).toHaveBeenCalledWith('escalation_level = :fromLevel', {
        fromLevel: 0,
      });
      expect(claim['execute']).toHaveBeenCalled();
    });

    it('should include correct target users', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      await service.executeEscalationLevel(
        mockIncident as AlertIncident,
        mockPolicy as EscalationPolicy,
        1,
        0,
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        ESCALATION_EVENTS.ESCALATED,
        expect.objectContaining({
          action: expect.objectContaining({ targetUsers: expect.arrayContaining(['user-1']) }),
        }),
      );
    });
  });

  describe('AlertEscalated — transactional outbox (ALERT-CRITICAL-001)', () => {
    it('enqueues AlertEscalated on the transaction manager (not an event bus)', async () => {
      await service.executeEscalationLevel(
        mockIncident as AlertIncident,
        mockPolicy as EscalationPolicy,
        1,
        0,
      );

      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
      const [, passedManager] = outbox.enqueue.mock.calls[0] as [
        BaseEvent,
        EntityManager,
      ];
      // Enqueued on the SAME manager the escalation-level claim used.
      expect(passedManager).toBe(txManager);
      expect(claim['execute']).toHaveBeenCalled();
    });

    it('builds the AlertEscalated event with its contract fields', async () => {
      await service.executeEscalationLevel(
        mockIncident as AlertIncident,
        mockPolicy as EscalationPolicy,
        1,
        0,
      );

      const [event] = outbox.enqueue.mock.calls[0] as [Record<string, unknown>];
      expect(event['eventType']).toBe('AlertEscalated');
      expect(event['alertId']).toBe('incident-1');
      expect(event['escalationLevel']).toBe(1);
      // The fixture's 'user-1' is not a user id: the builder drops it rather than
      // ship an event the delivery boundary would dead-letter.
      expect(event['escalatedTo']).toEqual([]);
      expect(typeof event['reason']).toBe('string');
    });

    it('rolls back the escalation when the outbox enqueue rejects', async () => {
      outbox.enqueue.mockRejectedValueOnce(new Error('NATS outbox down'));
      eventEmitter.emit.mockClear();

      const result = await service.executeEscalationLevel(
        mockIncident as AlertIncident,
        mockPolicy as EscalationPolicy,
        1,
        0,
      );

      // The enqueue failure propagates out of dataSource.transaction → caught
      // by executeEscalationLevel's error collector → reported as a failed
      // result. The local ESCALATED emit must NOT have fired (it runs only
      // after the durable commit).
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        ESCALATION_EVENTS.ESCALATED,
        expect.any(Object),
      );
    });
  });

  describe('escalateToNextLevel', () => {
    it('should escalate to next level', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      const result = await service.escalateToNextLevel('incident-1');

      expect(result).toBeDefined();
      expect(result?.toLevel).toBe(2);
    });

    it('should return null for non-existent escalation', async () => {
      const result = await service.escalateToNextLevel('non-existent');

      expect(result).toBeNull();
    });

    it('should repeat current level when max level reached', async () => {
      // Start at level 2 (max)
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      // Manually set to level 2 via Redis store
      const state = await service.getEscalationState('incident-1');
      if (state) {
        state.currentLevel = 2;
        redisStore.set('escalation:state:incident-1', JSON.stringify(state));
      }

      const result = await service.escalateToNextLevel('incident-1');

      expect(result?.toLevel).toBe(2);
    });

    it('should complete escalation when max repeats reached', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      const state = await service.getEscalationState('incident-1');
      if (state) {
        state.currentLevel = 2;
        state.escalationCount = 3; // Max repeats
        redisStore.set('escalation:state:incident-1', JSON.stringify(state));
      }

      const result = await service.escalateToNextLevel('incident-1');

      expect(result).toBeNull();
      const updatedState = await service.getEscalationState('incident-1');
      expect(updatedState?.isComplete).toBe(true);
    });
  });

  describe('acknowledgeEscalation', () => {
    it('should acknowledge escalation', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      const result = await service.acknowledgeEscalation('incident-1', 'user-1', 'Acknowledged');

      expect(result).toBe(true);
    });

    it('should return false for non-existent escalation', async () => {
      const result = await service.acknowledgeEscalation('non-existent', 'user-1');

      expect(result).toBe(false);
    });

    it('should record acknowledgment', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      await service.acknowledgeEscalation('incident-1', 'user-1', 'Acknowledged');

      const state = await service.getEscalationState('incident-1');
      expect(state?.acknowledgments).toHaveLength(1);
      expect(state?.acknowledgments?.[0]?.userId).toBe('user-1');
    });

    it('should emit acknowledged event', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      await service.acknowledgeEscalation('incident-1', 'user-1');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        ESCALATION_EVENTS.ACKNOWLEDGED,
        expect.objectContaining({
          incidentId: 'incident-1',
          userId: 'user-1',
        }),
      );
    });

    it('should cancel escalation timeout', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      await service.acknowledgeEscalation('incident-1', 'user-1');

      // Advance time past timeout - should not escalate
      jest.advanceTimersByTime(20 * 60 * 1000);

      const state = await service.getEscalationState('incident-1');
      expect(state?.currentLevel).toBe(1); // Should still be at level 1
    });

    it('should update incident status', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      await service.acknowledgeEscalation('incident-1', 'user-1');

      expect(mockIncident.acknowledge).toHaveBeenCalledWith('user-1');
    });
  });

  describe('completeEscalation', () => {
    it('should complete escalation', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      await service.completeEscalation('incident-1', 'resolved');

      const state = await service.getEscalationState('incident-1');
      expect(state?.isComplete).toBe(true);
    });

    it('should emit completed event', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      await service.completeEscalation('incident-1', 'resolved');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        ESCALATION_EVENTS.COMPLETED,
        expect.objectContaining({
          incidentId: 'incident-1',
          reason: 'resolved',
        }),
      );
    });
  });

  describe('getEscalationState', () => {
    it('should return escalation state', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      const state = await service.getEscalationState('incident-1');

      expect(state).toBeDefined();
      expect(state?.incidentId).toBe('incident-1');
    });

    it('should return null for non-existent incident', async () => {
      const state = await service.getEscalationState('non-existent');

      expect(state).toBeNull();
    });
  });

  describe('isEscalating', () => {
    it('should return true for active escalation', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      expect(await service.isEscalating('incident-1')).toBe(true);
    });

    it('should return false for completed escalation', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);
      await service.completeEscalation('incident-1', 'resolved');

      expect(await service.isEscalating('incident-1')).toBe(false);
    });

    it('should return false for non-existent incident', async () => {
      expect(await service.isEscalating('non-existent')).toBe(false);
    });
  });

  describe('isAcknowledged', () => {
    it('should return false for new escalation', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      expect(await service.isAcknowledged('incident-1')).toBe(false);
    });

    it('should return true after acknowledgment', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);
      await service.acknowledgeEscalation('incident-1', 'user-1');

      expect(await service.isAcknowledged('incident-1')).toBe(true);
    });
  });

  describe('pauseEscalation', () => {
    it('should pause escalation', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      const result = await service.pauseEscalation('incident-1');

      expect(result).toBe(true);
    });

    it('should return false for non-existent escalation', async () => {
      const result = await service.pauseEscalation('non-existent');

      expect(result).toBe(false);
    });

    it('should prevent automatic escalation', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      await service.pauseEscalation('incident-1');

      // Advance time past timeout
      jest.advanceTimersByTime(20 * 60 * 1000);

      const state = await service.getEscalationState('incident-1');
      expect(state?.currentLevel).toBe(1); // Should still be at level 1
    });
  });

  describe('resumeEscalation', () => {
    it('should resume paused escalation', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);
      await service.pauseEscalation('incident-1');

      const result = await service.resumeEscalation('incident-1');

      expect(result).toBe(true);
    });

    it('should return false for non-existent escalation', async () => {
      const result = await service.resumeEscalation('non-existent');

      expect(result).toBe(false);
    });
  });

  describe('recordNotification', () => {
    it('should record notification', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      await service.recordNotification('incident-1', {
        userId: 'user-1',
        channel: NotificationChannel.EMAIL,
        level: 1,
        sentAt: new Date(),
      });

      const state = await service.getEscalationState('incident-1');
      expect(state?.notifications).toHaveLength(1);
    });

    it('should not record for non-existent escalation', async () => {
      await service.recordNotification('non-existent', {
        userId: 'user-1',
        channel: NotificationChannel.EMAIL,
        level: 1,
        sentAt: new Date(),
      });

      // Should not throw
      const state = await service.getEscalationState('non-existent');
      expect(state).toBeNull();
    });
  });

  describe('recordNotificationDelivery', () => {
    it('should record successful delivery', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      await service.recordNotification('incident-1', {
        userId: 'user-1',
        channel: NotificationChannel.EMAIL,
        level: 1,
        sentAt: new Date(),
      });

      const state = await service.getEscalationState('incident-1');
      const notificationId = state?.notifications?.[0]?.id;

      await service.recordNotificationDelivery('incident-1', notificationId!, true);

      const updatedState = await service.getEscalationState('incident-1');
      expect(updatedState?.notifications?.[0]?.deliveredAt).toBeDefined();
    });

    it('should record failed delivery', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      await service.recordNotification('incident-1', {
        userId: 'user-1',
        channel: NotificationChannel.EMAIL,
        level: 1,
        sentAt: new Date(),
      });

      const state = await service.getEscalationState('incident-1');
      const notificationId = state?.notifications?.[0]?.id;

      await service.recordNotificationDelivery('incident-1', notificationId!, false, 'SMTP error');

      const updatedState = await service.getEscalationState('incident-1');
      expect(updatedState?.notifications?.[0]?.failedAt).toBeDefined();
      expect(updatedState?.notifications?.[0]?.error).toBe('SMTP error');
    });
  });

  describe('getEscalationMetrics', () => {
    it('should return escalation metrics', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      const metrics = await service.getEscalationMetrics('incident-1');

      expect(metrics).toBeDefined();
      expect(metrics?.['incidentId']).toBe('incident-1');
      expect(metrics?.['currentLevel']).toBe(1);
      expect(metrics?.['notifications']).toBeDefined();
    });

    it('should return null for non-existent incident', async () => {
      const metrics = await service.getEscalationMetrics('non-existent');

      expect(metrics).toBeNull();
    });

    it('should track notification counts', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      await service.recordNotification('incident-1', {
        userId: 'user-1',
        channel: NotificationChannel.EMAIL,
        level: 1,
        sentAt: new Date(),
      });

      const metrics = await service.getEscalationMetrics('incident-1');

      expect((metrics?.['notifications'] as any).total).toBe(1);
    });
  });

  describe('cleanupCompletedEscalations', () => {
    it('should cleanup old completed escalations', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);
      await service.completeEscalation('incident-1', 'resolved');

      // Advance time
      jest.advanceTimersByTime(25 * 60 * 60 * 1000); // 25 hours

      const cleaned = await service.cleanupCompletedEscalations();

      expect(cleaned).toBe(1);
      expect(await service.getEscalationState('incident-1')).toBeNull();
    });

    it('should not cleanup recent completed escalations', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);
      await service.completeEscalation('incident-1', 'resolved');

      const cleaned = await service.cleanupCompletedEscalations();

      expect(cleaned).toBe(0);
      expect(await service.getEscalationState('incident-1')).toBeDefined();
    });

    it('should not cleanup active escalations', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      jest.advanceTimersByTime(25 * 60 * 60 * 1000);

      const cleaned = await service.cleanupCompletedEscalations();

      expect(cleaned).toBe(0);
      expect(await service.getEscalationState('incident-1')).toBeDefined();
    });
  });

  describe('getActiveEscalations', () => {
    it('should return active escalations', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      const active = await service.getActiveEscalations();

      expect(active).toHaveLength(1);
    });

    it('should not include completed escalations', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);
      await service.completeEscalation('incident-1', 'resolved');

      const active = await service.getActiveEscalations();

      expect(active).toHaveLength(0);
    });
  });

  describe('getStatistics', () => {
    it('should return escalation statistics', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      const stats = await service.getStatistics();

      expect(stats['total']).toBe(1);
      expect(stats['active']).toBe(1);
      expect(stats['completed']).toBe(0);
    });

    it('should track acknowledged escalations', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);
      await service.acknowledgeEscalation('incident-1', 'user-1');

      const stats = await service.getStatistics();

      expect(stats['acknowledged']).toBe(1);
    });

    it('should track completed escalations', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);
      await service.completeEscalation('incident-1', 'resolved');

      const stats = await service.getStatistics();

      expect(stats['completed']).toBe(1);
      expect(stats['active']).toBe(0);
    });
  });

  describe('timeout handling', () => {
    it('should escalate to next level on timeout', async () => {
      await service.startEscalation(mockIncident as AlertIncident, HIGH_START);

      // Clear previous emit calls
      eventEmitter.emit.mockClear();

      // Advance time past level 1 timeout (15 minutes) and run async timers
      await jest.advanceTimersByTimeAsync(16 * 60 * 1000);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        ESCALATION_EVENTS.TIMEOUT,
        expect.objectContaining({
          incidentId: 'incident-1',
          level: 1,
        }),
      );
    });
  });
});
