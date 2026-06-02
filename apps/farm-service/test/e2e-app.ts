import './e2e-env';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  BypassRlsService,
  SchemaManagerService,
  getTenantSchemaName,
} from '@aquaculture/backend-common/database';
import {
  createVerifiedUserAssertionHeaders,
  hashVerifiedUserAssertionHeaders,
} from '@aquaculture/backend-common/http';
import { generateServiceIdentityHeadersV2 } from '@aquaculture/backend-common/utils';
import {
  IEvent,
  IEventBus,
  IEventHandler,
  IRequestReply,
  NatsEventBus,
  NatsRequestReply,
  RequestReplyHandler,
  RequestReplyOptions,
  RequestReplyResponderHandle,
} from '@platform/event-bus';
import {
  FileMetadata,
  MinioClientService,
  UploadOptions,
  UploadResult,
} from '@platform/storage';
import { Readable } from 'stream';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GqlAuthGuard } from '../src/common/guards/gql-auth.guard';
import { assertFarmE2eDatabaseEnvironment } from './e2e-env';

export const FARM_E2E_TENANT_ID = '11111111-1111-4111-8111-111111111111';
export const FARM_E2E_USER_ID = '22222222-2222-4222-8222-222222222222';
export const FARM_E2E_SPECIES_ID = '33333333-3333-4333-8333-333333333333';

export type FarmE2eHeaders = ReturnType<typeof farmE2eHeaders>;

export interface FarmE2eApp {
  app: INestApplication;
  httpServer: unknown;
}

export interface FarmE2eHeaderOptions {
  method?: string;
  path?: string;
  body?: string | Buffer;
}

/**
 * WHAT: Build the exact identity envelope the gateway sends to subgraphs.
 *
 * WHY: farm-service is protected by ServiceIdentityGuard before GraphQL
 * resolver logic runs. E2E must exercise that production boundary, not bypass
 * it with a test-only guard override. Tenant id is included both as request
 * context for the farm auth double and as X-Tenant-ID because the service
 * identity HMAC binds tenant to signature.
 */
export function farmE2eHeaders(
  tenantId: string = FARM_E2E_TENANT_ID,
  options: FarmE2eHeaderOptions = {},
): Record<string, string> {
  const secret = process.env['INTERNAL_SERVICE_SECRET'];
  if (!secret) {
    throw new Error('INTERNAL_SERVICE_SECRET must be set before Farm E2E requests.');
  }

  const roles = [Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER];
  const assertionHeaders = createVerifiedUserAssertionHeaders({
    user: {
      sub: FARM_E2E_USER_ID,
      email: 'farm-e2e@example.test',
      tenantId,
      roles,
      role: roles[0],
      mfaVerified: false,
    },
    secret,
  });

  return {
    ...assertionHeaders,
    ...generateServiceIdentityHeadersV2({
      serviceName: 'gateway-api',
      secret,
      tenantId,
      method: options.method ?? 'POST',
      path: options.path ?? '/graphql',
      body: options.body ?? '',
      assertionHash: hashVerifiedUserAssertionHeaders(assertionHeaders),
    }),
    'X-Tenant-ID': tenantId,
    'x-user-id': FARM_E2E_USER_ID,
    'x-user-roles': JSON.stringify(roles),
    'x-e2e-tenant-id': tenantId,
  };
}

type E2eEventBusDouble = IEventBus &
  Pick<NatsEventBus, 'getRawConnection' | 'publishCore'>;

type E2eMinioDouble = Pick<
  MinioClientService,
  | 'onModuleInit'
  | 'ensureBucketExists'
  | 'generateFilePath'
  | 'uploadFile'
  | 'uploadStream'
  | 'deleteFile'
  | 'deleteFileByContext'
  | 'deleteEntityFiles'
  | 'getPresignedUrl'
  | 'getPresignedUploadUrl'
  | 'listObjects'
  | 'fileExists'
  | 'getFileStats'
  | 'getFileMetadata'
  | 'downloadFile'
  | 'getFileStream'
>;

/**
 * WHAT: Boot the real Farm AppModule against a real Postgres database while
 * replacing non-database infrastructure with typed in-process ports.
 *
 * WHY: farm-service E2E must prove GraphQL, Nest module wiring, TypeORM
 * repositories, validation, and domain handlers together. NATS and MinIO are
 * already contract-tested at their package boundaries; forcing this suite to
 * depend on live broker TLS certificates or object-store readiness makes the
 * farm workflow result non-diagnostic. Provider overrides keep the architecture
 * honest: the app still asks for the production tokens, but the E2E boundary is
 * explicit and deterministic.
 */
