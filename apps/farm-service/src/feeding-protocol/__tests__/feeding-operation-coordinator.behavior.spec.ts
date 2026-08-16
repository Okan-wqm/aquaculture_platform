import { getDataSourceToken } from '@nestjs/typeorm';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  FEEDING_JOB_CATALOG_DIGEST,
  compileFeedingResultArtifactV1,
  type FeedingOperationEnvelopeArtifactV1,
} from '@aquaculture/feeding-contracts';

import {
  FEEDING_OPERATION_COMMAND_PORT,
  type FeedingOperationCommandPort,
} from '../feeding-operation-command.port';
import { FEEDING_OPERATION_HANDLER_ADAPTER } from '../feeding-operation-handler.adapter';
import { readFeedingOperationSession } from '../feeding-operation-session';
import { FEEDING_OPERATION_PRIVATE_PROVIDERS } from '../services/feeding-operation-coordinator.service';
import { FeedingTimezoneAuthorityService } from '../services/feeding-timezone-authority.service';
import {
  createScheduledSiteFeedingOperationTestCommand,
  FEEDING_PROTOCOL_TEST_TIMEZONES,
} from '../../__tests__/support/feeding-protocol-test-authority';

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  pinTenantMutationInstantV1: jest.fn(),
  readTenantMutationInstantV1: jest.fn(async () => Object.freeze({})),
  mutationInstantDateV1: jest.fn(() => new Date('2026-08-08T12:30:00.000Z')),
  runInTenantTransaction: jest.fn(
    async (
      _dataSource: unknown,
      _schema: string,
      _tenantId: string,
      callback: (queryRunner: unknown) => Promise<unknown>,
    ) => callback(globalThis.__feedingCoordinatorQueryRunner),
  ),
}));

declare global {
  var __feedingCoordinatorQueryRunner: {
    manager: Record<string, never>;
    query: jest.Mock;
  };
}

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const OBSERVED_AT = new Date('2026-08-08T12:30:00.000Z');
const VOID_PAYLOAD = '{}';

function lease(
  disposition: 'execute' | 'replay' | 'leased',
  index: number,
  resultPayload: string | null = disposition === 'replay' ? VOID_PAYLOAD : null,
  replayResultSchema = 'feeding-operation-result/v2.meal-window.sweep/v1',
) {
  const resultSchema = disposition === 'replay' ? replayResultSchema : null;
  return {
    disposition,
    operationId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    leaseToken:
      disposition === 'execute'
        ? `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`
        : null,
    generation: '4',
    attempt: 1,
    leaseExpiresAt: new Date('2026-08-08T13:00:00.000Z'),
    resultSchema,
    resultPayload,
    resultDigest:
      resultPayload === null || resultSchema === null
        ? null
        : compileFeedingResultArtifactV1(resultSchema, JSON.parse(resultPayload) as unknown).digest,
  };
}

interface Harness {
  readonly module: TestingModule;
  readonly port: FeedingOperationCommandPort;
  readonly query: jest.Mock;
  readonly execute: jest.Mock;
  readonly decode: jest.Mock;
}

