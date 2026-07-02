import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, FindManyOptions, FindOptionsWhere } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import {
  AlertEvaluationService,
  SensorReadingData,
} from '../alert-evaluation.service';
import {
  AlertRule,
  AlertOperator,
  AlertSeverity,
} from '../../../database/entities/alert-rule.entity';
import { AlertHistory } from '../../entities/alert-history.entity';
import { AlertIncident } from '../../../database/entities/alert-incident.entity';
import { EscalationManagerService } from '../../../escalation/escalation-manager.service';
import { RedisService } from '@aquaculture/backend-common/redis';
import { createRedisServiceMock } from '../../../__tests__/support/redis-service.mock';
import {
  createAlertRuleQueryBuilderMock,
  AlertRuleQueryBuilderMock,
} from '../../../__tests__/support/alert-rule-query-builder.mock';

/**
 * PE-16 coverage: findApplicableRules()'s Redis rule cache and cross-scope
 * rule filtering (see alert-evaluation.service.ts:110-193).
 *
 * The transactional-outbox spec (alert-evaluation.service.spec.ts) stubs the
 * query builder to always return the same canned rule and Redis.get() to
 * always miss — that can never catch a regression in the actual farm/pond
 * scoping or the cache-hit path, since the stub ignores its inputs. This
 * spec uses the stateful support mocks (createRedisServiceMock,
 * createAlertRuleQueryBuilderMock) that apply real filtering/storage
 * semantics, so a scoping or caching regression actually fails a test here.
 */
const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function createMockManager(): { save: jest.Mock; findOne: jest.Mock } {
  return {
    save: jest.fn().mockImplementation((_entity: unknown, row: unknown) => row),
    findOne: jest.fn().mockResolvedValue(null),
  };
}

/**
 * Rule scoped only to Farm A (farmId set, sensorId/pondId left NULL — i.e.
 * "applies to every sensor/pond within Farm A"). Mirrors the real query's
 * `(rule.sensorId IS NULL OR rule.sensorId = :sensorId)` OR-passthrough:
 * an unset scope field on the rule always matches; a set one must match
 * exactly.
 */
function createFarmARule(): AlertRule {
  const rule = new AlertRule();
  Object.assign(rule, {
    id: 'rule-farm-a',
    name: 'DO Crash — Farm A',
    tenantId: TENANT_ID,
    farmId: 'farm-A',
    pondId: undefined,
    sensorId: undefined,
    isActive: true,
    cooldownMinutes: 0,
    notificationChannels: ['email'],
    recipients: ['operator@example.com'],
    conditions: [
      {
        parameter: 'dissolved_oxygen',
        operator: AlertOperator.LT,
        threshold: 4,
        severity: AlertSeverity.CRITICAL,
      },
    ],
  });
  return rule;
}

const farmARule: AlertRule = createFarmARule();

function readingFor(farmId: string): SensorReadingData {
  return {
    sensorId: 'sensor-1',
    tenantId: TENANT_ID,
    farmId,
    pondId: undefined,
    readings: { dissolved_oxygen: 2 },
    timestamp: new Date('2026-07-02T00:00:00.000Z'),
  };
}

describe('AlertEvaluationService — rule cache + scope isolation (PE-16)', () => {
  let redisMock: ReturnType<typeof createRedisServiceMock>;
  let queryBuilder: AlertRuleQueryBuilderMock;
  let findRules: jest.Mock<Promise<AlertRule[]>, [FindManyOptions<AlertRule>?]>;
  let outbox: { enqueue: jest.Mock };

  async function buildService(): Promise<AlertEvaluationService> {
    redisMock = createRedisServiceMock();

    findRules = jest.fn(async (options?: FindManyOptions<AlertRule>): Promise<AlertRule[]> => {
      const rawWhere = options?.where;
      const where: FindOptionsWhere<AlertRule> | undefined = Array.isArray(rawWhere)
        ? rawWhere[0]
        : rawWhere;

      return [farmARule].filter((rule) => {
        if (where?.tenantId !== undefined && rule.tenantId !== where.tenantId) return false;
        if (where?.farmId !== undefined && rule.farmId !== undefined && rule.farmId !== where.farmId) return false;
        if (where?.pondId !== undefined && rule.pondId !== undefined && rule.pondId !== where.pondId) return false;
        if (where?.sensorId !== undefined && rule.sensorId !== undefined && rule.sensorId !== where.sensorId) return false;
        return true;
      });
    });
    queryBuilder = createAlertRuleQueryBuilderMock(findRules);

    outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlertEvaluationService,
        {
          provide: getRepositoryToken(AlertRule),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) },
        },
        {
          provide: getRepositoryToken(AlertHistory),
          useValue: {
            create: jest.fn().mockImplementation((row: Partial<AlertHistory>) => ({
              ...row,
              id: 'history-1',
            })),
          },
        },
        {
          provide: getRepositoryToken(AlertIncident),
          useValue: {
            create: jest.fn().mockImplementation((row: Partial<AlertIncident>) => ({
              ...row,
              id: 'incident-1',
              addTimelineEvent: jest.fn(),
              recordOccurrence: jest.fn(),
            })),
            find: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: (cb: (m: ReturnType<typeof createMockManager>) => Promise<unknown>) =>
              cb(createMockManager()),
          },
        },
        { provide: OutboxPublisher, useValue: outbox },
        { provide: RedisService, useValue: redisMock },
        { provide: EscalationManagerService, useValue: { startEscalation: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();

    return module.get<AlertEvaluationService>(AlertEvaluationService);
  }

  it('does not match a rule scoped to a different farm (no cross-scope leakage)', async () => {
    const service = await buildService();

    await service.evaluateSensorReading(readingFor('farm-B'));

    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('matches a rule correctly scoped to the reading farm', async () => {
    const service = await buildService();

    await service.evaluateSensorReading(readingFor('farm-A'));

    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
  });

  it('serves the second evaluation from the Redis cache without re-querying the DB', async () => {
    const service = await buildService();

    await service.evaluateSensorReading(readingFor('farm-A'));
    await service.evaluateSensorReading(readingFor('farm-A'));

    expect(findRules).toHaveBeenCalledTimes(1);
    expect(redisMock.store.size).toBe(1);
  });

  it('invalidateRuleCache() forces the next evaluation to re-query the DB', async () => {
    const service = await buildService();

    await service.evaluateSensorReading(readingFor('farm-A'));
    await service.evaluateSensorReading(readingFor('farm-A'));
    expect(findRules).toHaveBeenCalledTimes(1);

    await service.invalidateRuleCache(TENANT_ID);
    await service.evaluateSensorReading(readingFor('farm-A'));

    expect(findRules).toHaveBeenCalledTimes(2);
  });
});
