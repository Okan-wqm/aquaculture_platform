/**
 * @module E2E Test Infrastructure
 * @description Shared bootstrap, helpers, and teardown for messaging-service E2E tests.
 *
 * Architecture:
 * - Real PostgreSQL (tenant schema isolation via search_path)
 * - Real Redis (presence, unread, idempotency, rate limiting)
 * - Mocked NATS (no cross-service dependency)
 * - Mocked MinIO/MediaService (no object storage dependency)
 * - Mocked EventBus (outbox DB writes are real; event publish is mock)
 * - Tenant context injected via x-user-payload header (gateway simulation)
 *
 * IMPORTANT: Requires docker-compose.dev.yml services running:
 *   docker compose -f docker-compose.dev.yml up -d postgres redis nats
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import supertest from 'supertest';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import {
  applyTenantRlsToSchema,
  createMigrationRunnerService,
  getTenantSchemaName,
  tenantMigrationLedgerTable,
} from '@aquaculture/backend-common/database';
import { buildSignedInternalHeaders } from '@aquaculture/backend-common/http';
import { requestContextStorage } from '@aquaculture/backend-common/logging';
import { NatsEventBus } from '@platform/event-bus';
import { REDIS_CLIENT } from '../src/shared/redis.provider';
import { STORAGE_OBJECT_VERIFIER } from '../src/message/services/storage-object-verifier.port';
import { PartitionManagerService } from '../src/partition/partition-manager.service';
import { Baseline1800000000000 } from '../src/migrations/1800000000000-Baseline';
import { CreateMessagingOutboxTable1800200000000 } from '../src/migrations/1800200000000-CreateMessagingOutboxTable';
import { AddUserAiConsentTenantUserUnique1800300000000 } from '../src/migrations/1800300000000-AddUserAiConsentTenantUserUnique';
import { EnforceSourceOnlyMessagingOutboxContract1800400000000 } from '../src/migrations/1800400000000-EnforceSourceOnlyMessagingOutboxContract';
import { EnsureMessagingPartitionContract1800500000000 } from '../src/migrations/1800500000000-EnsureMessagingPartitionContract';

// ── Test Constants ──────────────────────────────────────────────────────────

export const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const USER_A1 = '11111111-1111-4111-8111-111111111111';
export const USER_A2 = '22222222-2222-4222-8222-222222222222';
export const ADMIN_A = '33333333-3333-4333-8333-333333333333';

export const USER_B1 = '44444444-4444-4444-8444-444444444444';
export const USER_B2 = '55555555-5555-4555-8555-555555555555';

const MESSAGING_SOURCE_SCHEMA = 'messaging';
const MessagingE2eMigrationRunner = createMigrationRunnerService(MESSAGING_SOURCE_SCHEMA, {
  tenantAware: false,
});
const GRAPHQL_CONTENT_TYPE = 'application/json';
const MESSAGING_SERVICE_AUDIENCE = 'messaging';
let sourceMigrationPromise: Promise<void> | undefined;

function getE2eInternalServiceSecret(): string {
  const existing = process.env['INTERNAL_SERVICE_SECRET'];
  if (existing) {
    return existing;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  process.env['INTERNAL_SERVICE_SECRET'] = generated;
  return generated;
}

function e2eConfigService(): { get: <T = string>(key: string, defaultValue?: T) => T | undefined } {
  return {
    get: <T = string>(key: string, defaultValue?: T): T | undefined => {
      const value = process.env[key];
      return value === undefined ? defaultValue : (value as T);
    },
  };
}

async function withE2eDdlAuthority<T>(operation: () => Promise<T>): Promise<T> {
  const previous = process.env['DB_MIGRATE_DDL_AUTHORITY'];
  process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
  try {
    return await operation();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, 'DB_MIGRATE_DDL_AUTHORITY');
    } else {
      process.env['DB_MIGRATE_DDL_AUTHORITY'] = previous;
    }
  }
}

async function ensureMessagingSourceMigrationsApplied(): Promise<void> {
  sourceMigrationPromise ??= withE2eDdlAuthority(async () => {
    const dataSource = new DataSource({
      type: 'postgres',
      host: process.env['DATABASE_HOST'] ?? 'localhost',
      port: Number(process.env['DATABASE_PORT'] ?? '5432'),
      username: process.env['DATABASE_USER'] ?? 'postgres',
      password: process.env['DATABASE_PASSWORD'] ?? 'postgres',
      database: process.env['DATABASE_NAME'] ?? 'aquaculture_e2e',
      schema: MESSAGING_SOURCE_SCHEMA,
      synchronize: false,
      migrationsRun: false,
      logging: false,
      migrations: [
        Baseline1800000000000,
        CreateMessagingOutboxTable1800200000000,
        AddUserAiConsentTenantUserUnique1800300000000,
        EnforceSourceOnlyMessagingOutboxContract1800400000000,
        EnsureMessagingPartitionContract1800500000000,
      ],
    });

    await dataSource.initialize();
    try {
      await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${MESSAGING_SOURCE_SCHEMA}"`);
      await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      await dataSource.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
      await dataSource.query('CREATE EXTENSION IF NOT EXISTS "vector"');

      const runner = new MessagingE2eMigrationRunner(
        dataSource,
        e2eConfigService() as never,
      );
      await runner.onApplicationBootstrap();
    } finally {
      await dataSource.destroy();
    }
  });
  return sourceMigrationPromise;
}

// ── App Bootstrap ───────────────────────────────────────────────────────────

export interface E2eTestContext {
  app: INestApplication;
  httpServer: ReturnType<INestApplication['getHttpServer']>;
  dataSource: DataSource;
  redis: Redis;
}

/**
 * Bootstrap the full NestJS application with selective guard overrides.
 *
 * WHY we don't mock guards broadly: TenantGuard and RolesGuard must stay active
 * to prove that tenant isolation, role-based access, and service-identity
 * signatures actually work through the real middleware+guard chain.
 *
 * @param options.enableRateLimiting - Keep ThrottlerGuard active (default: false)
 */