export async function createFarmE2eApp(): Promise<FarmE2eApp> {
  assertFarmE2eDatabaseEnvironment();
  await resetFarmE2eTenantSchemaBeforeAppInit();

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider('EVENT_BUS')
    .useValue(createEventBusDouble())
    .overrideProvider(NatsEventBus)
    .useValue(createEventBusDouble())
    .overrideProvider(NatsRequestReply)
    .useValue(createRequestReplyDouble())
    .overrideProvider(MinioClientService)
    .useValue(createMinioDouble())
    .overrideGuard(GqlAuthGuard)
    .useClass(FarmE2eAuthGuard)
    .compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  await app.init();
  const bypassRls = app.get(BypassRlsService);
  const dataSource = app.get(DataSource);
  await bypassRls.withBypass('farm-e2e:seed-reference-data', () =>
    seedFarmE2eReferenceData(dataSource, 'farm'),
  );
  await ensureFarmE2eTenantSchema(dataSource, bypassRls);

  return {
    app,
    httpServer: app.getHttpServer(),
  };
}

class FarmE2eAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const gqlContext = GqlExecutionContext.create(context).getContext<{
      req?: {
        headers?: Record<string, string | string[] | undefined>;
        user?: unknown;
        userId?: string;
        tenantId?: string;
      };
    }>();
    const request = gqlContext.req;
    const tenantHeader = request?.headers?.['x-e2e-tenant-id'];
    const tenantId = Array.isArray(tenantHeader)
      ? tenantHeader[0]
      : tenantHeader || FARM_E2E_TENANT_ID;

    if (request) {
      request.user = {
        sub: FARM_E2E_USER_ID,
        email: 'farm-e2e@example.test',
        tenantId,
        roles: [Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER],
        type: 'access',
      };
      request.userId = FARM_E2E_USER_ID;
      request.tenantId = tenantId;
    }

    return true;
  }
}

async function ensureFarmE2eTenantSchema(
  runtimeDataSource: DataSource,
  bypassRls: BypassRlsService,
): Promise<void> {
  const provisioningDataSource =
    await createFarmE2eProvisioningDataSource(runtimeDataSource);
  const ownsProvisioningDataSource = provisioningDataSource !== runtimeDataSource;

  try {
    process.env['DB_APPLICATION_ROLE'] =
      process.env['DB_APPLICATION_ROLE'] ??
      process.env['DATABASE_USER'] ??
      'farm_service';

    const schemaManager = new SchemaManagerService(provisioningDataSource);
    const result = await schemaManager.createTenantSchema(FARM_E2E_TENANT_ID, [
      'farm',
    ]);

    if (!result.success) {
      const detail = result.errors.join('; ');
      if (/permission denied/i.test(detail)) {
        throw new Error(
          'Farm E2E tenant schema provisioning requires a database role with CREATE SCHEMA. ' +
            'Keep FARM_E2E_DATABASE_USER as the farm runtime role and set ' +
            'FARM_E2E_PROVISIONING_DATABASE_USER/FARM_E2E_PROVISIONING_DATABASE_PASSWORD ' +
            `for the provisioning role. Details: ${detail}`,
        );
      }
      throw new Error(
        `Failed to create Farm E2E tenant schema: ${detail}`,
      );
    }

    if (result.alreadyExists) {
      const sync = await schemaManager.syncTenantSchema(FARM_E2E_TENANT_ID, [
        'farm',
      ]);
      if (sync.errors.length > 0) {
        throw new Error(
          `Failed to sync existing Farm E2E tenant schema: ${sync.errors.join('; ')}`,
        );
      }
    }

    await bypassRls.withBypass('farm-e2e:seed-tenant-reference-data', () =>
      seedFarmE2eReferenceData(
        runtimeDataSource,
        getTenantSchemaName(FARM_E2E_TENANT_ID),
      ),
    );
  } finally {
    if (ownsProvisioningDataSource && provisioningDataSource.isInitialized) {
      await provisioningDataSource.destroy();
    }
  }
}

async function createFarmE2eProvisioningDataSource(
  runtimeDataSource: DataSource,
): Promise<DataSource> {
  const dataSource = await createStandaloneFarmE2eProvisioningDataSource();
  return dataSource ?? runtimeDataSource;
}

