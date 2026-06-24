import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisService } from '@aquaculture/backend-common/redis';
import {
  AcknowledgmentTrackerService,
  AckStatus,
  AckSourceType,
} from '../acknowledgment-tracker.service';

describe('AcknowledgmentTrackerService', () => {
  const TENANT_ID = '11111111-1111-4111-8111-111111111111';
  const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';

  let service: AcknowledgmentTrackerService;
  let eventEmitter: jest.Mocked<EventEmitter2>;
  let redisService: jest.Mocked<RedisService>;

  // In-memory stores to simulate Redis
  const kvStore = new Map<string, string>();
  const setStore = new Map<string, Set<string>>();
  const listStore = new Map<string, string[]>();

  const prefixed = (key: string) => key; // no prefix in tests

  beforeEach(async () => {
    kvStore.clear();
    setStore.clear();
    listStore.clear();

    const mockRedisClient = {
      rpush: jest.fn(async (key: string, value: string) => {
        const list = listStore.get(key) || [];
        list.push(value);
        listStore.set(key, list);
        return list.length;
      }),
      ltrim: jest.fn(async () => 'OK'),
      lrange: jest.fn(async (key: string) => listStore.get(key) || []),
    };

    redisService = {
      set: jest.fn(async (key: string, value: string) => {
        kvStore.set(key, value);
      }),
      get: jest.fn(async (key: string) => kvStore.get(key) ?? null),
      del: jest.fn(async (key: string) => {
        const had = kvStore.has(key) ? 1 : 0;
        kvStore.delete(key);
        return had;
      }),
      setJson: jest.fn(async (key: string, value: unknown) => {
        kvStore.set(key, JSON.stringify(value));
      }),
      getJson: jest.fn(async (key: string) => {
        const raw = kvStore.get(key);
        if (!raw) return null;
        return JSON.parse(raw);
      }),
      hset: jest.fn(async (key: string, field: string, value: string) => {
        const hash = JSON.parse(kvStore.get(key) || '{}');
        hash[field] = value;
        kvStore.set(key, JSON.stringify(hash));
        return 1;
      }),
      hget: jest.fn(async (key: string, field: string) => {
        const hash = JSON.parse(kvStore.get(key) || '{}');
        return hash[field] ?? null;
      }),
      hgetall: jest.fn(async (key: string) => {
        return JSON.parse(kvStore.get(key) || '{}');
      }),
      rpush: jest.fn(async (key: string, value: string) => {
        const list = listStore.get(key) || [];
        list.push(value);
        listStore.set(key, list);
        return list.length;
      }),
      ltrim: jest.fn(async () => 'OK'),
      lrange: jest.fn(async (key: string) => listStore.get(key) || []),
      sadd: jest.fn(async (key: string, ...members: string[]) => {
        const s = setStore.get(key) || new Set();
        let added = 0;
        for (const m of members) {
          if (!s.has(m)) added++;
          s.add(m);
        }
        setStore.set(key, s);
        return added;
      }),
      srem: jest.fn(async (key: string, ...members: string[]) => {
        const s = setStore.get(key);
        if (!s) return 0;
        let removed = 0;
        for (const m of members) {
          if (s.delete(m)) removed++;
        }
        return removed;
      }),
      smembers: jest.fn(async (key: string) => {
        const s = setStore.get(key);
        return s ? Array.from(s) : [];
      }),
      keys: jest.fn(async (pattern: string) => {
        const prefix = pattern.replace('*', '');
        return Array.from(kvStore.keys()).filter((k) => k.startsWith(prefix));
      }),
      getClient: jest.fn(() => mockRedisClient),
    } as unknown as jest.Mocked<RedisService>;

    eventEmitter = {
      emit: jest.fn(),
    } as unknown as jest.Mocked<EventEmitter2>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AcknowledgmentTrackerService,
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    service = module.get<AcknowledgmentTrackerService>(AcknowledgmentTrackerService);
    // Don't call onModuleInit to avoid interval in tests
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('createRecord', () => {
    it('should create a new acknowledgment record in Redis', async () => {
      const record = await service.createRecord(TENANT_ID, 'alert-1', 'incident-1');

      expect(record.alertId).toBe('alert-1');
      expect(record.incidentId).toBe('incident-1');
      expect(record.status).toBe(AckStatus.PENDING);
      expect(record.id).toMatch(/^ack_/);
      expect(record.escalationLevel).toBe(0);
      expect(record.timeoutCount).toBe(0);
      expect(record.history).toHaveLength(1);
      expect(record.history[0]!.action).toBe('created');

      // Verify Redis was called
      expect(redisService.setJson).toHaveBeenCalled();
      expect(redisService.set).toHaveBeenCalled(); // alert mapping
      expect(redisService.sadd).toHaveBeenCalled(); // pending set
    });

    it('should reject non-UUID tenant IDs before writing Redis state', async () => {
      await expect(service.createRecord('tenant-1', 'alert-1')).rejects.toThrow(
        'Invalid tenantId for acknowledgment Redis key',
      );

      expect(redisService.sadd).not.toHaveBeenCalled();
      expect(redisService.setJson).not.toHaveBeenCalled();
      expect(redisService.set).not.toHaveBeenCalled();
    });

    it('should fail closed when the record cannot be persisted', async () => {
      redisService.setJson.mockRejectedValueOnce(new Error('Redis down'));

      await expect(service.createRecord(TENANT_ID, 'alert-1')).rejects.toThrow('Redis down');

      expect(redisService.set).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalledWith('ack.created', expect.anything());
    });

    it('should emit ack.created event', async () => {
      const record = await service.createRecord(TENANT_ID, 'alert-2');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'ack.created',
        expect.objectContaining({
          recordId: record.id,
          alertId: 'alert-2',
        }),
      );
    });
  });

  describe('acknowledge', () => {
    it('should acknowledge a pending alert', async () => {
      const created = await service.createRecord(TENANT_ID, 'alert-1');

      const acked = await service.acknowledge(TENANT_ID, 'alert-1', {
        userId: 'user-1',
        message: 'Acknowledged',
      });

      expect(acked.status).toBe(AckStatus.ACKNOWLEDGED);
      expect(acked.acknowledgedBy).toBe('user-1');
      expect(acked.acknowledgedAt).toBeInstanceOf(Date);
      expect(acked.message).toBe('Acknowledged');
    });

    it('should throw when alert has no ack record', async () => {
      await expect(
        service.acknowledge(TENANT_ID, 'nonexistent', { userId: 'user-1' }),
      ).rejects.toThrow('No acknowledgment record found for alert: nonexistent');
    });

    it('should throw when trying to ack an already acknowledged alert', async () => {
      await service.createRecord(TENANT_ID, 'alert-1');
      await service.acknowledge(TENANT_ID, 'alert-1', { userId: 'user-1' });

      await expect(
        service.acknowledge(TENANT_ID, 'alert-1', { userId: 'user-2' }),
      ).rejects.toThrow('Cannot acknowledge alert in status: ACKNOWLEDGED');
    });

    it('should emit ack.acknowledged event', async () => {
      await service.createRecord(TENANT_ID, 'alert-1');
      await service.acknowledge(TENANT_ID, 'alert-1', { userId: 'user-1' });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'ack.acknowledged',
        expect.objectContaining({
          alertId: 'alert-1',
          acknowledgedBy: 'user-1',
        }),
      );
    });

    it('should remove from pending set when no duration is specified', async () => {
      const created = await service.createRecord(TENANT_ID, 'alert-1');
      await service.acknowledge(TENANT_ID, 'alert-1', { userId: 'user-1' });

      // The pending entry should be removed
      expect(redisService.srem).toHaveBeenCalledWith(
        `ack:tenant:${TENANT_ID}:pending_set`,
        created.id,
      );
    });

    it('should fail closed when pending removal fails', async () => {
      await service.createRecord(TENANT_ID, 'alert-1');
      redisService.srem.mockRejectedValueOnce(new Error('Redis down'));

      await expect(
        service.acknowledge(TENANT_ID, 'alert-1', { userId: 'user-1' }),
      ).rejects.toThrow('Redis down');

      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'ack.acknowledged',
        expect.anything(),
      );
    });
  });

  describe('acknowledgeById', () => {
    it('should acknowledge by record ID', async () => {
      const created = await service.createRecord(TENANT_ID, 'alert-1');
      const acked = await service.acknowledgeById(TENANT_ID, created.id, { userId: 'user-1' });

      expect(acked.status).toBe(AckStatus.ACKNOWLEDGED);
    });

    it('should throw for nonexistent record ID', async () => {
      await expect(
        service.acknowledgeById(TENANT_ID, 'nonexistent', { userId: 'user-1' }),
      ).rejects.toThrow('Acknowledgment record not found: nonexistent');
    });
  });

  describe('resolve', () => {
    it('should resolve an acknowledged alert', async () => {
      await service.createRecord(TENANT_ID, 'alert-1');
      await service.acknowledge(TENANT_ID, 'alert-1', { userId: 'user-1' });

      const resolved = await service.resolve(TENANT_ID, 'alert-1', 'user-1', 'Fixed');

      expect(resolved.status).toBe(AckStatus.RESOLVED);
      expect(resolved.history.some((h) => h.action === 'resolved')).toBe(true);
    });

    it('should emit ack.resolved event', async () => {
      await service.createRecord(TENANT_ID, 'alert-1');
      await service.resolve(TENANT_ID, 'alert-1', 'user-1');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'ack.resolved',
        expect.objectContaining({
          alertId: 'alert-1',
          resolvedBy: 'user-1',
        }),
      );
    });
  });

  describe('getByAlertId / getById', () => {
    it('should return record by alert ID', async () => {
      const created = await service.createRecord(TENANT_ID, 'alert-1');
      const found = await service.getByAlertId(TENANT_ID, 'alert-1');

      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
    });

    it('should return undefined for missing alert', async () => {
      const found = await service.getByAlertId(TENANT_ID, 'nonexistent');
      expect(found).toBeUndefined();
    });

    it('should return record by ID', async () => {
      const created = await service.createRecord(TENANT_ID, 'alert-1');
      const found = await service.getById(TENANT_ID, created.id);

      expect(found).toBeDefined();
      expect(found!.alertId).toBe('alert-1');
    });

    it('should isolate identical alert IDs by tenant', async () => {
      const tenantRecord = await service.createRecord(TENANT_ID, 'shared-alert');
      const otherRecord = await service.createRecord(OTHER_TENANT_ID, 'shared-alert');

      await service.acknowledge(TENANT_ID, 'shared-alert', { userId: 'user-1' });

      const tenantFound = await service.getByAlertId(TENANT_ID, 'shared-alert');
      const otherFound = await service.getByAlertId(OTHER_TENANT_ID, 'shared-alert');

      expect(tenantFound!.id).toBe(tenantRecord.id);
      expect(tenantFound!.status).toBe(AckStatus.ACKNOWLEDGED);
      expect(otherFound!.id).toBe(otherRecord.id);
      expect(otherFound!.status).toBe(AckStatus.PENDING);
    });
  });

  describe('unacknowledge', () => {
    it('should return alert to pending status', async () => {
      await service.createRecord(TENANT_ID, 'alert-1');
      await service.acknowledge(TENANT_ID, 'alert-1', { userId: 'user-1' });

      const unacked = await service.unacknowledge(TENANT_ID, 'alert-1', 'user-2', 'Reopening');

      expect(unacked.status).toBe(AckStatus.PENDING);
      expect(unacked.acknowledgedBy).toBeUndefined();
      expect(unacked.acknowledgedAt).toBeUndefined();
    });

    it('should throw if not in ACKNOWLEDGED status', async () => {
      await service.createRecord(TENANT_ID, 'alert-1');

      await expect(
        service.unacknowledge(TENANT_ID, 'alert-1', 'user-1'),
      ).rejects.toThrow('Cannot unacknowledge alert in status: PENDING');
    });
  });

  describe('manualEscalate', () => {
    it('should escalate an ack record', async () => {
      await service.createRecord(TENANT_ID, 'alert-1');

      const escalated = await service.manualEscalate(TENANT_ID, 'alert-1', 'user-1', 'Needs attention');

      expect(escalated.status).toBe(AckStatus.ESCALATED);
      expect(escalated.escalationLevel).toBe(1);
    });

    it('should emit ack.escalated event with manual flag', async () => {
      await service.createRecord(TENANT_ID, 'alert-1');
      await service.manualEscalate(TENANT_ID, 'alert-1', 'user-1');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'ack.escalated',
        expect.objectContaining({
          alertId: 'alert-1',
          manual: true,
          escalatedBy: 'user-1',
        }),
      );
    });
  });

  describe('deleteRecord', () => {
    it('should delete the record and all related Redis keys', async () => {
      await service.createRecord(TENANT_ID, 'alert-1');
      const result = await service.deleteRecord(TENANT_ID, 'alert-1');

      expect(result).toBe(true);

      const found = await service.getByAlertId(TENANT_ID, 'alert-1');
      expect(found).toBeUndefined();
    });

    it('should return false for nonexistent alert', async () => {
      const result = await service.deleteRecord(TENANT_ID, 'nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('getPendingAcks', () => {
    it('should return all pending/escalated records', async () => {
      await service.createRecord(TENANT_ID, 'alert-1');
      await service.createRecord(TENANT_ID, 'alert-2');
      await service.createRecord(TENANT_ID, 'alert-3');

      // Acknowledge one
      await service.acknowledge(TENANT_ID, 'alert-2', { userId: 'user-1' });

      const pending = await service.getPendingAcks(TENANT_ID);
      expect(pending).toHaveLength(2);
      expect(pending.map((r) => r.alertId).sort()).toEqual(['alert-1', 'alert-3']);
    });
  });

  describe('bulkAcknowledge', () => {
    it('should acknowledge multiple alerts', async () => {
      await service.createRecord(TENANT_ID, 'alert-1');
      await service.createRecord(TENANT_ID, 'alert-2');

      const results = await service.bulkAcknowledge(TENANT_ID, ['alert-1', 'alert-2'], {
        userId: 'user-1',
      });

      expect(results.size).toBe(2);
      for (const [, value] of results) {
        expect(value).not.toBeInstanceOf(Error);
      }
    });

    it('should collect errors for failed acks', async () => {
      await service.createRecord(TENANT_ID, 'alert-1');

      const results = await service.bulkAcknowledge(TENANT_ID, ['alert-1', 'nonexistent'], {
        userId: 'user-1',
      });

      expect(results.get('alert-1')).not.toBeInstanceOf(Error);
      expect(results.get('nonexistent')).toBeInstanceOf(Error);
    });

    it('should reject bulk sizes over 100', async () => {
      const ids = Array.from({ length: 101 }, (_, i) => `alert-${i}`);

      await expect(
        service.bulkAcknowledge(TENANT_ID, ids, { userId: 'user-1' }),
      ).rejects.toThrow('Bulk acknowledge limited to 100 alerts at a time');
    });
  });

  describe('getHistory', () => {
    it('should return history entries for an alert', async () => {
      await service.createRecord(TENANT_ID, 'alert-1');
      await service.acknowledge(TENANT_ID, 'alert-1', { userId: 'user-1' });

      const history = await service.getHistory(TENANT_ID, 'alert-1');

      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history[0]!.action).toBe('created');
      expect(history[1]!.action).toBe('acknowledged');
    });

    it('should return empty array for missing alert', async () => {
      const history = await service.getHistory(TENANT_ID, 'nonexistent');
      expect(history).toEqual([]);
    });
  });

  describe('getStatistics', () => {
    it('should return statistics', async () => {
      await service.createRecord(TENANT_ID, 'alert-1');
      await service.createRecord(TENANT_ID, 'alert-2');
      await service.acknowledge(TENANT_ID, 'alert-1', { userId: 'user-1' });

      const stats = await service.getStatistics(TENANT_ID);

      expect(stats.totalAcks).toBeGreaterThanOrEqual(0);
      expect(typeof stats.pendingAcks).toBe('number');
      expect(typeof stats.averageAckTimeMs).toBe('number');
    });
  });

  describe('configuration', () => {
    it('should update and return configuration', () => {
      service.updateConfig({ maxTimeouts: 5 });
      const config = service.getConfig();

      expect(config.maxTimeouts).toBe(5);
    });
  });

  describe('Redis graceful degradation', () => {
    it('should handle Redis errors gracefully in getByAlertId', async () => {
      redisService.get.mockRejectedValueOnce(new Error('Redis down'));

      const result = await service.getByAlertId(TENANT_ID, 'alert-1');
      expect(result).toBeUndefined();
    });

    it('should handle Redis errors gracefully in deleteRecord', async () => {
      redisService.get.mockRejectedValueOnce(new Error('Redis down'));

      const result = await service.deleteRecord(TENANT_ID, 'alert-1');
      expect(result).toBe(false);
    });
  });
});