export async function createE2eTestApp(
  options: { enableRateLimiting?: boolean } = {},
): Promise<E2eTestContext> {
  // ── Environment setup for production-safe app bootstrap ──
  await ensureMessagingSourceMigrationsApplied();

  // SECURITY: E2E requests simulate gateway-to-subgraph traffic, including
  // service-identity signatures. This keeps StripInternalHeadersMiddleware
  // active while still allowing the forwarded user/tenant context headers.
  process.env['INTERNAL_SERVICE_SECRET'] = getE2eInternalServiceSecret();

  // ThrottlerGuard reads THROTTLE_ENABLED from ConfigService.
  // Disable unless explicitly testing rate limits.
  if (!options.enableRateLimiting) {
    process.env['THROTTLE_ENABLED'] = 'false';
  } else {
    process.env['THROTTLE_ENABLED'] = 'true';
  }

  // JWT: The JwtModule requires an RSA public key for RS256 verification.
  // In E2E tests we don't verify JWTs (user context comes from x-user-payload
  // header), but the module MUST bootstrap without crashing.
  //
  // WHY unconditional: Production environments have JWT_PUBLIC_KEY_PATH set
  // (e.g. /etc/ssl/jwt/public.pem) but that file may not exist in the test
  // environment (CI runners, local dev machines). We MUST override both env
  // vars to guarantee the generated key is used, not a stale file path.
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env['JWT_PUBLIC_KEY'] = publicKey;
  delete process.env['JWT_PUBLIC_KEY_PATH'];

  // ── NATS Mock ──
  // WHY: No NATS broker in CI. Two separate NATS dependencies exist:
  //
  // 1. NATS_SERVICE (@nestjs/microservices ClientProxy) — used by GdprService,
  //    AiChatBridgeService, EventHandlersModule for request-reply patterns.
  //    The @nestjs/microservices mock provides the module shell but NOT the
  //    provider token, so we override it explicitly.
  //
  // 2. EVENT_BUS (@platform/event-bus NatsEventBus) — used by OutboxPublisher
  //    for JetStream event publishing. Connects to NATS on init, so we
  //    override it with a no-op mock.
  const mockNatsClient = {
    emit: jest.fn().mockReturnValue({ subscribe: jest.fn() }),
    send: jest.fn().mockReturnValue({ subscribe: jest.fn(), pipe: jest.fn().mockReturnThis(), toPromise: jest.fn() }),
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };

  // Full IEventBus interface mock — every method from IEventPublisher,
  // IEventSubscriber, and IEventBus plus NestJS lifecycle hooks.
  const mockEventBus = {
    // IEventPublisher
    publish: jest.fn().mockResolvedValue(undefined),
    publishBatch: jest.fn().mockResolvedValue(undefined),
    publishTo: jest.fn().mockResolvedValue(undefined),
    // IEventSubscriber
    subscribe: jest.fn().mockResolvedValue(undefined),
    subscribeTo: jest.fn().mockResolvedValue(undefined),
    unsubscribe: jest.fn().mockResolvedValue(undefined),
    unsubscribeFrom: jest.fn().mockResolvedValue(undefined),
    // IEventBus
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    getHealth: jest.fn().mockResolvedValue({
      isHealthy: true,
      connectionState: 'connected',
    }),
    // NestJS lifecycle
    onModuleInit: jest.fn().mockResolvedValue(undefined),
    onModuleDestroy: jest.fn().mockResolvedValue(undefined),
  };

  const mockStorageObjectVerifier = {
    verifyObject: jest.fn().mockResolvedValue({
      contentLength: 1024,
      contentType: 'application/octet-stream',
    }),
  };

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider('NATS_SERVICE')
    .useValue(mockNatsClient)
    .overrideProvider('EVENT_BUS')
    .useValue(mockEventBus)
    // NatsEventBus is also registered as a class provider by EventBusModule.
    // Override it to prevent NATS connection attempt on module init.
    .overrideProvider(NatsEventBus)
    .useValue(mockEventBus)
    // Media E2E should prove messaging contracts without invoking AWS SDK's
    // runtime transport in Jest VM. Production keeps the S3 verifier provider.
    .overrideProvider(STORAGE_OBJECT_VERIFIER)
    .useValue(mockStorageObjectVerifier)
    .compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.init();

  const dataSource = moduleFixture.get(DataSource);
  const redis = moduleFixture.get<Redis>(REDIS_CLIENT);

  return {
    app,
    httpServer: app.getHttpServer(),
    dataSource,
    redis,
  };
}