async function resetFarmE2eTenantSchemaBeforeAppInit(): Promise<void> {
  if (process.env['FARM_E2E_RESET_TENANT_SCHEMA'] === 'false') {
    return;
  }

  const dataSource = await createStandaloneFarmE2eProvisioningDataSource();
  if (!dataSource) {
    return;
  }

  try {
    const schemaName = getTenantSchemaName(FARM_E2E_TENANT_ID);
    if (!/^tenant_[a-f0-9]{16}$/.test(schemaName)) {
      throw new Error(`Unsafe Farm E2E tenant schema name: ${schemaName}`);
    }
    await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  } finally {
    await dataSource.destroy();
  }
}

async function createStandaloneFarmE2eProvisioningDataSource(): Promise<
  DataSource | undefined
> {
  const provisioningUser =
    process.env['FARM_E2E_PROVISIONING_DATABASE_USER']?.trim();
  const provisioningPassword =
    process.env['FARM_E2E_PROVISIONING_DATABASE_PASSWORD']?.trim();

  if (!provisioningUser && !provisioningPassword) {
    return undefined;
  }

  if (!provisioningUser || !provisioningPassword) {
    throw new Error(
      'Farm E2E provisioning database credentials must set both ' +
        'FARM_E2E_PROVISIONING_DATABASE_USER and FARM_E2E_PROVISIONING_DATABASE_PASSWORD.',
    );
  }

  const dataSource = new DataSource({
    type: 'postgres',
    host:
      process.env['FARM_E2E_PROVISIONING_DATABASE_HOST'] ??
      process.env['DATABASE_HOST'],
    port: Number(
      process.env['FARM_E2E_PROVISIONING_DATABASE_PORT'] ??
        process.env['DATABASE_PORT'] ??
        5432,
    ),
    username: provisioningUser,
    password: provisioningPassword,
    database:
      process.env['FARM_E2E_PROVISIONING_DATABASE_NAME'] ??
      process.env['DATABASE_NAME'],
    ssl: process.env['DATABASE_SSL'] === 'true',
  });

  await dataSource.initialize();
  return dataSource;
}

async function seedFarmE2eReferenceData(
  dataSource: DataSource,
  schemaName: 'farm' | string,
): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(schemaName)) {
    throw new Error(`Unsafe Farm E2E schema name: ${schemaName}`);
  }

  await dataSource.query(
    `
      INSERT INTO "${schemaName}".species (
        "id", "tenantId", "scientificName", "commonName", "localName", "code",
        "category", "waterType", "growthParameters", "harvestDaysPerInputType",
        "status", "isActive", "isCleanerFish", "tags", "createdAt", "updatedAt",
        "isDeleted", "version"
      )
      VALUES (
        $1, $2, 'Dicentrarchus labrax e2e', 'E2E Seabass', 'E2E Levrek', 'E2E_SEABASS',
        'fish', 'saltwater',
        $3::jsonb,
        $4::jsonb,
        'active', true, false, '[]'::jsonb, NOW(), NOW(), false, 1
      )
      ON CONFLICT ("tenantId", "code") DO UPDATE
      SET "scientificName" = EXCLUDED."scientificName",
          "commonName" = EXCLUDED."commonName",
          "growthParameters" = EXCLUDED."growthParameters",
          "harvestDaysPerInputType" = EXCLUDED."harvestDaysPerInputType",
          "isActive" = true,
          "isDeleted" = false,
          "updatedAt" = NOW()
    `,
    [
      FARM_E2E_SPECIES_ID,
      FARM_E2E_TENANT_ID,
      JSON.stringify({
        maxDensity: 30,
        densityUnit: 'kg/m3',
        avgDailyGrowth: 1.5,
        avgHarvestWeight: 450,
        harvestWeightUnit: 'gram',
        avgTimeToHarvestDays: 360,
        targetFCR: 1.2,
        expectedSurvivalRate: 95,
      }),
      JSON.stringify({ fry: 360, fingerling: 270 }),
    ],
  );
}

