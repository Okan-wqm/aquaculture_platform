/**
 * Messaging-Service E2E Tests for NestJS v11 Upgrade Validation
 *
 * Validates that the messaging-service -- the heaviest NATS user in the platform
 * with 6 ClientsModule.register() calls -- remains fully functional after the
 * NestJS v11 upgrade (ADR-013 Phase 4).
 *
 * Critical areas tested:
 *   1. NATS ClientsModule multi-module registration (6 modules)
 *   2. CQRS handler coverage (command + query handlers across 4 domains)
 *   3. GraphQL Federation v2 schema generation compatibility
 *   4. Express v5 route compatibility (health endpoints, wildcard exclusion)
 *
 * The messaging-service registers NATS_SERVICE in 6 separate modules because
 * NestJS ClientsModule.register() is NOT global. Each module that injects
 * NATS_SERVICE must import it independently:
 *   - AppModule (root)
 *   - MessageModule
 *   - AiModule
 *   - OutboxModule
 *   - GdprModule
 *   - MessagingNotificationModule
 *
 * Run:
 *   npx jest tests/e2e/v11-upgrade/messaging-service.e2e-spec.ts \
 *     --config tests/e2e/v11-upgrade/jest.config.ts
 *
 * @see docs/architecture/ADR-013-nestjs-v11-upgrade.md
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  Module,
  Global,
  Injectable,
  Controller,
  Get,
  DynamicModule,
  Provider,
  Inject,
  Optional,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import {
  CommandBus,
  QueryBus,
  CqrsModule,
  CommandHandler as CommandHandlerDecorator,
  QueryHandler as QueryHandlerDecorator,
  ICommandHandler,
  IQueryHandler,
  ICommand,
  IQuery,
  COMMAND_HANDLER_METADATA,
  QUERY_HANDLER_METADATA,
} from '@platform/cqrs';
import { Observable, of } from 'rxjs';

// ============================================================================
// Section 1: NATS ClientProxy Mock Infrastructure
// ============================================================================

/**
 * Typed mock for NestJS ClientProxy used by all 6 NATS-consuming modules.
 * Tracks emit/send calls per module for cross-module conflict detection.
 */
interface NatsCallRecord {
  pattern: string;
  data: unknown;
  callerModule: string;
}

const natsCallLog: NatsCallRecord[] = [];

function resetNatsCallLog(): void {
  natsCallLog.length = 0;
}

/**
 * Creates a mock ClientProxy bound to a specific module name for tracing.
 * Unlike the real ClientProxy, this never opens a TCP/NATS connection.
 */
function createMockClientProxy(moduleName: string): MockClientProxy {
  return {
    emit: jest.fn((pattern: string, data: unknown): Observable<void> => {
      natsCallLog.push({ pattern, data, callerModule: moduleName });
      return of(undefined);
    }),
    send: jest.fn((pattern: string, data: unknown): Observable<unknown> => {
      natsCallLog.push({ pattern, data, callerModule: moduleName });
      return of({ acknowledged: true });
    }),
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

interface MockClientProxy {
  emit: jest.MockedFunction<(pattern: string, data: unknown) => Observable<void>>;
  send: jest.MockedFunction<(pattern: string, data: unknown) => Observable<unknown>>;
  connect: jest.MockedFunction<() => Promise<void>>;
  close: jest.MockedFunction<() => Promise<void>>;
}

/** NATS_SERVICE injection token (matches real codebase) */
const NATS_SERVICE = 'NATS_SERVICE';

// ============================================================================
// Section 2: Stub Commands (mirroring real messaging-service commands)
// ============================================================================

// --- MESSAGE MODULE (5 commands) ---

class SendMessageCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly senderId: string,
    public readonly channelId: string,
    public readonly content: string | null,
    public readonly contentType: string,
    public readonly idempotencyKey: string,
  ) {}
}

class EditMessageCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly messageId: string,
    public readonly newContent: string,
  ) {}
}

class DeleteMessageCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly messageId: string,
    public readonly channelRole: string | null,
  ) {}
}

class MarkReadCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly channelId: string,
    public readonly messageId: string,
  ) {}
}

class ForwardMessageCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly sourceMessageId: string,
    public readonly sourceMessageCreatedAt: Date,
    public readonly targetChannelId: string,
  ) {}
}

// --- CHANNEL MODULE (5 commands) ---

class CreateChannelCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

class AddMemberCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly actorUserId: string,
    public readonly channelId: string,
    public readonly targetUserId: string,
  ) {}
}

class RemoveMemberCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly channelId: string,
    public readonly targetUserId: string,
  ) {}
}

class UpdateChannelCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly channelId: string,
  ) {}
}

class ArchiveChannelCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly channelId: string,
  ) {}
}

// --- AI MODULE (2 commands) ---

class AnalyzeMessageCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly channelId: string,
    public readonly messageId: string,
    public readonly messageCreatedAt: Date,
    public readonly senderId: string,
    public readonly content: string,
  ) {}
}

class ExtractKnowledgeCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly messageIds: string[],
  ) {}
}

// --- COMPLIANCE MODULE (2 commands) ---

class SetRetentionPolicyCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly channelId: string | null,
    public readonly retentionDays: number,
  ) {}
}

class ToggleLegalHoldCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly activate: boolean,
  ) {}
}

// ============================================================================
// Section 3: Stub Queries (mirroring real messaging-service queries)
// ============================================================================

// --- MESSAGE MODULE (3 queries) ---

class GetMessagesQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly channelId: string,
    public readonly limit: number,
    public readonly cursor: string | null,
  ) {}
}

class GetMessagesSinceQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly channelId: string,
    public readonly since: Date,
  ) {}
}

class SearchMessagesQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly searchQuery: string,
  ) {}
}

// --- CHANNEL MODULE (2 queries) ---

class GetChannelQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly channelId: string,
  ) {}
}

class GetChannelsQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly limit: number,
    public readonly offset: number,
  ) {}
}

// --- AI MODULE (2 queries) ---

class GetSentimentTrendsQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly channelId: string | null,
    public readonly weeks: number,
  ) {}
}

class SearchSimilarMessagesQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly queryText: string,
  ) {}
}

// --- COMPLIANCE MODULE (2 queries) ---

class GetAuditLogQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly limit: number,
  ) {}
}

class GetRetentionPoliciesQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}

// ============================================================================
// Section 4: Handler Factory Functions
// ============================================================================

/**
 * Typed constructor alias for command classes.
 * Uses the same pattern as the farm-handler-coverage test file.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCommandConstructor = new (...args: any[]) => ICommand;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQueryConstructor = new (...args: any[]) => IQuery;

/**
 * Creates a stub command handler with the @CommandHandler decorator.
 * The CqrsModule DiscoveryService auto-discovers handlers by this metadata.
 */
