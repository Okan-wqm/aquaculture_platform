import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { buildDatabaseSslConfig } from '@aquaculture/backend-common/database';
import { LegalHoldService } from '@aquaculture/backend-common/compliance';
import { Inject, Injectable, Logger, Module, OnModuleDestroy, type Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

import { PostgresTelemetryArchiveErasureService } from './postgres-telemetry-archive-erasure.service';
import { PostgresTelemetryArchiveRuntimeLedgerService } from './postgres-telemetry-archive-runtime-ledger.service';
import { PostgresTelemetryArchiveSourceService } from './postgres-telemetry-archive-source.service';
import { PostgresTelemetryScratchRestoreService } from './postgres-telemetry-scratch-restore.service';
import {
  S3TelemetryArchiveObjectStore,
  type TelemetryArchiveS3Command,
  type TelemetryArchiveS3Port,
} from './s3-telemetry-archive-object-store.service';
import { TelemetryArchiveBucketProvisionerService } from './telemetry-archive-bucket-provisioner.service';
import { TelemetryArchiveCoordinatorService } from './telemetry-archive-coordinator.service';
import { TelemetryArchiveLifecycleService } from './telemetry-archive-lifecycle.service';
import { TelemetryArchiveOperationsResponder } from './telemetry-archive-operations.responder';
import {
  TelemetryArchivePresignService,
  type TelemetryArchiveGetSignerPort,
} from './telemetry-archive-presign.service';
import { TelemetryParquetCodecService } from './telemetry-parquet-codec.service';

export const TELEMETRY_ARCHIVE_RUNTIME_TOKENS = {
  exporterClient: Symbol('TELEMETRY_ARCHIVE_EXPORTER_CLIENT'),
  verifierClient: Symbol('TELEMETRY_ARCHIVE_VERIFIER_CLIENT'),
  restoreClient: Symbol('TELEMETRY_ARCHIVE_RESTORE_CLIENT'),
  erasureClient: Symbol('TELEMETRY_ARCHIVE_ERASURE_CLIENT'),
  provisionerClient: Symbol('TELEMETRY_ARCHIVE_PROVISIONER_CLIENT'),
  restoreDataSource: Symbol('TELEMETRY_ARCHIVE_RESTORE_DATA_SOURCE'),
  erasureDataSource: Symbol('TELEMETRY_ARCHIVE_ERASURE_DATA_SOURCE'),
  exporterStore: Symbol('TELEMETRY_ARCHIVE_EXPORTER_STORE'),
  verifierStore: Symbol('TELEMETRY_ARCHIVE_VERIFIER_STORE'),
  restoreStore: Symbol('TELEMETRY_ARCHIVE_RESTORE_STORE'),
  erasureStore: Symbol('TELEMETRY_ARCHIVE_ERASURE_STORE'),
} as const;

const SCRATCH_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;

type TelemetryArchiveS3Capability = 'EXPORTER' | 'VERIFIER' | 'RESTORE' | 'ERASURE' | 'PROVISIONER';
type TelemetryArchiveDatabaseCapability = 'RESTORE' | 'ERASURE';

const TELEMETRY_ARCHIVE_S3_CREDENTIAL_KEYS = {
  EXPORTER: {
    accessKey: 'TELEMETRY_ARCHIVE_EXPORTER_ACCESS_KEY',
    secretKey: 'TELEMETRY_ARCHIVE_EXPORTER_SECRET_KEY',
  },
  VERIFIER: {
    accessKey: 'TELEMETRY_ARCHIVE_VERIFIER_ACCESS_KEY',
    secretKey: 'TELEMETRY_ARCHIVE_VERIFIER_SECRET_KEY',
  },
  RESTORE: {
    accessKey: 'TELEMETRY_ARCHIVE_RESTORE_ACCESS_KEY',
    secretKey: 'TELEMETRY_ARCHIVE_RESTORE_SECRET_KEY',
  },
  ERASURE: {
    accessKey: 'TELEMETRY_ARCHIVE_ERASURE_ACCESS_KEY',
    secretKey: 'TELEMETRY_ARCHIVE_ERASURE_SECRET_KEY',
  },
  PROVISIONER: {
    accessKey: 'TELEMETRY_ARCHIVE_PROVISIONER_ACCESS_KEY',
    secretKey: 'TELEMETRY_ARCHIVE_PROVISIONER_SECRET_KEY',
  },
} as const;

const TELEMETRY_ARCHIVE_DATABASE_CREDENTIAL_KEYS = {
  RESTORE: {
    username: 'TELEMETRY_ARCHIVE_RESTORE_DB_USER',
    password: 'TELEMETRY_ARCHIVE_RESTORE_DB_PASSWORD',
  },
  ERASURE: {
    username: 'TELEMETRY_ARCHIVE_ERASURE_DB_USER',
    password: 'TELEMETRY_ARCHIVE_ERASURE_DB_PASSWORD',
  },
} as const;

export function telemetryArchiveS3CredentialKeys(
  capability: TelemetryArchiveS3Capability,
): (typeof TELEMETRY_ARCHIVE_S3_CREDENTIAL_KEYS)[TelemetryArchiveS3Capability] {
  return TELEMETRY_ARCHIVE_S3_CREDENTIAL_KEYS[capability];
}

export function telemetryArchiveDatabaseCredentialKeys(
  capability: TelemetryArchiveDatabaseCapability,
): (typeof TELEMETRY_ARCHIVE_DATABASE_CREDENTIAL_KEYS)[TelemetryArchiveDatabaseCapability] {
  return TELEMETRY_ARCHIVE_DATABASE_CREDENTIAL_KEYS[capability];
}

export function telemetryArchiveS3Endpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('Telemetry archive S3 endpoint must be a valid URL');
  }
  if (endpoint.protocol !== 'https:') {
    throw new Error('Telemetry archive S3 endpoint must use HTTPS');
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw new Error('Telemetry archive S3 endpoint must not embed credentials');
  }
  return endpoint.toString();
}