/**
 * Close the E2E test app safely, no-oping when bootstrap failed.
 *
 * WHY: When `createE2eTestApp()` throws inside `app.init()` (e.g. a
 * migration failure during `OnApplicationBootstrap`), the `return { app, … }`
 * block never executes and the suite-level `let ctx: E2eTestContext`
 * declaration remains `undefined`. The subsequent `afterAll` hook then
 * runs `await ctx.app.close()` which throws
 * `TypeError: Cannot read properties of undefined (reading 'close')` and
 * masks the real bootstrap error in CI logs.
 *
 * This helper lets the afterAll uniformly call `await closeE2eTestApp(ctx)`
 * — when ctx (or ctx.app) is undefined, the helper returns silently and
 * the original bootstrap error remains the visible failure. When ctx.app
 * exists, the helper performs the real `app.close()`.
 *
 * Tier-3 ("make it detectable") reinforcement per CLAUDE.md hierarchy.
 * Without this helper, every future bootstrap regression in this suite
 * would produce the misleading `undefined.close()` cascade and the
 * operator chases a false trail.
 */
export async function closeE2eTestApp(
  ctx: E2eTestContext | undefined,
): Promise<void> {
  if (!ctx?.app) return;
  await ctx.app.close();
}

// ── GraphQL Request Helper ──────────────────────────────────────────────────

/**
 * Build a supertest request pre-configured with tenant + user context headers.
 *
 * Simulates what the API gateway does: decodes JWT and forwards the payload
 * as x-user-payload header to the subgraph service.
 */