function createEventBusDouble(): E2eEventBusDouble {
  return {
    async connect() {
      return undefined;
    },
    async disconnect() {
      return undefined;
    },
    isConnected() {
      return true;
    },
    async getHealth() {
      return {
        isHealthy: true,
        connectionState: 'connected',
        pendingMessages: 0,
      };
    },
    async publish<TEvent extends IEvent>(_event: TEvent) {
      return undefined;
    },
    async publishBatch<TEvent extends IEvent>(_events: TEvent[]) {
      return undefined;
    },
    async publishTo<TEvent extends IEvent>(_topic: string, _event: TEvent) {
      return undefined;
    },
    async subscribe<TEvent extends IEvent>(
      _eventType: string,
      _handler: IEventHandler<TEvent>,
    ) {
      return undefined;
    },
    async subscribeWildcard<TEvent extends IEvent>(
      _eventType: string,
      _handler: IEventHandler<TEvent>,
    ) {
      return undefined;
    },
    async subscribeForTenant<TEvent extends IEvent>(
      _eventType: string,
      _tenantId: string,
      _handler: IEventHandler<TEvent>,
    ) {
      return undefined;
    },
    async subscribeTo<TEvent extends IEvent>(
      _topic: string,
      _handler: IEventHandler<TEvent>,
    ) {
      return undefined;
    },
    async unsubscribe(_eventType: string) {
      return undefined;
    },
    async unsubscribeFrom(_topic: string) {
      return undefined;
    },
    getRawConnection() {
      return null;
    },
    async publishCore(_subject: string, _payload: Uint8Array) {
      return undefined;
    },
  };
}

function createRequestReplyDouble(): IRequestReply {
  return {
    async requestTyped<Req, Res>(
      subject: string,
      _request: Req,
      _options: RequestReplyOptions,
    ): Promise<Res> {
      throw new Error(
        `Farm E2E request-reply double has no responder for subject "${subject}". ` +
          'Add an explicit E2E responder when the tested workflow owns this dependency.',
      );
    },
    async respond<Req, Res>(
      subject: string,
      _handler: RequestReplyHandler<Req, Res>,
    ): Promise<RequestReplyResponderHandle> {
      return {
        subject,
        async drain() {
          return undefined;
        },
      };
    },
  };
}

function createMinioDouble(): E2eMinioDouble {
  const generateFilePath = (
    tenantId: string,
    entityType: string,
    entityId: string,
    filename: string,
  ) => {
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `${tenantId}/${entityType}/${entityId}/${safeFilename}`;
  };

  const uploadResult = (
    tenantId: string,
    entityType: string,
    entityId: string,
    filename: string,
    size: number,
    options?: UploadOptions,
  ): UploadResult => {
    const path = generateFilePath(tenantId, entityType, entityId, filename);
    const contentType = options?.contentType ?? 'application/octet-stream';

    return {
      internalUrl: `memory://farm-e2e/${path}`,
      path,
      etag: 'farm-e2e-etag',
      size,
      contentType,
    };
  };

  return {
    async onModuleInit() {
      return undefined;
    },
    async ensureBucketExists() {
      return undefined;
    },
    generateFilePath,
    async uploadFile(
      tenantId: string,
      entityType: string,
      entityId: string,
      filename: string,
      buffer: Buffer,
      options?: UploadOptions,
    ) {
      return uploadResult(
        tenantId,
        entityType,
        entityId,
        filename,
        buffer.length,
        options,
      );
    },
    async uploadStream(
      tenantId: string,
      entityType: string,
      entityId: string,
      filename: string,
      _stream: Readable,
      size: number,
      options?: UploadOptions,
    ) {
      return uploadResult(tenantId, entityType, entityId, filename, size, options);
    },
    async deleteFile(_path: string) {
      return undefined;
    },
    async deleteFileByContext(
      _tenantId: string,
      _entityType: string,
      _entityId: string,
      _filename: string,
    ) {
      return undefined;
    },
    async deleteEntityFiles(
      _tenantId: string,
      _entityType: string,
      _entityId: string,
    ) {
      return 0;
    },
    async getPresignedUrl(path: string) {
      return `memory://farm-e2e/download/${path}`;
    },
    async getPresignedUploadUrl(path: string) {
      return `memory://farm-e2e/upload/${path}`;
    },
    async listObjects(_prefix: string) {
      return [];
    },
    async fileExists(_path: string) {
      return false;
    },
    async getFileStats(_path: string) {
      return null;
    },
    async getFileMetadata(_path: string): Promise<FileMetadata | null> {
      return null;
    },
    async downloadFile(_path: string) {
      return Buffer.alloc(0);
    },
    async getFileStream(_path: string) {
      return Readable.from(Buffer.alloc(0));
    },
  };
}