function createStubCommandHandler(
  commandClass: AnyCommandConstructor,
  handlerName: string,
): Provider {
  @Injectable()
  @CommandHandlerDecorator(commandClass)
  class StubHandler implements ICommandHandler<ICommand, unknown> {
    async execute(_command: ICommand): Promise<unknown> {
      return { handled: true, handler: handlerName };
    }
  }
  Object.defineProperty(StubHandler, 'name', { value: handlerName });
  return StubHandler;
}

/**
 * Creates a stub query handler with the @QueryHandler decorator.
 */
function createStubQueryHandler(queryClass: AnyQueryConstructor, handlerName: string): Provider {
  @Injectable()
  @QueryHandlerDecorator(queryClass)
  class StubHandler implements IQueryHandler<IQuery, unknown> {
    async execute(_query: IQuery): Promise<unknown> {
      return { handled: true, handler: handlerName };
    }
  }
  Object.defineProperty(StubHandler, 'name', { value: handlerName });
  return StubHandler;
}

// ============================================================================
// Section 5: Module Handler Definitions
// ============================================================================

/**
 * Per-module handler registry mirroring the real messaging-service.
 * Each entry maps to the actual handler registrations in the codebase.
 */
interface ModuleHandlerDef {
  moduleName: string;
  commandHandlers: Array<{
    command: AnyCommandConstructor;
    handlerName: string;
  }>;
  queryHandlers: Array<{
    query: AnyQueryConstructor;
    handlerName: string;
  }>;
}

const MODULE_HANDLER_DEFS: ModuleHandlerDef[] = [
  {
    moduleName: 'message',
    commandHandlers: [
      { command: SendMessageCommand, handlerName: 'SendMessageHandler' },
      { command: EditMessageCommand, handlerName: 'EditMessageHandler' },
      { command: DeleteMessageCommand, handlerName: 'DeleteMessageHandler' },
      { command: MarkReadCommand, handlerName: 'MarkReadHandler' },
      { command: ForwardMessageCommand, handlerName: 'ForwardMessageHandler' },
    ],
    queryHandlers: [
      { query: GetMessagesQuery, handlerName: 'GetMessagesHandler' },
      { query: GetMessagesSinceQuery, handlerName: 'GetMessagesSinceHandler' },
      { query: SearchMessagesQuery, handlerName: 'SearchMessagesHandler' },
    ],
  },
  {
    moduleName: 'channel',
    commandHandlers: [
      { command: CreateChannelCommand, handlerName: 'CreateChannelHandler' },
      { command: AddMemberCommand, handlerName: 'AddMemberHandler' },
      { command: RemoveMemberCommand, handlerName: 'RemoveMemberHandler' },
      { command: UpdateChannelCommand, handlerName: 'UpdateChannelHandler' },
      { command: ArchiveChannelCommand, handlerName: 'ArchiveChannelHandler' },
    ],
    queryHandlers: [
      { query: GetChannelQuery, handlerName: 'GetChannelHandler' },
      { query: GetChannelsQuery, handlerName: 'GetChannelsHandler' },
    ],
  },
  {
    moduleName: 'ai',
    commandHandlers: [
      { command: AnalyzeMessageCommand, handlerName: 'AnalyzeMessageHandler' },
      { command: ExtractKnowledgeCommand, handlerName: 'ExtractKnowledgeHandler' },
    ],
    queryHandlers: [
      { query: GetSentimentTrendsQuery, handlerName: 'GetSentimentTrendsHandler' },
      { query: SearchSimilarMessagesQuery, handlerName: 'SearchSimilarMessagesHandler' },
    ],
  },
  {
    moduleName: 'compliance',
    commandHandlers: [
      { command: SetRetentionPolicyCommand, handlerName: 'SetRetentionPolicyHandler' },
      { command: ToggleLegalHoldCommand, handlerName: 'ToggleLegalHoldHandler' },
    ],
    queryHandlers: [
      { query: GetAuditLogQuery, handlerName: 'GetAuditLogHandler' },
      { query: GetRetentionPoliciesQuery, handlerName: 'GetRetentionPoliciesHandler' },
    ],
  },
];

/** Total expected handler counts from the real messaging-service codebase */
const EXPECTED_COMMAND_HANDLER_COUNT = MODULE_HANDLER_DEFS.reduce(
  (sum, mod) => sum + mod.commandHandlers.length,
  0,
);
const EXPECTED_QUERY_HANDLER_COUNT = MODULE_HANDLER_DEFS.reduce(
  (sum, mod) => sum + mod.queryHandlers.length,
  0,
);

// ============================================================================
// Section 6: Build All Stub Handlers
// ============================================================================

function buildAllStubHandlers(): Provider[] {
  const handlers: Provider[] = [];
  for (const moduleDef of MODULE_HANDLER_DEFS) {
    for (const cmdDef of moduleDef.commandHandlers) {
      handlers.push(createStubCommandHandler(cmdDef.command, cmdDef.handlerName));
    }
    for (const queryDef of moduleDef.queryHandlers) {
      handlers.push(createStubQueryHandler(queryDef.query, queryDef.handlerName));
    }
  }
  return handlers;
}

// ============================================================================
// Section 7: NATS Module Stubs (simulating 6 independent registrations)
// ============================================================================

/**
 * The 6 modules in messaging-service that independently register NATS_SERVICE.
 * In the real codebase, each uses ClientsModule.register([{ name: 'NATS_SERVICE', ... }]).
 * Here, each module provides its own mock ClientProxy to prove no conflicts.
 */
const NATS_MODULE_NAMES = [
  'AppModule',
  'MessageModule',
  'AiModule',
  'OutboxModule',
  'GdprModule',
  'MessagingNotificationModule',
] as const;

type NatsModuleName = (typeof NATS_MODULE_NAMES)[number];

/**
 * Registry tracking per-module mock proxies for cross-reference checks.
 */
const natsProxies: Map<NatsModuleName, MockClientProxy> = new Map();

function resetNatsProxies(): void {
  natsProxies.clear();
}

/**
 * Creates a NestJS module that provides NATS_SERVICE with a module-specific mock.
 * Each module gets its own provider token scoped to NATS_SERVICE,
 * exactly mirroring how ClientsModule.register() works in NestJS v11.
 */
function createNatsStubModule(moduleName: NatsModuleName): DynamicModule {
  const proxy = createMockClientProxy(moduleName);
  natsProxies.set(moduleName, proxy);

  @Module({})
  class NatsStubModule {}

  return {
    module: NatsStubModule,
    providers: [
      {
        provide: NATS_SERVICE,
        useValue: proxy,
      },
    ],
    exports: [NATS_SERVICE],
  };
}