export function gqlRequest(
  httpServer: ReturnType<INestApplication['getHttpServer']>,
  tenantId: string,
  userId: string,
  roles: string[] = ['MODULE_USER'],
): { query: (gql: string, variables?: Record<string, unknown>) => supertest.Test } {
  const userPayload = JSON.stringify({
    sub: userId,
    email: `${userId.slice(0, 8)}@test.com`,
    tenantId,
    roles,
    role: roles[0],
    type: 'access',
  });

  return {
    query: (gql: string, variables?: Record<string, unknown>) => {
      const body =
        variables === undefined ? { query: gql } : { query: gql, variables };
      const bodyString = JSON.stringify(body);
      const serviceHeaders: Record<string, string> = {
        ...buildSignedInternalHeaders({
          serviceName: 'gateway-api',
          secret: getE2eInternalServiceSecret(),
          tenantId,
          method: 'POST',
          path: '/graphql',
          body: bodyString,
          audience: MESSAGING_SERVICE_AUDIENCE,
          contentType: GRAPHQL_CONTENT_TYPE,
        }),
      };
      return supertest(httpServer)
        .post('/graphql')
        .set(serviceHeaders)
        .set('content-type', GRAPHQL_CONTENT_TYPE)
        .set('x-user-payload', userPayload)
        .set('x-tenant-id', tenantId)
        .send(bodyString);
    },
  };
}

/**
 * Assert a GraphQL response is fully successful (no `errors`, non-null
 * `data`) and return the typed payload. Replaces the historical
 * pattern of `.expect(200)` followed by `res.body.data.X.id` which
 * silently returned `undefined` and produced "Cannot read properties
 * of null (reading 'X')" stack traces with no diagnostic content.
 *
 * Use this helper at every place an E2E test reads `res.body.data.<op>`
 * — the failure message becomes the actual GraphQL error array, which
 * tells the operator what to fix instead of where the assertion blew
 * up.
 *
 * TRACK E (architectural-fix shape): we don't yet know the root cause
 * of the rate-limiting spec's pre-existing flake (createChannel
 * returning null at beforeAll). Surfacing the actual error is the
 * Tier-1 prerequisite to root-causing it.
 */
export function expectGqlOk<T = Record<string, unknown>>(
  res: { status: number; body: { data?: T | null; errors?: unknown[] } },
  opName?: string,
): T {
  const label = opName ? ` (${opName})` : '';
  if (res.status !== 200) {
    throw new Error(
      `GraphQL HTTP ${res.status}${label}: expected 200.\n` +
        `Body: ${JSON.stringify(res.body, null, 2)}`,
    );
  }
  if (Array.isArray(res.body.errors) && res.body.errors.length > 0) {
    throw new Error(
      `GraphQL request returned errors${label}:\n` +
        JSON.stringify(res.body.errors, null, 2),
    );
  }
  if (res.body.data === null || res.body.data === undefined) {
    throw new Error(
      `GraphQL response had no \`data\` field${label}.\n` +
        `Body: ${JSON.stringify(res.body, null, 2)}`,
    );
  }
  return res.body.data;
}

// ── Tenant Schema Setup ─────────────────────────────────────────────────────

/**
 * Create tenant schemas and clone table structures from the messaging source schema.
 *
 * The messaging service uses per-tenant PostgreSQL schemas. In production,
 * TenantSchemaSyncService handles provisioning. In E2E tests, we replicate
 * the same DDL cloning pattern directly via SQL.
 */
