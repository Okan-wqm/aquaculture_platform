/**
 * Shared test helpers and factory functions for messaging-service tests.
 * London School TDD -- every external dependency gets a typed mock.
 */
import { Channel, ChannelType } from '../channel/entities/channel.entity';
import {
  ChannelMember,
  ChannelMemberRole,
  NotificationPreference,
} from '../channel/entities/channel-member.entity';
import { Message, MessageContentType } from '../message/entities/message.entity';
import { MessageAttachment } from '../message/entities/message-attachment.entity';
import { MessagingOutbox } from '../outbox/messaging-outbox.entity';
import { Repository, EntityManager, SelectQueryBuilder, QueryRunner, ObjectLiteral } from 'typeorm';
import { of } from 'rxjs';

// ---------------------------------------------------------------------------
// UUID helpers
// ---------------------------------------------------------------------------
let uuidCounter = 0;

export function fakeUuid(prefix = '00000000'): string {
  uuidCounter += 1;
  const hex = uuidCounter.toString(16).padStart(24, '0');
  return `${prefix}-${hex.slice(0, 4)}-4000-8000-${hex.slice(4)}`;
}

export function resetUuidCounter(): void {
  uuidCounter = 0;
}

// ---------------------------------------------------------------------------
// Tenant helpers
// ---------------------------------------------------------------------------
export const TENANT_A = 'tenant-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const TENANT_B = 'tenant-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// Entity factories
// ---------------------------------------------------------------------------
export function createMockChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: fakeUuid('ch'),
    tenantId: TENANT_A,
    type: ChannelType.GROUP,
    name: 'General',
    description: null,
    avatarUrl: null,
    createdBy: fakeUuid('usr'),
    isArchived: false,
    aiPersona: null,
    aiServiceUrl: null,
    createdAt: new Date('2026-03-01T00:00:00Z'),
    updatedAt: new Date('2026-03-01T00:00:00Z'),
    dmPairKey: null,
    members: [],
    ...overrides,
  };
}

export function createMockChannelMember(
  overrides: Partial<ChannelMember> = {},
): ChannelMember {
  return {
    id: fakeUuid('cm'),
    tenantId: TENANT_A,
    channelId: fakeUuid('ch'),
    userId: fakeUuid('usr'),
    role: ChannelMemberRole.MEMBER,
    notificationPreference: NotificationPreference.ALL,
    lastReadAt: null,
    joinedAt: new Date('2026-03-01T00:00:00Z'),
    leftAt: null,
    channel: undefined as unknown as Channel,
    ...overrides,
  };
}

export function createMockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: fakeUuid('msg'),
    tenantId: TENANT_A,
    channelId: fakeUuid('ch'),
    senderId: fakeUuid('usr'),
    content: 'Hello world',
    contentType: MessageContentType.TEXT,
    parentId: null,
    forwardedFrom: null,
    idempotencyKey: fakeUuid('idem'),
    isDeleted: false,
    updatedBy: null,
    isAiGenerated: false,
    createdAt: new Date('2026-03-10T12:00:00Z'),
    editedAt: null,
    metadata: null,
    attachments: [],
    receipts: [],
    reactions: [],
    ...overrides,
  };
}

export function createMockAttachment(
  overrides: Partial<MessageAttachment> = {},
): MessageAttachment {
  return {
    id: fakeUuid('att'),
    tenantId: TENANT_A,
    messageId: fakeUuid('msg'),
    messageCreatedAt: new Date('2026-03-10T12:00:00Z'),
    storageKey: 'uploads/file.pdf',
    originalFilename: 'report.pdf',
    mimeType: 'application/pdf',
    fileSize: 1024,
    width: null,
    height: null,
    durationSeconds: null,
    thumbnailKey: null,
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date('2026-03-10T12:00:00Z'),
    message: undefined as unknown as Message,
    softDelete(): void {
      // No-op for tests; the real entity method flips isDeleted +
      // deletedAt. Tests that exercise soft-delete behaviour should
      // override this in the spec.
    },
    ...overrides,
  };
}

export function createMockOutboxEvent(
  overrides: Partial<MessagingOutbox> = {},
): MessagingOutbox {
  // payload must conform to IEvent (eventId / eventType / timestamp /
  // optional tenantId), not a free-form bag with channelId. The
  // domain-specific channelId belongs in IEvent.metadata or in a
  // typed extension; tests that assert on channelId should pull it
  // from there. PR-28 of the PROC-MEDIUM-007 ratchet.
  const channelId = fakeUuid('ch');
  return {
    id: '1',
    tenantId: TENANT_A,
    aggregateId: channelId,
    aggregateType: 'Channel',
    eventType: 'ChannelCreated',
    payload: {
      eventId: fakeUuid('evt'),
      eventType: 'ChannelCreated',
      timestamp: new Date('2026-03-10T12:00:00Z').toISOString(),
      tenantId: TENANT_A,
      metadata: { channelId },
    },
    createdAt: new Date('2026-03-10T12:00:00Z'),
    publishedAt: null,
    retryCount: 0,
    lastError: null,
    nextAttemptAt: new Date('2026-03-10T12:00:00Z'),
    isDeadLettered: false,
    deadLetteredAt: null,
    idempotencyKey: null,
    ...overrides,
  } as MessagingOutbox;
}