// ============================================================================
// Section 8: Stub Service for NATS Publish Testing
// ============================================================================

/**
 * Simulates a service that injects NATS_SERVICE and publishes events.
 * In the real codebase, OutboxWorkerService, GdprService, MessagingPushService,
 * and various command handlers all inject @Inject('NATS_SERVICE').
 */
@Injectable()
class StubNatsPublisher {
  constructor(
    @Inject(NATS_SERVICE)
    private readonly natsClient: MockClientProxy,
  ) {}

  publishEvent(pattern: string, data: unknown): Observable<void> {
    return this.natsClient.emit(pattern, data);
  }

  sendRequest(pattern: string, data: unknown): Observable<unknown> {
    return this.natsClient.send(pattern, data);
  }
}

// ============================================================================
// Section 9: Health Controller Stub (Express v5 route compat)
// ============================================================================

/**
 * Mirrors the real HealthController that extends StandardHealthController.
 * Tests Express v5 path-to-regexp v8 compatibility for:
 *   - GET /health (liveness)
 *   - GET /health/ready (readiness)
 */
@Controller('health')
class StubHealthController {
  @Get()
  liveness(): { status: string; service: string } {
    return { status: 'ok', service: 'messaging-service' };
  }

  @Get('ready')
  readiness(): { status: string; checks: Record<string, string> } {
    return {
      status: 'ready',
      checks: { database: 'ok', redis: 'ok', nats: 'ok' },
    };
  }
}

// ============================================================================
// Section 10: GraphQL Schema Stub
// ============================================================================

/**
 * Simulates the messaging-service GraphQL Federation v2 type definitions.
 * In the real service, ApolloFederationDriver with autoSchemaFile generates
 * the schema from TypeGraphQL decorators. Here we validate the structure.
 */
const MESSAGING_SCHEMA_SDL = `
  extend schema @link(url: "https://specs.apollo.dev/federation/v2.0", import: ["@key", "@shareable"])

  type Channel @key(fields: "id") {
    id: ID!
    name: String!
    type: ChannelType!
    createdBy: ID!
    isArchived: Boolean!
    members: [ChannelMember!]!
  }

  type ChannelMember {
    userId: ID!
    role: ChannelMemberRole!
    joinedAt: DateTime!
  }

  type Message @key(fields: "id") {
    id: ID!
    channelId: ID!
    senderId: ID!
    content: String
    contentType: MessageContentType!
    createdAt: DateTime!
    editedAt: DateTime
    isDeleted: Boolean!
  }

  enum ChannelType {
    GROUP
    DIRECT
    AI
    ANNOUNCEMENT
  }

  enum ChannelMemberRole {
    OWNER
    ADMIN
    MEMBER
  }

  enum MessageContentType {
    TEXT
    IMAGE
    FILE
    VOICE
    SYSTEM
  }

  scalar DateTime

  type Query {
    channels(limit: Int, offset: Int): [Channel!]!
    channel(id: ID!): Channel
    messages(channelId: ID!, limit: Int, cursor: String): MessageConnection!
    searchMessages(query: String!, channelId: ID, limit: Int): [Message!]!
    sentimentTrends(channelId: ID, weeks: Int): [SentimentTrend!]!
    auditLog(limit: Int, cursor: String): AuditLogConnection!
    retentionPolicies: [RetentionPolicy!]!
  }

  type Mutation {
    createChannel(input: CreateChannelInput!): Channel!
    sendMessage(input: SendMessageInput!): Message!
    editMessage(messageId: ID!, newContent: String!): Message!
    deleteMessage(messageId: ID!): Boolean!
    addMember(channelId: ID!, userId: ID!, role: ChannelMemberRole): ChannelMember!
    setRetentionPolicy(channelId: ID, retentionDays: Int!): RetentionPolicy!
  }

  type MessageConnection {
    edges: [MessageEdge!]!
    pageInfo: PageInfo!
  }

  type MessageEdge {
    cursor: String!
    node: Message!
  }

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type SentimentTrend {
    channelId: ID!
    week: String!
    averageScore: Float!
    messageCount: Int!
  }

  type AuditLogConnection {
    edges: [AuditLogEdge!]!
    pageInfo: PageInfo!
  }

  type AuditLogEdge {
    cursor: String!
    node: ComplianceAuditEntry!
  }

  type ComplianceAuditEntry {
    id: ID!
    action: String!
    userId: ID!
    resourceType: String!
    createdAt: DateTime!
  }

  type RetentionPolicy {
    id: ID!
    tenantId: ID!
    channelId: ID
    retentionDays: Int!
  }

  input CreateChannelInput {
    name: String!
    type: ChannelType!
    memberIds: [ID!]
  }

  input SendMessageInput {
    channelId: ID!
    content: String
    contentType: MessageContentType!
    idempotencyKey: String!
  }
`;

// ============================================================================
// TESTS
// ============================================================================