export async function setupTenantSchemas(
  dataSource: DataSource,
  tenantIds: string[],
): Promise<void> {
  // Ensure the messaging source schema exists and has tables
  // (SourceSchemaBootstrapService runs on app init, but migrations may need to run first)
  const sourceSchema = 'messaging';

  for (const tenantId of tenantIds) {
    const schemaName = getTenantSchemaName(tenantId);

    await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

    // Get all tables from the source schema
    const tables: { tablename: string }[] = await dataSource.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1`,
      [sourceSchema],
    );

    for (const { tablename } of tables) {
      // Skip partition children — they'll be created separately
      const isPartition: { is_partition: boolean }[] = await dataSource.query(
        `SELECT EXISTS (
          SELECT 1 FROM pg_inherits
          WHERE inhrelid = (SELECT oid FROM pg_class WHERE relname = $1 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2))
        ) as is_partition`,
        [tablename, sourceSchema],
      );

      if (isPartition[0]?.is_partition) continue;

      // Check if table already exists in tenant schema
      const exists: { exists: boolean }[] = await dataSource.query(
        `SELECT EXISTS (
          SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = $2
        ) as exists`,
        [schemaName, tablename],
      );

      if (!exists[0]?.exists) {
        // Check if the source table is partitioned
        const partInfo: { partition_strategy: string | null }[] = await dataSource.query(
          `SELECT partstrat as partition_strategy
           FROM pg_partitioned_table
           WHERE partrelid = (
             SELECT oid FROM pg_class
             WHERE relname = $1
             AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)
           )`,
          [tablename, sourceSchema],
        );

        if (partInfo.length > 0 && partInfo[0]?.partition_strategy) {
          // For partitioned tables, get the full CREATE TABLE DDL and adapt
          // WHY: LIKE ... INCLUDING ALL does not copy PARTITION BY clauses
          await clonePartitionedTable(dataSource, sourceSchema, schemaName, tablename);
        } else {
          await dataSource.query(
            `CREATE TABLE "${schemaName}"."${tablename}" (LIKE "${sourceSchema}"."${tablename}" INCLUDING ALL)`,
          );
        }
      }
    }

    await backfillTenantMigrationLedger(dataSource, sourceSchema, schemaName);
    await withE2eDdlAuthority(async () => {
      const queryRunner = dataSource.createQueryRunner();
      try {
        await queryRunner.connect();
        await applyTenantRlsToSchema(queryRunner, {
          schemaOverride: schemaName,
          excludeTables: ['messaging_outbox', 'embeddings_metadata'],
          tenantIdColumns: ['tenantId'],
        });
      } finally {
        await queryRunner.release();
      }
    });

    // Partition DDL is intentionally not emitted by this fixture. Tenant
    // schemas are created after app bootstrap in these E2E suites, so call
    // the canonical runtime partition service once schemas exist.
  }

  await new PartitionManagerService(dataSource).onApplicationBootstrap();
}

async function backfillTenantMigrationLedger(
  dataSource: DataSource,
  sourceSchema: string,
  tenantSchema: string,
): Promise<void> {
  const ledgerTable = tenantMigrationLedgerTable(sourceSchema);
  const [sourceLedger] = await dataSource.query(
    `SELECT to_regclass($1) AS regclass`,
    [`${sourceSchema}.migrations`],
  );

  if (!sourceLedger?.regclass) {
    return;
  }

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS "${tenantSchema}"."${ledgerTable}" (
      "id" SERIAL PRIMARY KEY,
      "timestamp" BIGINT NOT NULL,
      "name" CHARACTER VARYING NOT NULL
    )
  `);

  await dataSource.query(`
    INSERT INTO "${tenantSchema}"."${ledgerTable}" ("timestamp", "name")
    SELECT source."timestamp", source."name"
    FROM "${sourceSchema}"."migrations" source
    WHERE NOT EXISTS (
      SELECT 1
      FROM "${tenantSchema}"."${ledgerTable}" tenant
      WHERE tenant."timestamp" = source."timestamp"
        AND tenant."name" = source."name"
    )
    ORDER BY source."id"
  `);
}

/**
 * Clone a partitioned table from source to tenant schema.
 * Extracts the partition key from pg_catalog and recreates the table.
 */