// ---------------------------------------------------------------------------
// Mock QueryRunner (for transactional handlers that use createQueryRunner)
// ---------------------------------------------------------------------------
export interface MockQueryRunnerManager {
  getRepository: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
  count: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  createQueryBuilder: jest.Mock;
  /**
   * Raw SQL escape hatch — used by handlers that issue advisory locks
   * (`SELECT pg_advisory_xact_lock(...)`) inside the transaction. Defaults
   * to a no-op resolved value so tests that don't care about advisory
   * locks aren't affected.
   */
  query: jest.Mock;
}

export interface MockQueryRunner {
  connect: jest.Mock;
  startTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  rollbackTransaction: jest.Mock;
  isTransactionActive: boolean;
  release: jest.Mock;
  manager: MockQueryRunnerManager;
  query: jest.Mock;
}

export function createMockQueryRunnerManager(): MockQueryRunnerManager {
  const manager: MockQueryRunnerManager = {
    getRepository: jest.fn(),
    create: jest.fn().mockImplementation((_Entity: unknown, data: unknown) => data),
    save: jest.fn().mockImplementation((_Entity: unknown, data: unknown) => Promise.resolve(data)),
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
    query: jest.fn().mockResolvedValue([]),
  };
  manager.getRepository.mockReturnValue({
    create: manager.create,
    save: manager.save,
    findOne: manager.findOne,
    find: manager.find,
    count: manager.count,
    update: manager.update,
    delete: manager.delete,
    createQueryBuilder: manager.createQueryBuilder,
    metadata: {
      findColumnWithPropertyName: jest.fn().mockReturnValue({ databaseName: 'tenantId' }),
    },
  });
  return manager;
}

export function createMockQueryRunner(): MockQueryRunner {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockImplementation(function startTransaction(this: MockQueryRunner) {
      this.isTransactionActive = true;
      return Promise.resolve();
    }),
    commitTransaction: jest.fn().mockImplementation(function commitTransaction(this: MockQueryRunner) {
      this.isTransactionActive = false;
      return Promise.resolve();
    }),
    rollbackTransaction: jest.fn().mockImplementation(function rollbackTransaction(this: MockQueryRunner) {
      this.isTransactionActive = false;
      return Promise.resolve();
    }),
    isTransactionActive: false,
    release: jest.fn().mockResolvedValue(undefined),
    manager: createMockQueryRunnerManager(),
    query: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Mock repository factory
// ---------------------------------------------------------------------------
export type MockRepository<T extends ObjectLiteral> = jest.Mocked<
  Pick<
    Repository<T>,
    | 'findOne'
    | 'find'
    | 'save'
    | 'create'
    | 'update'
    | 'delete'
    | 'count'
    | 'createQueryBuilder'
  >
> & {
  metadata: Pick<Repository<T>['metadata'], 'findColumnWithPropertyName'>;
};

export function createMockRepository<T extends ObjectLiteral>(): MockRepository<T> {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
    metadata: {
      findColumnWithPropertyName: jest.fn().mockReturnValue({
        databaseName: 'tenantId',
      }),
    } as Pick<Repository<T>['metadata'], 'findColumnWithPropertyName'>,
  };
}

// ---------------------------------------------------------------------------
// Mock QueryBuilder
// ---------------------------------------------------------------------------
export function createMockQueryBuilder<T extends ObjectLiteral>(): jest.Mocked<SelectQueryBuilder<T>> {
  const qb: Record<string, jest.Mock> = {};
  const methods = [
    'select', 'addSelect', 'where', 'andWhere', 'orWhere',
    'orderBy', 'addOrderBy', 'skip', 'take', 'limit', 'offset',
    'leftJoinAndSelect', 'innerJoinAndSelect', 'leftJoin', 'innerJoin',
    'getMany', 'getOne', 'getCount', 'getRawMany', 'getRawOne',
    'getManyAndCount', 'setParameter', 'setParameters',
  ];
  for (const method of methods) {
    qb[method] = jest.fn().mockReturnThis();
  }
  return qb as unknown as jest.Mocked<SelectQueryBuilder<T>>;
}

// ---------------------------------------------------------------------------
// Mock Redis (ioredis)
// ---------------------------------------------------------------------------
export interface MockRedis {
  get: jest.Mock;
  set: jest.Mock;
  setex: jest.Mock;
  del: jest.Mock;
  expire: jest.Mock;
  incr: jest.Mock;
  ttl: jest.Mock;
  exists: jest.Mock;
  pipeline: jest.Mock;
  multi: jest.Mock;
  zadd: jest.Mock;
  zcard: jest.Mock;
  zremrangebyscore: jest.Mock;
  connect: jest.Mock;
}