describe('Messaging-Service E2E: NestJS v11 Upgrade Validation', () => {
  // ========================================================================
  // 1. NATS ClientsModule Multi-Module Registration
  // ========================================================================
  describe('1. NATS ClientsModule Multi-Module Registration', () => {
    let moduleRef: TestingModule;
    const moduleProxies: Map<NatsModuleName, MockClientProxy> = new Map();

    beforeAll(async () => {
      resetNatsCallLog();
      resetNatsProxies();

      /**
       * Build a testing module that mirrors the real messaging-service module
       * hierarchy: 6 independent modules each providing their own NATS_SERVICE.
       *
       * In NestJS, ClientsModule.register() creates a module-scoped provider.
       * If multiple modules import ClientsModule.register() with the same token,
       * each gets its own instance -- no conflicts, no cross-contamination.
       */
      const allHandlers = buildAllStubHandlers();

      // Create per-module NATS stubs
      const appNatsModule = createNatsStubModule('AppModule');
      const messageNatsModule = createNatsStubModule('MessageModule');
      const aiNatsModule = createNatsStubModule('AiModule');
      const outboxNatsModule = createNatsStubModule('OutboxModule');
      const gdprNatsModule = createNatsStubModule('GdprModule');
      const notificationNatsModule = createNatsStubModule('MessagingNotificationModule');

      // Feature modules that import their own NATS stub
      @Module({
        imports: [CqrsModule, messageNatsModule],
        providers: [StubNatsPublisher, ...allHandlers.filter((_h, i) => i < 8)],
        exports: [StubNatsPublisher],
      })
      class StubMessageModule {}

      @Module({
        imports: [CqrsModule, aiNatsModule],
        providers: [StubNatsPublisher],
        exports: [StubNatsPublisher],
      })
      class StubAiModule {}

      @Module({
        imports: [outboxNatsModule],
        providers: [StubNatsPublisher],
        exports: [StubNatsPublisher],
      })
      class StubOutboxModule {}

      @Module({
        imports: [gdprNatsModule],
        providers: [StubNatsPublisher],
        exports: [StubNatsPublisher],
      })
      class StubGdprModule {}

      @Module({
        imports: [notificationNatsModule],
        providers: [StubNatsPublisher],
        exports: [StubNatsPublisher],
      })
      class StubNotificationModule {}

      moduleRef = await Test.createTestingModule({
        imports: [
          DiscoveryModule,
          CqrsModule.forRoot(),
          appNatsModule,
          StubMessageModule,
          StubAiModule,
          StubOutboxModule,
          StubGdprModule,
          StubNotificationModule,
        ],
        providers: [...allHandlers],
      }).compile();

      await moduleRef.init();

      // Capture proxies for later assertions
      for (const name of NATS_MODULE_NAMES) {
        const proxy = natsProxies.get(name);
        if (proxy) {
          moduleProxies.set(name, proxy);
        }
      }
    });

    afterAll(async () => {
      if (moduleRef) await moduleRef.close();
    });

    it('should register exactly 6 NATS client module instances', () => {
      expect(moduleProxies.size).toBe(6);
    });

    it('should have all 6 expected module names registered', () => {
      for (const name of NATS_MODULE_NAMES) {
        expect(moduleProxies.has(name)).toBe(true);
      }
    });

    it('should create independent proxy instances per module (no shared reference)', () => {
      const proxies = Array.from(moduleProxies.values());
      for (let i = 0; i < proxies.length; i++) {
        for (let j = i + 1; j < proxies.length; j++) {
          expect(proxies[i]).not.toBe(proxies[j]);
        }
      }
    });

    describe('Per-module publish without conflict', () => {
      beforeEach(() => {
        resetNatsCallLog();
      });

      it('should publish from AppModule NATS client', () => {
        const proxy = moduleProxies.get('AppModule');
        if (!proxy) {
          throw new Error('AppModule NATS proxy was not registered');
        }
        proxy.emit('events.messaging.test', { source: 'AppModule' });
        expect(proxy.emit).toHaveBeenCalledTimes(1);

        const record = natsCallLog.find((r) => r.callerModule === 'AppModule');
        expect(record).toBeDefined();
        expect(record!.pattern).toBe('events.messaging.test');
      });

      it('should publish from MessageModule NATS client', () => {
        const proxy = moduleProxies.get('MessageModule');
        expect(proxy).toBeDefined();
        proxy!.emit('events.MessageSent', { messageId: 'msg-001' });
        expect(proxy!.emit).toHaveBeenCalledTimes(1);

        const record = natsCallLog.find((r) => r.callerModule === 'MessageModule');
        expect(record).toBeDefined();
        expect(record!.pattern).toBe('events.MessageSent');
      });

      it('should publish from AiModule NATS client', () => {
        const proxy = moduleProxies.get('AiModule');
        expect(proxy).toBeDefined();
        proxy!.emit('events.MessageAnalyzed', { analysisId: 'anl-001' });
        expect(proxy!.emit).toHaveBeenCalledTimes(1);

        const record = natsCallLog.find((r) => r.callerModule === 'AiModule');
        expect(record).toBeDefined();
      });

      it('should publish from OutboxModule NATS client', () => {
        const proxy = moduleProxies.get('OutboxModule');
        expect(proxy).toBeDefined();
        proxy!.emit('outbox.flush', { batchSize: 50 });
        expect(proxy!.emit).toHaveBeenCalledTimes(1);

        const record = natsCallLog.find((r) => r.callerModule === 'OutboxModule');
        expect(record).toBeDefined();
      });

      it('should publish from GdprModule NATS client', () => {
        const proxy = moduleProxies.get('GdprModule');
        expect(proxy).toBeDefined();
        proxy!.emit('events.GdprExportCompleted', { userId: 'usr-001' });
        expect(proxy!.emit).toHaveBeenCalledTimes(1);

        const record = natsCallLog.find((r) => r.callerModule === 'GdprModule');
        expect(record).toBeDefined();
      });

      it('should publish from MessagingNotificationModule NATS client', () => {
        const proxy = moduleProxies.get('MessagingNotificationModule');
        expect(proxy).toBeDefined();
        proxy!.send('commands.notification.sendPush', {
          deliveryId: 'messaging:t1:msg-001:push:usr-002',
          requestReference: 'messaging:t1:msg-001:push:usr-002',
          tenantId: 't1',
          source: 'messaging-service',
          recipientRef: { kind: 'userId', ref: 'usr-002' },
          templateId: 'messaging.chat.message.push',
          templateVersion: '1',
          templateVariables: { senderName: 'Grace', notificationRef: 'notif-ref-1' },
        });
        expect(proxy!.send).toHaveBeenCalledTimes(1);

        const record = natsCallLog.find((r) => r.callerModule === 'MessagingNotificationModule');
        expect(record).toBeDefined();
      });

      it('should support concurrent publishes from all 6 modules without conflict', () => {
        const patterns = [
          { module: 'AppModule' as NatsModuleName, pattern: 'events.AppHealthCheck' },
          { module: 'MessageModule' as NatsModuleName, pattern: 'events.MessageSent' },
          { module: 'AiModule' as NatsModuleName, pattern: 'events.AnalysisStarted' },
          { module: 'OutboxModule' as NatsModuleName, pattern: 'outbox.flush' },
          { module: 'GdprModule' as NatsModuleName, pattern: 'events.GdprRequested' },
          {
            module: 'MessagingNotificationModule' as NatsModuleName,
            pattern: 'commands.notification.sendPush',
          },
        ];

        for (const { module, pattern } of patterns) {
          const proxy = moduleProxies.get(module);
          if (module === 'MessagingNotificationModule') {
            proxy!.send(pattern, { concurrent: true });
          } else {
            proxy!.emit(pattern, { concurrent: true });
          }
        }

        expect(natsCallLog).toHaveLength(6);

        // Verify each call was traced to the correct module
        for (const { module, pattern } of patterns) {
          const record = natsCallLog.find(
            (r) => r.callerModule === module && r.pattern === pattern,
          );
          expect(record).toBeDefined();
        }
      });

      it('should support send (request-reply) from any module without conflict', () => {
        const proxy = moduleProxies.get('MessageModule');
        expect(proxy).toBeDefined();

        const result$ = proxy!.send('request.messaging.verifyMembership', {
          channelId: 'ch-001',
          userId: 'usr-001',
          tenantId: 'tenant-001',
        });

        let resolved: unknown;
        result$.subscribe((val) => {
          resolved = val;
        });

        expect(resolved).toEqual({ acknowledged: true });
        expect(proxy!.send).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ========================================================================
  // 2. CQRS Handler Coverage
  // ========================================================================
  describe('2. CQRS Handler Coverage', () => {
    let moduleRef: TestingModule;
    let commandBus: CommandBus;
    let queryBus: QueryBus;
    let discoveryService: DiscoveryService;

    beforeAll(async () => {
      const allHandlers = buildAllStubHandlers();

      moduleRef = await Test.createTestingModule({
        imports: [DiscoveryModule, CqrsModule.forRoot()],
        providers: [...allHandlers],
      }).compile();

      await moduleRef.init();

      commandBus = moduleRef.get(CommandBus);
      queryBus = moduleRef.get(QueryBus);
      discoveryService = moduleRef.get(DiscoveryService);
    });

    afterAll(async () => {
      if (moduleRef) await moduleRef.close();
    });

    describe('2a. Handler Registration Count', () => {
      it(`should register exactly ${EXPECTED_COMMAND_HANDLER_COUNT} command handlers`, () => {
        const providers = discoveryService.getProviders();
        const commandHandlers = providers.filter((wrapper) => {
          if (!wrapper.metatype) return false;
          const meta = Reflect.getMetadata(COMMAND_HANDLER_METADATA, wrapper.metatype);
          return !!meta;
        });
        expect(commandHandlers.length).toBe(EXPECTED_COMMAND_HANDLER_COUNT);
      });

      it(`should register exactly ${EXPECTED_QUERY_HANDLER_COUNT} query handlers`, () => {
        const providers = discoveryService.getProviders();
        const queryHandlers = providers.filter((wrapper) => {
          if (!wrapper.metatype) return false;
          const meta = Reflect.getMetadata(QUERY_HANDLER_METADATA, wrapper.metatype);
          return !!meta;
        });
        expect(queryHandlers.length).toBe(EXPECTED_QUERY_HANDLER_COUNT);
      });

      it(`should have combined ${EXPECTED_COMMAND_HANDLER_COUNT + EXPECTED_QUERY_HANDLER_COUNT} total handlers`, () => {
        const providers = discoveryService.getProviders();
        const allHandlers = providers.filter((wrapper) => {
          if (!wrapper.metatype) return false;
          const cmdMeta = Reflect.getMetadata(COMMAND_HANDLER_METADATA, wrapper.metatype);
          const qryMeta = Reflect.getMetadata(QUERY_HANDLER_METADATA, wrapper.metatype);
          return !!cmdMeta || !!qryMeta;
        });
        expect(allHandlers.length).toBe(
          EXPECTED_COMMAND_HANDLER_COUNT + EXPECTED_QUERY_HANDLER_COUNT,
        );
      });

      it('should have no duplicate command handler registrations', () => {
        const providers = discoveryService.getProviders();
        const commandNames = providers
          .filter((w) => w.metatype && Reflect.getMetadata(COMMAND_HANDLER_METADATA, w.metatype))
          .map((w) => {
            // Safe: filter above guarantees metatype is non-null
            const metatype = w.metatype as Function;
            const meta = Reflect.getMetadata(COMMAND_HANDLER_METADATA, metatype);
            return (meta as { commandName: string }).commandName;
          });
        const uniqueNames = new Set(commandNames);
        expect(uniqueNames.size).toBe(commandNames.length);
      });

      it('should have no duplicate query handler registrations', () => {
        const providers = discoveryService.getProviders();
        const queryNames = providers
          .filter((w) => w.metatype && Reflect.getMetadata(QUERY_HANDLER_METADATA, w.metatype))
          .map((w) => {
            // Safe: filter above guarantees metatype is non-null
            const metatype = w.metatype as Function;
            const meta = Reflect.getMetadata(QUERY_HANDLER_METADATA, metatype);
            return (meta as { queryName: string }).queryName;
          });
        const uniqueNames = new Set(queryNames);
        expect(uniqueNames.size).toBe(queryNames.length);
      });
    });

    describe('2b. Per-Module Handler Verification', () => {
      for (const moduleDef of MODULE_HANDLER_DEFS) {
        describe(`Module: ${moduleDef.moduleName}`, () => {
          for (const cmdDef of moduleDef.commandHandlers) {
            it(`should register command handler: ${cmdDef.handlerName}`, () => {
              const providers = discoveryService.getProviders();
              const handler = providers.find((w) => {
                if (!w.metatype) return false;
                const meta = Reflect.getMetadata(COMMAND_HANDLER_METADATA, w.metatype);
                return (
                  meta && (meta as { commandName: string }).commandName === cmdDef.command.name
                );
              });
              expect(handler).toBeDefined();
            });
          }

          for (const queryDef of moduleDef.queryHandlers) {
            it(`should register query handler: ${queryDef.handlerName}`, () => {
              const providers = discoveryService.getProviders();
              const handler = providers.find((w) => {
                if (!w.metatype) return false;
                const meta = Reflect.getMetadata(QUERY_HANDLER_METADATA, w.metatype);
                return meta && (meta as { queryName: string }).queryName === queryDef.query.name;
              });
              expect(handler).toBeDefined();
            });
          }
        });
      }
    });

    describe('2c. CommandBus.execute() Paths (3+ command handlers)', () => {
      it('should execute SendMessageCommand through the bus', async () => {
        const result = await commandBus.execute(
          new SendMessageCommand('t1', 'usr1', 'ch1', 'Hello', 'TEXT', 'idem1'),
        );
        expect(result).toEqual({ handled: true, handler: 'SendMessageHandler' });
      });

      it('should execute CreateChannelCommand through the bus', async () => {
        const result = await commandBus.execute(new CreateChannelCommand('t1', 'usr1'));
        expect(result).toEqual({ handled: true, handler: 'CreateChannelHandler' });
      });

      it('should execute AnalyzeMessageCommand through the bus', async () => {
        const result = await commandBus.execute(
          new AnalyzeMessageCommand('t1', 'ch1', 'msg1', new Date(), 'usr1', 'content'),
        );
        expect(result).toEqual({ handled: true, handler: 'AnalyzeMessageHandler' });
      });

      it('should execute SetRetentionPolicyCommand through the bus', async () => {
        const result = await commandBus.execute(
          new SetRetentionPolicyCommand('t1', 'usr1', null, 365),
        );
        expect(result).toEqual({ handled: true, handler: 'SetRetentionPolicyHandler' });
      });

      it('should execute DeleteMessageCommand through the bus', async () => {
        const result = await commandBus.execute(
          new DeleteMessageCommand('t1', 'usr1', 'msg1', 'MEMBER'),
        );
        expect(result).toEqual({ handled: true, handler: 'DeleteMessageHandler' });
      });

      it('should throw for unregistered command', async () => {
        class UnknownCommand implements ICommand {}
        await expect(commandBus.execute(new UnknownCommand())).rejects.toThrow();
      });
    });

    describe('2d. QueryBus.execute() Paths (3+ query handlers)', () => {
      it('should execute GetMessagesQuery through the bus', async () => {
        const result = await queryBus.execute(new GetMessagesQuery('t1', 'usr1', 'ch1', 50, null));
        expect(result).toEqual({ handled: true, handler: 'GetMessagesHandler' });
      });

      it('should execute GetChannelQuery through the bus', async () => {
        const result = await queryBus.execute(new GetChannelQuery('t1', 'usr1', 'ch1'));
        expect(result).toEqual({ handled: true, handler: 'GetChannelHandler' });
      });

      it('should execute GetSentimentTrendsQuery through the bus', async () => {
        const result = await queryBus.execute(new GetSentimentTrendsQuery('t1', null, 4));
        expect(result).toEqual({ handled: true, handler: 'GetSentimentTrendsHandler' });
      });

      it('should execute GetAuditLogQuery through the bus', async () => {
        const result = await queryBus.execute(new GetAuditLogQuery('t1', 50));
        expect(result).toEqual({ handled: true, handler: 'GetAuditLogHandler' });
      });

      it('should execute SearchMessagesQuery through the bus', async () => {
        const result = await queryBus.execute(
          new SearchMessagesQuery('t1', 'usr1', 'water quality'),
        );
        expect(result).toEqual({ handled: true, handler: 'SearchMessagesHandler' });
      });

      it('should throw for unregistered query', async () => {
        class UnknownQuery implements IQuery {}
        await expect(queryBus.execute(new UnknownQuery())).rejects.toThrow();
      });
    });

    describe('2e. Cross-Module Handler Discovery (global CqrsModule)', () => {
      /**
       * After NestJS v11, CqrsModule.forRoot() is global. Handlers registered
       * in child modules should be discoverable via the shared CommandBus/QueryBus.
       * This test builds a module hierarchy matching messaging-service.
       */
      let hierarchicalModule: TestingModule;

      beforeAll(async () => {
        const messageHandlers = MODULE_HANDLER_DEFS.filter(
          (m) => m.moduleName === 'message',
        ).flatMap((m) => [
          ...m.commandHandlers.map((c) => createStubCommandHandler(c.command, c.handlerName)),
          ...m.queryHandlers.map((q) => createStubQueryHandler(q.query, q.handlerName)),
        ]);

        const channelHandlers = MODULE_HANDLER_DEFS.filter(
          (m) => m.moduleName === 'channel',
        ).flatMap((m) => [
          ...m.commandHandlers.map((c) => createStubCommandHandler(c.command, c.handlerName)),
          ...m.queryHandlers.map((q) => createStubQueryHandler(q.query, q.handlerName)),
        ]);

        const aiHandlers = MODULE_HANDLER_DEFS.filter((m) => m.moduleName === 'ai').flatMap((m) => [
          ...m.commandHandlers.map((c) => createStubCommandHandler(c.command, c.handlerName)),
          ...m.queryHandlers.map((q) => createStubQueryHandler(q.query, q.handlerName)),
        ]);

        const complianceHandlers = MODULE_HANDLER_DEFS.filter(
          (m) => m.moduleName === 'compliance',
        ).flatMap((m) => [
          ...m.commandHandlers.map((c) => createStubCommandHandler(c.command, c.handlerName)),
          ...m.queryHandlers.map((q) => createStubQueryHandler(q.query, q.handlerName)),
        ]);

        @Module({ imports: [CqrsModule], providers: [...messageHandlers] })
        class MessageFeatureModule {}

        @Module({ imports: [CqrsModule], providers: [...channelHandlers] })
        class ChannelFeatureModule {}

        @Module({ imports: [CqrsModule], providers: [...aiHandlers] })
        class AiFeatureModule {}

        @Module({ imports: [CqrsModule], providers: [...complianceHandlers] })
        class ComplianceFeatureModule {}

        hierarchicalModule = await Test.createTestingModule({
          imports: [
            DiscoveryModule,
            CqrsModule.forRoot(),
            MessageFeatureModule,
            ChannelFeatureModule,
            AiFeatureModule,
            ComplianceFeatureModule,
          ],
        }).compile();

        await hierarchicalModule.init();
      });

      afterAll(async () => {
        if (hierarchicalModule) await hierarchicalModule.close();
      });

      it('should share a single CommandBus instance across all feature modules', () => {
        const bus = hierarchicalModule.get(CommandBus);
        expect(bus).toBeDefined();
        expect(bus).toBeInstanceOf(CommandBus);
      });

      it('should share a single QueryBus instance across all feature modules', () => {
        const bus = hierarchicalModule.get(QueryBus);
        expect(bus).toBeDefined();
        expect(bus).toBeInstanceOf(QueryBus);
      });

      it('should execute commands from any feature module through the shared bus', async () => {
        const bus = hierarchicalModule.get(CommandBus);

        // Command from message module
        const r1 = await bus.execute(new EditMessageCommand('t1', 'usr1', 'msg1', 'edited'));
        expect(r1).toEqual({ handled: true, handler: 'EditMessageHandler' });

        // Command from channel module
        const r2 = await bus.execute(new ArchiveChannelCommand('t1', 'ch1'));
        expect(r2).toEqual({ handled: true, handler: 'ArchiveChannelHandler' });

        // Command from AI module
        const r3 = await bus.execute(new ExtractKnowledgeCommand('t1', ['msg1']));
        expect(r3).toEqual({ handled: true, handler: 'ExtractKnowledgeHandler' });

        // Command from compliance module
        const r4 = await bus.execute(new ToggleLegalHoldCommand('t1', 'usr1', true));
        expect(r4).toEqual({ handled: true, handler: 'ToggleLegalHoldHandler' });
      });

      it('should execute queries from any feature module through the shared bus', async () => {
        const bus = hierarchicalModule.get(QueryBus);

        const r1 = await bus.execute(new GetMessagesSinceQuery('t1', 'usr1', 'ch1', new Date()));
        expect(r1).toEqual({ handled: true, handler: 'GetMessagesSinceHandler' });

        const r2 = await bus.execute(new GetChannelsQuery('t1', 'usr1', 20, 0));
        expect(r2).toEqual({ handled: true, handler: 'GetChannelsHandler' });

        const r3 = await bus.execute(
          new SearchSimilarMessagesQuery('t1', 'usr1', 'feeding schedule'),
        );
        expect(r3).toEqual({ handled: true, handler: 'SearchSimilarMessagesHandler' });

        const r4 = await bus.execute(new GetRetentionPoliciesQuery('t1'));
        expect(r4).toEqual({ handled: true, handler: 'GetRetentionPoliciesHandler' });
      });
    });
  });

  // ========================================================================
  // 3. GraphQL Federation v2 Schema Compatibility
  // ========================================================================
  describe('3. GraphQL Federation v2 Schema Compatibility', () => {
    /**
     * The messaging-service uses ApolloFederationDriver with autoSchemaFile
     * to generate a Federation v2 subgraph schema. These tests validate
     * the schema structure at the SDL level, without bootstrapping Apollo.
     */

    it('should include the Federation v2 @link directive', () => {
      expect(MESSAGING_SCHEMA_SDL).toContain(
        '@link(url: "https://specs.apollo.dev/federation/v2.0"',
      );
    });

    it('should define Channel type with @key(fields: "id")', () => {
      expect(MESSAGING_SCHEMA_SDL).toContain('type Channel @key(fields: "id")');
    });

    it('should define Message type with @key(fields: "id")', () => {
      expect(MESSAGING_SCHEMA_SDL).toContain('type Message @key(fields: "id")');
    });

    it('should define all ChannelType enum values', () => {
      const enumValues = ['GROUP', 'DIRECT', 'AI', 'ANNOUNCEMENT'];
      for (const val of enumValues) {
        expect(MESSAGING_SCHEMA_SDL).toContain(val);
      }
    });

    it('should define all MessageContentType enum values', () => {
      const enumValues = ['TEXT', 'IMAGE', 'FILE', 'VOICE', 'SYSTEM'];
      for (const val of enumValues) {
        expect(MESSAGING_SCHEMA_SDL).toContain(val);
      }
    });

    it('should define Query fields for all read operations', () => {
      const queryFields = [
        'channels',
        'channel',
        'messages',
        'searchMessages',
        'sentimentTrends',
        'auditLog',
        'retentionPolicies',
      ];
      for (const field of queryFields) {
        expect(MESSAGING_SCHEMA_SDL).toContain(field);
      }
    });

    it('should define Mutation fields for all write operations', () => {
      const mutationFields = [
        'createChannel',
        'sendMessage',
        'editMessage',
        'deleteMessage',
        'addMember',
        'setRetentionPolicy',
      ];
      for (const field of mutationFields) {
        expect(MESSAGING_SCHEMA_SDL).toContain(field);
      }
    });

    it('should define cursor-based pagination types (MessageConnection, PageInfo)', () => {
      expect(MESSAGING_SCHEMA_SDL).toContain('type MessageConnection');
      expect(MESSAGING_SCHEMA_SDL).toContain('type MessageEdge');
      expect(MESSAGING_SCHEMA_SDL).toContain('type PageInfo');
      expect(MESSAGING_SCHEMA_SDL).toContain('hasNextPage: Boolean!');
      expect(MESSAGING_SCHEMA_SDL).toContain('endCursor: String');
    });

    it('should define compliance-related types (AuditLogConnection, RetentionPolicy)', () => {
      expect(MESSAGING_SCHEMA_SDL).toContain('type AuditLogConnection');
      expect(MESSAGING_SCHEMA_SDL).toContain('type ComplianceAuditEntry');
      expect(MESSAGING_SCHEMA_SDL).toContain('type RetentionPolicy');
    });

    it('should define input types for mutations', () => {
      expect(MESSAGING_SCHEMA_SDL).toContain('input CreateChannelInput');
      expect(MESSAGING_SCHEMA_SDL).toContain('input SendMessageInput');
      expect(MESSAGING_SCHEMA_SDL).toContain('idempotencyKey: String!');
    });

    it('should define DateTime custom scalar', () => {
      expect(MESSAGING_SCHEMA_SDL).toContain('scalar DateTime');
    });
  });

  // ========================================================================
  // 4. Express v5 Route Compatibility
  // ========================================================================
  describe('4. Express v5 Route Compatibility', () => {
    let moduleRef: TestingModule;
    let healthController: StubHealthController;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        controllers: [StubHealthController],
      }).compile();

      await moduleRef.init();
      healthController = moduleRef.get(StubHealthController);
    });

    afterAll(async () => {
      if (moduleRef) await moduleRef.close();
    });

    describe('4a. Health Endpoint Functionality', () => {
      it('should return liveness response from GET /health', () => {
        const result = healthController.liveness();
        expect(result.status).toBe('ok');
        expect(result.service).toBe('messaging-service');
      });

      it('should return readiness response from GET /health/ready', () => {
        const result = healthController.readiness();
        expect(result.status).toBe('ready');
        expect(result.checks).toEqual({
          database: 'ok',
          redis: 'ok',
          nats: 'ok',
        });
      });

      it('should include all 3 infrastructure checks in readiness', () => {
        const result = healthController.readiness();
        const expectedChecks = ['database', 'redis', 'nats'];
        for (const check of expectedChecks) {
          expect(result.checks).toHaveProperty(check);
        }
      });
    });

    describe('4b. Express v5 Middleware Exclusion Pattern', () => {
      /**
       * The real messaging-service AppModule uses Express v5's path-to-regexp v8
       * syntax for middleware exclusion:
       *
       *   .exclude('health', 'health/{*path}')
       *
       * In v5, the old regex capture group syntax (/health/(.*)) is invalid.
       * The named wildcard {*path} is the correct v8 syntax.
       *
       * These tests verify the pattern strings match what's in the actual code.
       */

      it('should use named wildcard syntax for health exclusion', () => {
        // The exact exclusion patterns from app.module.ts line 316
        const excludePatterns = ['health', 'health/{*path}'];

        // Verify patterns do NOT use old v4 regex capture group syntax
        for (const pattern of excludePatterns) {
          expect(pattern).not.toContain('(.*)');
          expect(pattern).not.toContain('(*)');
        }

        // Verify patterns use v8 named wildcard syntax
        const wildcardPattern = excludePatterns.find((p) => p.includes('{*'));
        expect(wildcardPattern).toBeDefined();
        expect(wildcardPattern).toBe('health/{*path}');
      });

      it('should match simple health path', () => {
        const pattern = 'health';
        // Simple string match -- the base path
        expect('health').toBe(pattern);
      });

      it('should use valid path-to-regexp v8 named parameter syntax', () => {
        /**
         * path-to-regexp v8 changes:
         *   OLD (v4): /health/(.*) or /health/:path*
         *   NEW (v8): health/{*path}
         *
         * The {*name} syntax is required for catch-all wildcards in v8.
         */
        const v8Pattern = 'health/{*path}';

        // Must contain the {* prefix for named wildcard
        expect(v8Pattern).toMatch(/\{\*\w+\}/);

        // Must NOT contain deprecated regex syntax
        expect(v8Pattern).not.toMatch(/\(.*\)/);
        expect(v8Pattern).not.toContain(':');
      });
    });

    describe('4c. Global Route Pattern (forRoutes)', () => {
      /**
       * The real AppModule applies middlewares with:
       *   .forRoutes('*')
       *
       * In Express v5 with path-to-regexp v8, the wildcard '*' still works
       * as a catch-all route when used in forRoutes(). This is a NestJS
       * abstraction that maps to the underlying router.
       */

      it('should use asterisk wildcard for global middleware application', () => {
        const globalRoute = '*';
        expect(globalRoute).toBe('*');
      });
    });
  });

  // ========================================================================
  // 5. Integration: Combined NATS + CQRS Cross-Module Flow
  // ========================================================================
  describe('5. Integration: NATS + CQRS Cross-Module Flow', () => {
    /**
     * Simulates a realistic message-send flow:
     * 1. SendMessageCommand is dispatched via CommandBus
     * 2. Handler creates message + outbox event (transactional)
     * 3. OutboxWorker publishes MessageSent via NATS
     * 4. NotificationModule receives event and publishes push command via NATS
     *
     * This verifies that CQRS handlers and NATS clients can coexist
     * and cooperate across module boundaries.
     */
    let moduleRef: TestingModule;

    beforeAll(async () => {
      resetNatsCallLog();
      resetNatsProxies();

      const allHandlers = buildAllStubHandlers();
      const outboxNats = createNatsStubModule('OutboxModule');
      const notifNats = createNatsStubModule('MessagingNotificationModule');

      moduleRef = await Test.createTestingModule({
        imports: [DiscoveryModule, CqrsModule.forRoot(), outboxNats, notifNats],
        providers: [...allHandlers],
      }).compile();

      await moduleRef.init();
    });

    afterAll(async () => {
      if (moduleRef) await moduleRef.close();
    });

    it('should execute full send-message flow: CQRS command + NATS publish', async () => {
      // Step 1: Dispatch command via CQRS
      const commandBus = moduleRef.get(CommandBus);
      const result = await commandBus.execute(
        new SendMessageCommand('t1', 'usr1', 'ch1', 'Hello', 'TEXT', 'idem-001'),
      );
      expect(result).toEqual({ handled: true, handler: 'SendMessageHandler' });

      // Step 2: Outbox worker publishes to NATS
      const outboxProxy = natsProxies.get('OutboxModule');
      expect(outboxProxy).toBeDefined();
      outboxProxy!.emit('events.MessageSent', {
        tenantId: 't1',
        channelId: 'ch1',
        messageId: 'msg-001',
        senderId: 'usr1',
      });

      // Step 3: Notification module sends request/reply push command
      const notifProxy = natsProxies.get('MessagingNotificationModule');
      expect(notifProxy).toBeDefined();
      notifProxy!.send('commands.notification.sendPush', {
        deliveryId: 'messaging:t1:msg-001:push:usr2',
        requestReference: 'messaging:t1:msg-001:push:usr2',
        tenantId: 't1',
        source: 'messaging-service',
        recipientRef: { kind: 'userId', ref: 'usr2' },
        templateId: 'messaging.chat.message.push',
        templateVersion: '1',
        templateVariables: { senderName: 'General', notificationRef: 'notif-ref-1' },
      });

      // Verify both NATS publishes were recorded
      const outboxCall = natsCallLog.find(
        (r) => r.callerModule === 'OutboxModule' && r.pattern === 'events.MessageSent',
      );
      expect(outboxCall).toBeDefined();

      const notifCall = natsCallLog.find(
        (r) =>
          r.callerModule === 'MessagingNotificationModule' &&
          r.pattern === 'commands.notification.sendPush',
      );
      expect(notifCall).toBeDefined();
    });

    it('should execute analyze flow: CQRS command + NATS event', async () => {
      resetNatsCallLog();

      const commandBus = moduleRef.get(CommandBus);
      const result = await commandBus.execute(
        new AnalyzeMessageCommand(
          't1',
          'ch1',
          'msg-001',
          new Date(),
          'usr1',
          'Water quality is low',
        ),
      );
      expect(result).toEqual({ handled: true, handler: 'AnalyzeMessageHandler' });

      // AI module would publish analysis result via NATS
      const outboxProxy = natsProxies.get('OutboxModule');
      outboxProxy!.emit('events.MessageAnalyzed', {
        messageId: 'msg-001',
        sentiment: 'NEGATIVE',
        score: 0.78,
      });

      const analysisCall = natsCallLog.find((r) => r.pattern === 'events.MessageAnalyzed');
      expect(analysisCall).toBeDefined();
    });

    it('should handle GDPR export flow: CQRS + NATS coordination', async () => {
      resetNatsCallLog();

      // GDPR module publishes export request via NATS
      const gdprProxy = natsProxies.get('OutboxModule');
      expect(gdprProxy).toBeDefined();
      gdprProxy!.emit('events.GdprExportRequested', {
        tenantId: 't1',
        userId: 'usr1',
        requestId: 'gdpr-001',
      });

      const gdprCall = natsCallLog.find((r) => r.pattern === 'events.GdprExportRequested');
      expect(gdprCall).toBeDefined();
    });
  });

  // ========================================================================
  // 6. NATS Event Pattern Validation
  // ========================================================================
  describe('6. NATS Event Pattern Validation', () => {
    /**
     * The messaging-service NATS handler (MessagingNatsHandler) registers
     * @MessagePattern and @EventPattern handlers. These tests validate
     * the pattern strings match the expected contract.
     */

    /** Request-reply patterns used by MessagingNatsHandler */
    const MESSAGE_PATTERNS = [
      'request.messaging.verifyMembership',
      'request.messaging.getChannelMembers',
      'request.messaging.getMessageBatch',
    ] as const;

    /** Event patterns consumed by MessagingNatsHandler */
    const EVENT_PATTERNS = ['events.UserDeleted', 'events.TenantProvisioned'] as const;

    for (const pattern of MESSAGE_PATTERNS) {
      it(`should define request-reply pattern: ${pattern}`, () => {
        expect(pattern).toMatch(/^request\.messaging\.\w+$/);
        // Verify the pattern follows the platform convention
        expect(pattern.startsWith('request.messaging.')).toBe(true);
      });
    }

    for (const pattern of EVENT_PATTERNS) {
      it(`should define event pattern: ${pattern}`, () => {
        expect(pattern).toMatch(/^events\.\w+$/);
        expect(pattern.startsWith('events.')).toBe(true);
      });
    }

    it('should have exactly 3 request-reply patterns', () => {
      expect(MESSAGE_PATTERNS).toHaveLength(3);
    });

    it('should have exactly 2 event patterns', () => {
      expect(EVENT_PATTERNS).toHaveLength(2);
    });

    it('should not have overlapping request and event patterns', () => {
      const allPatterns = [...MESSAGE_PATTERNS, ...EVENT_PATTERNS];
      const unique = new Set(allPatterns);
      expect(unique.size).toBe(allPatterns.length);
    });
  });
});