async function createHarness(claims: readonly ReturnType<typeof lease>[]): Promise<Harness> {
  const pendingClaims = [...claims];
  const query = jest.fn(async (sql: string, parameters?: unknown[]) => {
    if (sql.includes('farm.claim_feeding_job')) {
      const claimed = pendingClaims.shift();
      if (!claimed) return [];
      const intent = JSON.parse(String(parameters?.[15])) as Record<string, unknown>;
      const persistedGeneration =
        typeof intent.authorityGeneration === 'number'
          ? intent.authorityGeneration
          : Number(claimed.generation);
      return [
        {
          ...claimed,
          generation: String(persistedGeneration),
          intent: {
            ...intent,
            operationId: claimed.operationId,
            generation: persistedGeneration,
          },
        },
      ];
    }
    if (sql.includes('farm.complete_feeding_job')) return [{ accepted: true }];
    if (sql.includes('farm.fail_feeding_job')) return [{ accepted: true }];
    throw new Error(`Unexpected coordinator SQL: ${sql}`);
  });
  globalThis.__feedingCoordinatorQueryRunner = { manager: {}, query };
  const execute = jest.fn(async () => undefined);
  const decode = jest.fn(() => undefined);
  const module = await Test.createTestingModule({
    providers: [
      ...FEEDING_OPERATION_PRIVATE_PROVIDERS,
      { provide: getDataSourceToken(), useValue: {} },
      {
        provide: FeedingTimezoneAuthorityService,
        useValue: {
          resolveTarget: jest.fn(async () => ({
            timezone: FEEDING_PROTOCOL_TEST_TIMEZONES.UTC,
            source: 'tenant_site_catalog',
            siteId: SITE_ID,
            unitId: null,
          })),
        },
      },
      {
        provide: FEEDING_OPERATION_HANDLER_ADAPTER,
        useValue: {
          execute,
          encode: jest.fn((jobId: string) => ({
            schema: `feeding-operation-result/${jobId}/v1`,
            payload: {},
          })),
          decode,
        },
      },
    ],
  }).compile();
  return {
    module,
    port: module.get<FeedingOperationCommandPort>(FEEDING_OPERATION_COMMAND_PORT),
    query,
    execute,
    decode,
  };
}

function scheduledCommand(scheduleKey = '2026-08-08T12:15:00.000Z') {
  const occurrenceIndex = scheduleKey === '2026-08-08T12:00:00.000Z' ? 0 : 1;
  const command = createScheduledSiteFeedingOperationTestCommand({
    jobId: 'v2.meal-window.sweep' as const,
    tenantId: TENANT_ID,
    siteId: SITE_ID,
    observedAt: OBSERVED_AT,
    timezone: FEEDING_PROTOCOL_TEST_TIMEZONES.UTC,
    occurrenceIndex,
  });
  if (command.occurrence.scheduleKey !== scheduleKey) {
    throw new Error(`Test schedule key ${scheduleKey} is outside the catalogued cut`);
  }
  return command;
}