export class AwsTelemetryArchiveClient
  implements TelemetryArchiveS3Port, TelemetryArchiveGetSignerPort
{
  constructor(private readonly client: S3Client) {}

  async send(command: TelemetryArchiveS3Command): Promise<unknown> {
    if (command instanceof CreateBucketCommand) return this.client.send(command);
    if (command instanceof DeleteBucketCommand) return this.client.send(command);
    if (command instanceof DeleteObjectCommand) return this.client.send(command);
    if (command instanceof DeleteObjectsCommand) return this.client.send(command);
    if (command instanceof GetObjectCommand) return this.client.send(command);
    if (command instanceof ListObjectVersionsCommand) return this.client.send(command);
    if (command instanceof PutBucketPolicyCommand) return this.client.send(command);
    if (command instanceof PutBucketVersioningCommand) return this.client.send(command);
    if (command instanceof PutObjectCommand) return this.client.send(command);
    throw new Error('Unsupported telemetry archive S3 command');
  }

  async signGet(
    bucket: string,
    objectKey: string,
    objectVersionId: string,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: bucket, Key: objectKey, VersionId: objectVersionId }),
      { expiresIn: expiresInSeconds },
    );
  }
}

@Injectable()
class TelemetryArchiveCapabilityDataSourceCleanup implements OnModuleDestroy {
  constructor(
    @Inject(TELEMETRY_ARCHIVE_RUNTIME_TOKENS.restoreDataSource)
    private readonly restore: DataSource,
    @Inject(TELEMETRY_ARCHIVE_RUNTIME_TOKENS.erasureDataSource)
    private readonly erasure: DataSource,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.restore.destroy(), this.erasure.destroy()]);
  }
}

@Injectable()
class TelemetryArchiveScratchCleanupService {
  private readonly logger = new Logger(TelemetryArchiveScratchCleanupService.name);

  constructor(private readonly scratch: PostgresTelemetryScratchRestoreService) {}

