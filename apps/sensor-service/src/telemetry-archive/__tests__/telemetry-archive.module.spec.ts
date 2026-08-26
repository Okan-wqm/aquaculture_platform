import { Global, Module } from '@nestjs/common';
import { LegalHoldService } from '@aquaculture/backend-common/compliance';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { NatsRequestReply } from '@platform/event-bus';
import type { DataSource } from 'typeorm';

import type { TelemetryArchiveS3Port } from '../s3-telemetry-archive-object-store.service';
import { TelemetryArchiveCoordinatorService } from '../telemetry-archive-coordinator.service';
import {
  TELEMETRY_ARCHIVE_RUNTIME_TOKENS,
  TelemetryArchiveModule,
  telemetryArchiveDatabaseCredentialKeys,
  telemetryArchiveS3Endpoint,
  telemetryArchiveS3CredentialKeys,
} from '../telemetry-archive.module';

const primaryDataSource: Partial<DataSource> = { query: jest.fn() as DataSource['query'] };
const requestReply = { respond: jest.fn() };

@Global()
@Module({
  providers: [
    { provide: getDataSourceToken(), useValue: primaryDataSource },
    { provide: NatsRequestReply, useValue: requestReply },
    { provide: LegalHoldService, useValue: { assertNoHold: jest.fn(async () => undefined) } },
  ],
  exports: [getDataSourceToken(), NatsRequestReply, LegalHoldService],
})
class TelemetryArchiveTestDependenciesModule {}

describe('TelemetryArchiveModule', () => {
  it('requires a TLS-protected archive endpoint', () => {
    expect(telemetryArchiveS3Endpoint('https://archive.example.test')).toBe(
      'https://archive.example.test/',
    );
    expect(() => telemetryArchiveS3Endpoint('http://minio:9000')).toThrow(/HTTPS/i);
    expect(() => telemetryArchiveS3Endpoint('not-a-url')).toThrow(/endpoint/i);
  });

  it('maps each runtime capability to an explicit deployment credential contract', () => {
    expect(telemetryArchiveS3CredentialKeys('EXPORTER')).toEqual({
      accessKey: 'TELEMETRY_ARCHIVE_EXPORTER_ACCESS_KEY',
      secretKey: 'TELEMETRY_ARCHIVE_EXPORTER_SECRET_KEY',
    });
    expect(telemetryArchiveS3CredentialKeys('VERIFIER')).toEqual({
      accessKey: 'TELEMETRY_ARCHIVE_VERIFIER_ACCESS_KEY',
      secretKey: 'TELEMETRY_ARCHIVE_VERIFIER_SECRET_KEY',
    });
    expect(telemetryArchiveS3CredentialKeys('RESTORE')).toEqual({
      accessKey: 'TELEMETRY_ARCHIVE_RESTORE_ACCESS_KEY',
      secretKey: 'TELEMETRY_ARCHIVE_RESTORE_SECRET_KEY',
    });
    expect(telemetryArchiveS3CredentialKeys('ERASURE')).toEqual({
      accessKey: 'TELEMETRY_ARCHIVE_ERASURE_ACCESS_KEY',
      secretKey: 'TELEMETRY_ARCHIVE_ERASURE_SECRET_KEY',
    });
    expect(telemetryArchiveDatabaseCredentialKeys('RESTORE')).toEqual({
      username: 'TELEMETRY_ARCHIVE_RESTORE_DB_USER',
      password: 'TELEMETRY_ARCHIVE_RESTORE_DB_PASSWORD',
    });
    expect(telemetryArchiveDatabaseCredentialKeys('ERASURE')).toEqual({
      username: 'TELEMETRY_ARCHIVE_ERASURE_DB_USER',
      password: 'TELEMETRY_ARCHIVE_ERASURE_DB_PASSWORD',
    });
  });

  it('constructs the enabled runtime with separate storage and DB capability providers', async () => {
    const capability: Partial<DataSource> = {
      createQueryRunner: jest.fn(),
      destroy: jest.fn(async () => undefined),
    };
    const s3: TelemetryArchiveS3Port = { send: jest.fn(async () => ({})) };
    const configValues: Record<string, string> = {
      TELEMETRY_ARCHIVE_EXPORTER_PRINCIPAL: 'arn:aws:iam::minio:user/telemetry-archive-exporter',
      TELEMETRY_ARCHIVE_VERIFIER_PRINCIPAL: 'arn:aws:iam::minio:user/telemetry-archive-verifier',
      TELEMETRY_ARCHIVE_RESTORE_PRINCIPAL: 'arn:aws:iam::minio:user/telemetry-archive-restore',
      TELEMETRY_ARCHIVE_ERASURE_PRINCIPAL: 'arn:aws:iam::minio:user/telemetry-archive-erasure',
    };
    const config = {
      get: (key: string, fallback?: string): string | undefined => configValues[key] ?? fallback,
    };

    const testingModule = await Test.createTestingModule({
      imports: [TelemetryArchiveTestDependenciesModule, TelemetryArchiveModule],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(TELEMETRY_ARCHIVE_RUNTIME_TOKENS.exporterClient)
      .useValue(s3)
      .overrideProvider(TELEMETRY_ARCHIVE_RUNTIME_TOKENS.verifierClient)
      .useValue(s3)
      .overrideProvider(TELEMETRY_ARCHIVE_RUNTIME_TOKENS.restoreClient)
      .useValue(s3)
      .overrideProvider(TELEMETRY_ARCHIVE_RUNTIME_TOKENS.erasureClient)
      .useValue(s3)
      .overrideProvider(TELEMETRY_ARCHIVE_RUNTIME_TOKENS.provisionerClient)
      .useValue(s3)
      .overrideProvider(TELEMETRY_ARCHIVE_RUNTIME_TOKENS.restoreDataSource)
      .useValue(capability)
      .overrideProvider(TELEMETRY_ARCHIVE_RUNTIME_TOKENS.erasureDataSource)
      .useValue(capability)
      .compile();

    expect(testingModule.get(TelemetryArchiveCoordinatorService)).toBeDefined();
    await testingModule.close();
    expect(capability.destroy).toHaveBeenCalledTimes(2);
  });
});