describe('feeding operation coordinator behavior through its sole public port', () => {
  it('executes only the exact admitted catch-up occurrence instead of scanning adjacent slots', async () => {
    const harness = await createHarness([lease('execute', 3)]);
    try {
      await expect(harness.port.reconcileScheduled(scheduledCommand())).resolves.toEqual({
        status: 'executed',
        operationId: lease('execute', 3).operationId,
      });
      const claimCalls = harness.query.mock.calls.filter(([sql]) =>
        String(sql).includes('farm.claim_feeding_job'),
      );
      expect(claimCalls).toHaveLength(1);
      expect(claimCalls[0]?.[1][2]).toBe('2026-08-08T12:15:00.000Z');
      expect(harness.execute).toHaveBeenCalledTimes(1);
    } finally {
      await harness.module.close();
    }
  });

  it('does not overtake an active lease for the exact admitted occurrence', async () => {
    const harness = await createHarness([lease('leased', 2)]);
    try {
      await expect(harness.port.reconcileScheduled(scheduledCommand())).resolves.toEqual({
        status: 'leased',
        operationId: lease('leased', 2).operationId,
      });
      const claimCalls = harness.query.mock.calls.filter(([sql]) =>
        String(sql).includes('farm.claim_feeding_job'),
      );
      expect(claimCalls).toHaveLength(1);
      expect(harness.execute).not.toHaveBeenCalled();
    } finally {
      await harness.module.close();
    }
  });

  it('binds reordered multi-catch-up dispatches to their own schedule keys', async () => {
    const harness = await createHarness([lease('execute', 2), lease('execute', 1)]);
    try {
      await harness.port.reconcileScheduled(scheduledCommand('2026-08-08T12:15:00.000Z'));
      await harness.port.reconcileScheduled(scheduledCommand('2026-08-08T12:00:00.000Z'));
      const claimCalls = harness.query.mock.calls.filter(([sql]) =>
        String(sql).includes('farm.claim_feeding_job'),
      );
      expect(claimCalls.map((call) => call[1][2])).toEqual([
        '2026-08-08T12:15:00.000Z',
        '2026-08-08T12:00:00.000Z',
      ]);
    } finally {
      await harness.module.close();
    }
  });

  it('reuses one immutable operation envelope and cut clock across a full transaction retry', async () => {
    const harness = await createHarness([lease('execute', 11)]);
    const envelopes: FeedingOperationEnvelopeArtifactV1[] = [];
    const commands: unknown[] = [];
    harness.execute.mockImplementation(async (session, command) => {
      const verified = readFeedingOperationSession(session);
      envelopes.push(verified.operationEnvelope);
      commands.push(command);
      if (envelopes.length === 1) {
        throw Object.assign(new Error('serialization retry'), { code: '40001' });
      }
      return undefined;
    });
    try {
      await expect(harness.port.reconcileScheduled(scheduledCommand())).resolves.toEqual({
        status: 'executed',
        operationId: lease('execute', 11).operationId,
      });
      expect(envelopes).toHaveLength(2);
      expect(envelopes[1]).toBe(envelopes[0]);
      expect(commands).toHaveLength(2);
      expect(commands[1]).not.toBe(commands[0]);
      expect(commands.every((command) => Object.isFrozen(command))).toBe(true);
      const artifact = envelopes[0];
      if (!artifact) throw new Error('Retry did not expose an operation envelope');
      expect(Object.isFrozen(artifact)).toBe(true);
      expect(Object.isFrozen(artifact.envelope)).toBe(true);
      expect(artifact.envelope).toMatchObject({
        schemaVersion: 'feeding-operation-envelope/v1',
        observedAt: OBSERVED_AT.toISOString(),
        catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
        authorityGeneration: 1,
        commandDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        lockSetDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });

      const claimCall = harness.query.mock.calls.find(([sql]) =>
        String(sql).includes('farm.claim_feeding_job'),
      );
      const completeCall = harness.query.mock.calls.find(([sql]) =>
        String(sql).includes('farm.complete_feeding_job'),
      );
      const intentEvidence = JSON.parse(String(claimCall?.[1]?.[15])) as Record<string, unknown>;
      const completionEvidence = JSON.parse(String(completeCall?.[1]?.[7])) as Record<
        string,
        unknown
      >;
      expect(intentEvidence).toMatchObject({
        observedAt: artifact.envelope.observedAt,
        catalogDigest: artifact.envelope.catalogDigest,
        commandDigest: artifact.envelope.commandDigest,
        lockSetDigest: artifact.envelope.lockSetDigest,
      });
      expect(completionEvidence.operationEnvelopeDigest).toBe(artifact.digest);
      expect(
        harness.query.mock.calls.filter(([sql]) => String(sql).includes('fail_feeding_job')),
      ).toHaveLength(0);
    } finally {
      await harness.module.close();
    }
  });

  it('returns the typed on-demand replay without invoking a bounded executor', async () => {
    const payload = '{"refreshedCount":7}';
    const replay = lease('replay', 8, payload, 'feeding-operation-result/v2.forecast.refresh/v1');
    const harness = await createHarness([replay]);
    harness.decode.mockReturnValue(7);
    try {
      await expect(
        harness.port.refreshForecast({
          tenantId: TENANT_ID,
          siteId: SITE_ID,
          actorId: 'operator-1',
          requestId: 'forecast-request-1',
          emitCoverageEvents: true,
        }),
      ).resolves.toBe(7);
      expect(harness.decode).toHaveBeenCalledWith(
        'v2.forecast.refresh',
        'feeding-operation-result/v2.forecast.refresh/v1',
        { refreshedCount: 7 },
      );
      expect(harness.execute).not.toHaveBeenCalled();
    } finally {
      await harness.module.close();
    }
  });

  it('executes the persisted decoded snapshot when the caller mutates after claim admission', async () => {
    const harness = await createHarness([lease('execute', 12)]);
    const command = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      actorId: 'operator-1',
      requestId: 'forecast-mutation-boundary-1',
      emitCoverageEvents: true,
    };
    const baseQuery = harness.query.getMockImplementation();
    harness.query.mockImplementation(async (sql: string, parameters?: unknown[]) => {
      if (!baseQuery) throw new Error('missing base query implementation');
      const result = await baseQuery(sql, parameters);
      if (sql.includes('farm.claim_feeding_job')) command.emitCoverageEvents = false;
      return result;
    });
    try {
      await expect(harness.port.refreshForecast(command)).resolves.toBeUndefined();
      const executedCommand = harness.execute.mock.calls[0]?.[1];
      expect(command.emitCoverageEvents).toBe(false);
      expect(executedCommand).toMatchObject({
        jobId: 'v2.forecast.refresh',
        requestId: 'forecast-mutation-boundary-1',
        emitCoverageEvents: true,
      });
      expect(executedCommand).not.toBe(command);
      expect(Object.isFrozen(executedCommand)).toBe(true);
    } finally {
      await harness.module.close();
    }
  });

  it('preserves both a non-Error domain failure and a failure-evidence persistence error', async () => {
    const harness = await createHarness([lease('execute', 9)]);
    harness.execute.mockRejectedValue({ code: 'DOMAIN_NON_ERROR' });
    const baseQuery = harness.query.getMockImplementation();
    harness.query.mockImplementation(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes('farm.fail_feeding_job')) throw new Error('failure journal unavailable');
      if (!baseQuery) throw new Error('missing base query implementation');
      return baseQuery(sql, parameters);
    });
    try {
      await expect(
        harness.port.refreshForecast({
          tenantId: TENANT_ID,
          siteId: SITE_ID,
          actorId: 'operator-1',
          requestId: 'forecast-failure-1',
          emitCoverageEvents: false,
        }),
      ).rejects.toMatchObject({
        name: 'AggregateError',
        errors: [
          expect.objectContaining({ name: 'NonErrorFeedingFailure' }),
          expect.objectContaining({ message: 'failure journal unavailable' }),
        ],
      });
    } finally {
      await harness.module.close();
    }
  });

  it('persists only classified failure evidence and never durable raw secrets or SQL', async () => {
    const harness = await createHarness([lease('execute', 10)]);
    const sensitive =
      'password=hunter2 SELECT * FROM tenant_1111111111114111.private_table tenant=secret';
    harness.execute.mockRejectedValue(new Error(sensitive));
    try {
      await expect(
        harness.port.refreshForecast({
          tenantId: TENANT_ID,
          siteId: SITE_ID,
          actorId: 'operator-1',
          requestId: 'forecast-redaction-1',
          emitCoverageEvents: false,
        }),
      ).rejects.toThrow(sensitive);
      const failureCall = harness.query.mock.calls.find(([sql]) =>
        String(sql).includes('farm.fail_feeding_job'),
      );
      expect(failureCall).toBeDefined();
      const evidenceBytes = String(failureCall?.[1]?.[4]);
      expect(evidenceBytes).not.toContain('hunter2');
      expect(evidenceBytes).not.toContain('SELECT');
      expect(evidenceBytes).not.toContain('tenant_1111111111114111');
      expect(JSON.parse(evidenceBytes)).toMatchObject({
        errorCode: 'FEEDING_INTERNAL_FAILED',
        errorClass: 'internal',
        safeMessage: 'The feeding operation failed.',
        errorDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    } finally {
      await harness.module.close();
    }
  });
});