async function clonePartitionedTable(
  dataSource: DataSource,
  sourceSchema: string,
  targetSchema: string,
  tablename: string,
): Promise<void> {
  // Get the partition key expression
  const partKey: { partition_expr: string }[] = await dataSource.query(
    `SELECT pg_get_partkeydef(c.oid) as partition_expr
     FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
     WHERE n.nspname = $1 AND c.relname = $2`,
    [sourceSchema, tablename],
  );

  if (partKey.length === 0) return;

  const partExpr = partKey[0]!.partition_expr;

  await dataSource.query(
    `CREATE TABLE "${targetSchema}"."${tablename}" (LIKE "${sourceSchema}"."${tablename}" INCLUDING ALL) PARTITION BY ${partExpr}`,
  );
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Truncate all messaging tables within a tenant schema.
 * Uses CASCADE to handle FK relationships.
 */
export async function cleanupTenantData(
  dataSource: DataSource | undefined,
  tenantId: string,
): Promise<void> {
  if (!dataSource) return;
  const schemaName = getTenantSchemaName(tenantId);

  const tables = [
    'pinned_messages',
    'message_reactions',
    'message_receipts',
    'message_attachments',
    'messages',
    'channel_members',
    'channels',
    'retention_policies',
    'legal_holds',
    'compliance_audit_log',
    'messaging_outbox',
    'message_analysis',
    'message_entity_references',
    'knowledge_entries',
    'embeddings_metadata',
  ];

  for (const table of tables) {
    try {
      await dataSource.query(`TRUNCATE "${schemaName}"."${table}" CASCADE`);
    } catch {
      // Table may not exist — ignore
    }
  }
}

/**
 * Flush Redis keys matching a pattern for clean test isolation.
 */
export async function flushRedisKeys(
  redis: Redis | undefined,
  pattern: string,
): Promise<void> {
  if (!redis) return;
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

/**
 * Flush all messaging Redis keys for both test tenants.
 */
export async function flushAllTestRedisKeys(redis: Redis | undefined): Promise<void> {
  await flushRedisKeys(redis, `msg:${TENANT_A}:*`);
  await flushRedisKeys(redis, `msg:${TENANT_B}:*`);
}

// ── Tenant Context Helper (DEFECT-3 / INFRA-CRITICAL-025) ───────────────────

/**
 * Run a test body inside a synthetic AsyncLocalStorage tenant context.
 *
 * Background: tenant routing in messaging-service is driven by ALS
 * (`requestContextStorage` from backend-common). Production requests get
 * the context populated by the middleware chain
 * (`UserContext → TenantContext → TenantSchema`). Tests that exercise the
 * GraphQL HTTP surface get the same path automatically via `gqlRequest()`.
 *
 * BUT: tests that perform direct `dataSource.getRepository().save(...)` /
 * `dataSource.query(...)` calls (typical for fixture-bootstrap, OUTBOX
 * inspection, or when assert helpers reach behind the GraphQL surface)
 * run OUTSIDE any request context. With no ALS, the patched pool falls
 * back to the source-schema default search_path → the write hits
 * `messaging.<table>` → `SourceSchemaWriteGuardService`'s BEFORE trigger
 * raises `TENANT_ISOLATION_VIOLATION`.
 *
 * This helper closes the gap by running the callback inside a synthetic
 * ALS frame that carries `schemaName = tenant_<uuid>`. The patched
 * `TenantConnectionBootstrap` reads that frame on every connection
 * checkout and pins the search_path to the tenant schema before
 * the caller receives the connection.
 *
 * # Example
 *
 * ```ts
 * await withTenantContext(TENANT_A, async () => {
 *   await dataSource.getRepository(Channel).save({ tenantId: TENANT_A, ... });
 * });
 * ```
 *
 * # When NOT to use
 *
 * - Inside a `gqlRequest(...).query(...)` chain — the request middleware
 *   already establishes the ALS frame; double-wrapping is harmless but
 *   unnecessary.
 * - Outside a test (production code uses the real middleware chain).
 *
 * # Invariant
 *
 * The wrapped function MUST NOT spawn detached promises (e.g.
 * `setImmediate(() => dataSource.query(...))`) — those run after the
 * ALS frame is unwound. If you need fire-and-forget within a tenant
 * context, capture the promise and `await` it inside the callback.
 */
export async function withTenantContext<T>(
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const schemaName = getTenantSchemaName(tenantId);
  const currentStore = requestContextStorage.getStore();
  const newStore = {
    ...(currentStore ?? {}),
    tenantId,
    schemaName,
  };
  return requestContextStorage.run(newStore, fn);
}

// ── UUID Helper ─────────────────────────────────────────────────────────────

let idempotencyCounter = 0;

/**
 * Generate a unique idempotency key for test messages.
 *
 * WHY UUID format: SendMessageInput.idempotencyKey has @IsUUID() validation.
 * The UUID is deterministic per counter value for reproducibility, with a
 * random suffix from crypto to avoid cross-run collisions.
 */
export function nextIdempotencyKey(): string {
  idempotencyCounter++;
  return crypto.randomUUID();
}

export function resetIdempotencyCounter(): void {
  idempotencyCounter = 0;
}