  @Interval(SCRATCH_CLEANUP_INTERVAL_MS)
  async cleanup(): Promise<void> {
    try {
      const droppedCount = await this.scratch.cleanupExpired();
      if (droppedCount > 0) {
        this.logger.log(`Dropped ${droppedCount} expired telemetry restore scratch schemas`);
      }
    } catch (error: unknown) {
      this.logger.error(
        `Telemetry restore scratch cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

@Module({
  imports: [ConfigModule],
  providers: [
    TelemetryArchiveLifecycleService,
    PostgresTelemetryArchiveSourceService,
    TelemetryParquetCodecService,
    PostgresTelemetryArchiveRuntimeLedgerService,
    capabilityS3Provider(TELEMETRY_ARCHIVE_RUNTIME_TOKENS.exporterClient, 'EXPORTER'),
    capabilityS3Provider(TELEMETRY_ARCHIVE_RUNTIME_TOKENS.verifierClient, 'VERIFIER'),
    capabilityS3Provider(TELEMETRY_ARCHIVE_RUNTIME_TOKENS.restoreClient, 'RESTORE'),
    capabilityS3Provider(TELEMETRY_ARCHIVE_RUNTIME_TOKENS.erasureClient, 'ERASURE'),
    capabilityS3Provider(TELEMETRY_ARCHIVE_RUNTIME_TOKENS.provisionerClient, 'PROVISIONER'),
    capabilityDataSourceProvider(TELEMETRY_ARCHIVE_RUNTIME_TOKENS.restoreDataSource, 'RESTORE'),
    capabilityDataSourceProvider(TELEMETRY_ARCHIVE_RUNTIME_TOKENS.erasureDataSource, 'ERASURE'),
    TelemetryArchiveCapabilityDataSourceCleanup,
    storeProvider(
      TELEMETRY_ARCHIVE_RUNTIME_TOKENS.exporterStore,
      TELEMETRY_ARCHIVE_RUNTIME_TOKENS.exporterClient,
      'telemetry-archive-exporter',
      'WRITE',
    ),
    storeProvider(
      TELEMETRY_ARCHIVE_RUNTIME_TOKENS.verifierStore,
      TELEMETRY_ARCHIVE_RUNTIME_TOKENS.verifierClient,
      'telemetry-archive-verifier',
      'READ',
    ),
    storeProvider(
      TELEMETRY_ARCHIVE_RUNTIME_TOKENS.restoreStore,
      TELEMETRY_ARCHIVE_RUNTIME_TOKENS.restoreClient,
      'telemetry-archive-restore',
      'READ',
    ),
    storeProvider(
      TELEMETRY_ARCHIVE_RUNTIME_TOKENS.erasureStore,
      TELEMETRY_ARCHIVE_RUNTIME_TOKENS.erasureClient,
      'telemetry-archive-erasure',
      'ERASE',
    ),
    {
      provide: PostgresTelemetryScratchRestoreService,
      inject: [TELEMETRY_ARCHIVE_RUNTIME_TOKENS.restoreDataSource],
      useFactory: (dataSource: DataSource): PostgresTelemetryScratchRestoreService =>
        new PostgresTelemetryScratchRestoreService(dataSource, { now: () => new Date() }),
    },
    {
      provide: PostgresTelemetryArchiveErasureService,
      inject: [TELEMETRY_ARCHIVE_RUNTIME_TOKENS.erasureDataSource],
      useFactory: (dataSource: DataSource): PostgresTelemetryArchiveErasureService =>
        new PostgresTelemetryArchiveErasureService(dataSource),
    },
    {
      provide: TelemetryArchivePresignService,
      inject: [
        TELEMETRY_ARCHIVE_RUNTIME_TOKENS.restoreClient,
        PostgresTelemetryArchiveRuntimeLedgerService,
      ],
      useFactory: (
        signer: AwsTelemetryArchiveClient,
        ledger: PostgresTelemetryArchiveRuntimeLedgerService,
      ): TelemetryArchivePresignService =>
        new TelemetryArchivePresignService(signer, ledger, { now: () => new Date() }),
    },
    {
      provide: TelemetryArchiveBucketProvisionerService,
      inject: [TELEMETRY_ARCHIVE_RUNTIME_TOKENS.provisionerClient, ConfigService],
      useFactory: (
        client: AwsTelemetryArchiveClient,
        config: ConfigService,
      ): TelemetryArchiveBucketProvisionerService =>
        new TelemetryArchiveBucketProvisionerService(client, {
          exporter: required(config, 'TELEMETRY_ARCHIVE_EXPORTER_PRINCIPAL'),
          verifier: required(config, 'TELEMETRY_ARCHIVE_VERIFIER_PRINCIPAL'),
          restore: required(config, 'TELEMETRY_ARCHIVE_RESTORE_PRINCIPAL'),
          erasure: required(config, 'TELEMETRY_ARCHIVE_ERASURE_PRINCIPAL'),
        }),
    },
    {
      provide: TelemetryArchiveCoordinatorService,
      inject: [
        TelemetryArchiveLifecycleService,
        PostgresTelemetryArchiveErasureService,
        PostgresTelemetryArchiveSourceService,
        TelemetryParquetCodecService,
        TELEMETRY_ARCHIVE_RUNTIME_TOKENS.exporterStore,
        TELEMETRY_ARCHIVE_RUNTIME_TOKENS.verifierStore,
        TELEMETRY_ARCHIVE_RUNTIME_TOKENS.restoreStore,
        TELEMETRY_ARCHIVE_RUNTIME_TOKENS.erasureStore,
        PostgresTelemetryScratchRestoreService,
        LegalHoldService,
        TelemetryArchivePresignService,
        PostgresTelemetryArchiveRuntimeLedgerService,
      ],
      useFactory: (
        lifecycle: TelemetryArchiveLifecycleService,
        erasure: PostgresTelemetryArchiveErasureService,
        source: PostgresTelemetryArchiveSourceService,
        parquet: TelemetryParquetCodecService,
        exporterStore: S3TelemetryArchiveObjectStore,
        verifierStore: S3TelemetryArchiveObjectStore,
        restoreStore: S3TelemetryArchiveObjectStore,
        erasureStore: S3TelemetryArchiveObjectStore,
        scratchRestore: PostgresTelemetryScratchRestoreService,
        legalHold: LegalHoldService,
        presigns: TelemetryArchivePresignService,
        pendingExports: PostgresTelemetryArchiveRuntimeLedgerService,
      ): TelemetryArchiveCoordinatorService =>
        new TelemetryArchiveCoordinatorService({
          lifecycle: {
            append: (event) => lifecycle.append(event),
            getManifest: (operationId, state) => lifecycle.getManifest(operationId, state),
          },
          erasure,
          source,
          parquet,
          exporterStore,
          verifierStore,
          restoreStore,
          erasureStore,
          scratchRestore,
          legalHold,
          presigns,
          pendingExports,
          clock: { now: () => new Date() },
        }),
    },
    TelemetryArchiveScratchCleanupService,
    TelemetryArchiveOperationsResponder,
  ],
  exports: [
    TelemetryArchiveCoordinatorService,
    TelemetryArchiveLifecycleService,
    TelemetryArchiveBucketProvisionerService,
    TelemetryArchivePresignService,
  ],
})
export class TelemetryArchiveModule {}

function capabilityS3Provider(token: symbol, capability: TelemetryArchiveS3Capability): Provider {
  return {
    provide: token,
    inject: [ConfigService],
    useFactory: (config: ConfigService): AwsTelemetryArchiveClient => {
      const credentialKeys = telemetryArchiveS3CredentialKeys(capability);
      return new AwsTelemetryArchiveClient(
        new S3Client({
          endpoint: telemetryArchiveS3Endpoint(required(config, 'TELEMETRY_ARCHIVE_S3_ENDPOINT')),
          region: required(config, 'TELEMETRY_ARCHIVE_S3_REGION'),
          forcePathStyle: true,
          credentials: {
            accessKeyId: required(config, credentialKeys.accessKey),
            secretAccessKey: required(config, credentialKeys.secretKey),
          },
        }),
      );
    },
  };
}

function capabilityDataSourceProvider(
  token: symbol,
  capability: TelemetryArchiveDatabaseCapability,
): Provider {
  return {
    provide: token,
    inject: [ConfigService],
    useFactory: async (config: ConfigService): Promise<DataSource> => {
      const credentialKeys = telemetryArchiveDatabaseCredentialKeys(capability);
      const port = Number(config.get<string>('DATABASE_PORT', '5432'));
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error('DATABASE_PORT must be a valid TCP port');
      }
      const dataSource = new DataSource({
        type: 'postgres',
        host: required(config, 'DATABASE_HOST'),
        port,
        username: required(config, credentialKeys.username),
        password: required(config, credentialKeys.password),
        database: required(config, 'DATABASE_NAME'),
        ssl: buildDatabaseSslConfig(config),
        synchronize: false,
        migrationsRun: false,
        entities: [],
        extra: { max: 2, connectionTimeoutMillis: 2_000, idleTimeoutMillis: 30_000 },
      });
      return dataSource.initialize();
    },
  };
}

function storeProvider(
  token: symbol,
  clientToken: symbol,
  identity: string,
  capability: 'WRITE' | 'READ' | 'ERASE',
): Provider {
  return {
    provide: token,
    inject: [clientToken],
    useFactory: (client: AwsTelemetryArchiveClient): S3TelemetryArchiveObjectStore =>
      new S3TelemetryArchiveObjectStore(identity, capability, client),
  };
}

function required(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (value === undefined || value.length === 0) {
    throw new Error(`${key} is required when TELEMETRY_ARCHIVE_ENABLED=true`);
  }
  return value;
}