export function createMockRedis(): MockRedis {
  const pipelineExec = jest.fn().mockResolvedValue([]);
  const pipelineMethods: Record<string, jest.Mock> = {
    set: jest.fn().mockReturnThis(),
    get: jest.fn().mockReturnThis(),
    del: jest.fn().mockReturnThis(),
    exists: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: pipelineExec,
    zadd: jest.fn().mockReturnThis(),
    zcard: jest.fn().mockReturnThis(),
    zremrangebyscore: jest.fn().mockReturnThis(),
  };
  const pipeline = jest.fn().mockReturnValue(pipelineMethods);

  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    incr: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(-1),
    exists: jest.fn().mockResolvedValue(0),
    pipeline,
    multi: pipeline, // multi returns same pipeline interface
    zadd: jest.fn().mockResolvedValue(1),
    zcard: jest.fn().mockResolvedValue(0),
    zremrangebyscore: jest.fn().mockResolvedValue(0),
    connect: jest.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Mock NATS ClientProxy
// ---------------------------------------------------------------------------
export interface MockNatsClient {
  emit: jest.Mock;
  send: jest.Mock;
  connect: jest.Mock;
}

export function createMockNatsClient(): MockNatsClient {
  return {
    emit: jest.fn().mockReturnValue(of(undefined)),
    send: jest.fn().mockReturnValue(of(undefined)),
    connect: jest.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Mock DataSource
// ---------------------------------------------------------------------------
export function createMockDataSource(queryRunner: MockQueryRunner) {
  return {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    getRepository: jest.fn(),
    // Connection-level raw query (e.g. tenant-schema enumeration). Defaults to [].
    query: jest.fn().mockResolvedValue([]),
    transaction: jest.fn(
      async (cb: (manager: MockQueryRunnerManager) => Promise<unknown>) =>
        cb(queryRunner.manager),
    ),
  };
}

// ---------------------------------------------------------------------------
// Mock Logger
// ---------------------------------------------------------------------------
export function createMockLogger() {
  return {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Phase 3: AI + Compliance entity factories
// ---------------------------------------------------------------------------
import { MessageAnalysis, AnalysisType } from '../ai/entities/message-analysis.entity';
import type { SentimentResult } from '../ai/entities/message-analysis.entity';
import { RetentionPolicy } from '../compliance/entities/retention-policy.entity';
import { LegalHold } from '../compliance/entities/legal-hold.entity';
import {
  ComplianceAuditLog,
  ComplianceAction,
} from '../compliance/entities/compliance-audit-log.entity';

export function createMockAnalysis(
  overrides: Partial<MessageAnalysis> = {},
): MessageAnalysis {
  const defaultResult: SentimentResult = {
    label: 'POSITIVE',
    score: 0.92,
    confidence: 0.88,
  };
  return {
    id: fakeUuid('anl'),
    tenantId: TENANT_A,
    messageId: fakeUuid('msg'),
    messageCreatedAt: new Date('2026-03-10T12:00:00Z'),
    analysisType: AnalysisType.SENTIMENT,
    result: defaultResult,
    modelVersion: 'distilbert-sst2-v1.0',
    analyzedAt: new Date('2026-03-10T12:01:00Z'),
    message: undefined as unknown as import('../message/entities/message.entity').Message,
    ...overrides,
  };
}

export function createMockRetentionPolicy(
  overrides: Partial<RetentionPolicy> = {},
): RetentionPolicy {
  return {
    id: fakeUuid('rp'),
    tenantId: TENANT_A,
    channelId: null,
    retentionDays: 365,
    createdBy: fakeUuid('usr'),
    createdAt: new Date('2026-03-01T00:00:00Z'),
    updatedAt: new Date('2026-03-01T00:00:00Z'),
    ...overrides,
  };
}

export function createMockLegalHold(
  overrides: Partial<LegalHold> = {},
): LegalHold {
  return {
    id: fakeUuid('lh'),
    tenantId: TENANT_A,
    channelId: null,
    legalMatterId: fakeUuid('lm'),
    legalMatterDescription: null,
    reason: 'Legal investigation',
    requestedBy: null,
    startedBy: fakeUuid('usr'),
    startedAt: new Date('2026-03-01T00:00:00Z'),
    releasedBy: null,
    releasedByApprover: null,
    releaseReason: null,
    releasedAt: null,
    expiresAt: null,
    isActive: true,
    ...overrides,
  };
}

export function createMockAuditEntry(
  overrides: Partial<ComplianceAuditLog> = {},
): ComplianceAuditLog {
  return {
    id: fakeUuid('aud'),
    tenantId: TENANT_A,
    userId: fakeUuid('usr'),
    action: ComplianceAction.MESSAGE_SEND,
    resourceType: 'message',
    resourceId: fakeUuid('msg'),
    details: null,
    ipAddress: '192.168.1.1',
    userAgent: 'Mozilla/5.0',
    createdAt: new Date('2026-03-10T12:00:00Z'),
    ...overrides,
  };
}

// Re-export entity types for convenience in test files
export { AnalysisType, ComplianceAction };
export type { SentimentResult };
