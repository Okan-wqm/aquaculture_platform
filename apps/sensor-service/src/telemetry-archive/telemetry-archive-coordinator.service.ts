import { isValidUUID } from '@aquaculture/backend-common/database';

import type { AppendTelemetryArchiveEvent } from './telemetry-archive-lifecycle.service';

const ARCHIVE_SCHEMA_VERSION_CURRENT = 1;
const RESTORE_TTL_SECONDS_MAX = 86_400;

export interface TelemetryRawRow {
  readonly time: string;
  readonly sensorId: string;
  readonly channelId: string;
  readonly tenantId: string;
  readonly rawValue: number;
  readonly value: number;
  readonly qualityCode: number;
  readonly qualityBits: number;
  readonly sourceEventId: string | null;
  readonly sourceTimestamp: string | null;
  readonly sourceSequence: string | null;
  readonly siteId?: string | null;
  readonly departmentId?: string | null;
  readonly systemId?: string | null;
  readonly equipmentId?: string | null;
  readonly tankId?: string | null;
  readonly pondId?: string | null;
  readonly farmId?: string | null;
  readonly sourceProtocol?: string | null;
  readonly ingestionLatencyMs?: number | null;
  readonly batchId?: string | null;
}

export interface TelemetryArchiveManifest {
  readonly operationId: string;
  readonly tenantId: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly objectVersionId: string;
  readonly format: 'PARQUET';
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly rowCount: number;
  readonly minTime: string | null;
  readonly maxTime: string | null;
  readonly schemaVersion: number;
  readonly snapshotId: string;
  readonly walLsn: string;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface TelemetryArchiveSnapshot {
  readonly snapshotId: string;
  readonly walLsn: string;
}

export interface TelemetryParquetSummary {
  readonly rowCount: number;
  readonly minTime: string | null;
  readonly maxTime: string | null;
}

export interface TelemetryParquetInspection extends TelemetryParquetSummary {
  readonly sha256: string;
  readonly format: 'raw-v1';
  readonly schemaVersion: number;
}

export interface TelemetryLocalArchiveObject {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  cleanup(): Promise<void>;
}

export interface TelemetryParquetArtifact
  extends TelemetryLocalArchiveObject,
    TelemetryParquetSummary {}

export interface TelemetryArchiveLifecyclePort {
  append(event: AppendTelemetryArchiveEvent): Promise<string>;
  getManifest(
    operationId: string,
    state: 'EXPORTED' | 'VERIFIED',
  ): Promise<TelemetryArchiveManifest>;
}

export interface TelemetryArchiveErasureEvidence {
  readonly deletedEventCount: number;
  readonly evidenceSha256: string;
}

export interface TelemetryArchiveErasurePort {
  eraseTenantLinks(
    tenantId: string,
    erasureOperationId: string,
  ): Promise<TelemetryArchiveErasureEvidence>;
}

export interface TelemetryArchiveSourcePort {
  capture<T>(
    request: TelemetryArchiveRangeRequest,
    consume: (
      snapshot: TelemetryArchiveSnapshot,
      rows: AsyncIterable<TelemetryRawRow>,
    ) => Promise<T>,
  ): Promise<T>;
}

export interface TelemetryParquetPort {
  encode(rows: AsyncIterable<TelemetryRawRow>): Promise<TelemetryParquetArtifact>;
  inspect(object: TelemetryLocalArchiveObject): Promise<TelemetryParquetInspection>;
  decode(object: TelemetryLocalArchiveObject): AsyncIterable<TelemetryRawRow>;
}

export interface TelemetryArchiveObjectStorePort {
  readonly identity: string;
  put(request: {
    readonly tenantId: string;
    readonly bucket: string;
    readonly objectKey: string;
    readonly artifact: TelemetryLocalArchiveObject;
  }): Promise<{ readonly versionId: string }>;
  get(request: {
    readonly tenantId: string;
    readonly bucket: string;
    readonly objectKey: string;
    readonly versionId: string;
  }): Promise<TelemetryLocalArchiveObject>;
  deleteObjectVersion(request: {
    readonly tenantId: string;
    readonly bucket: string;
    readonly objectKey: string;
    readonly versionId: string;
  }): Promise<void>;
  deleteTenantBucket(
    tenantId: string,
    bucket: string,
    beforeDestructiveStep: () => Promise<void>,
  ): Promise<void>;
}

export interface TelemetryScratchRestoreResult {
  readonly schemaName: string;
  readonly expiresAt: string;
  readonly rowCount: number;
  readonly sha256: string;
  readonly analyticQueriesPassed: boolean;
}

export interface TelemetryScratchRestorePort {
  restore(
    request: {
      readonly tenantId: string;
      readonly operationId: string;
      readonly expectedSha256: string;
      readonly ttlSeconds: number;
    },
    rows: AsyncIterable<TelemetryRawRow>,
  ): Promise<TelemetryScratchRestoreResult>;
}

export interface TelemetryLegalHoldPort {
  assertNoHold(tenantId: string, scope: 'tenant'): Promise<void>;
}

export interface TelemetryTenantCancellationPort {
  assertTenantActive(tenantId: string): Promise<void>;
  cancelTenant(tenantId: string, erasureOperationId: string): Promise<void>;
}

export interface TelemetryPresignRegistryPort {
  revokeTenant(tenantId: string): Promise<void>;
}

export interface TelemetryArchiveClock {
  now(): Date;
}

export interface TelemetryArchiveDependencies {
  lifecycle: TelemetryArchiveLifecyclePort;
  erasure: TelemetryArchiveErasurePort;
  source: TelemetryArchiveSourcePort;
  parquet: TelemetryParquetPort;
  exporterStore: TelemetryArchiveObjectStorePort;
  verifierStore: TelemetryArchiveObjectStorePort;
  restoreStore: TelemetryArchiveObjectStorePort;
  erasureStore: TelemetryArchiveObjectStorePort;
  scratchRestore: TelemetryScratchRestorePort;
  legalHold: TelemetryLegalHoldPort;
  presigns: TelemetryPresignRegistryPort;
  pendingExports: TelemetryTenantCancellationPort;
  clock: TelemetryArchiveClock;
}

export interface TelemetryArchiveRangeRequest {
  readonly operationId: string;
  readonly tenantId: string;
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly schemaVersion: number;
  readonly supersedesOperationId?: string;
}

export interface TelemetryArchiveRestoreRequest {
  readonly operationId: string;
  readonly ttlSeconds: number;
}

export class TelemetryArchiveCoordinatorService {
  constructor(private readonly dependencies: TelemetryArchiveDependencies) {
    this.assertSeparateStorageIdentities();
  }

  async exportRange(request: TelemetryArchiveRangeRequest): Promise<TelemetryArchiveManifest> {
    this.assertRangeRequest(request);
    await this.dependencies.pendingExports.assertTenantActive(request.tenantId);
    await this.dependencies.lifecycle.append({
      operationId: request.operationId,
      tenantId: request.tenantId,
      state: 'EXPORT_STARTED',
      rangeStart: request.rangeStart,
      rangeEnd: request.rangeEnd,
      supersedesOperationId: request.supersedesOperationId,
    });

    try {
      const captured = await this.dependencies.source.capture(request, async (snapshot, rows) => {
        const encoded = await this.dependencies.parquet.encode(rows);
        return { encoded, snapshot };
      });
      try {
        await this.dependencies.pendingExports.assertTenantActive(request.tenantId);
        const bucket = telemetryArchiveBucketName(request.tenantId);
        const objectKey = `${request.operationId}.parquet`;
        const createdAt = this.dependencies.clock.now().toISOString();
        const stored = await this.dependencies.exporterStore.put({
          tenantId: request.tenantId,
          bucket,
          objectKey,
          artifact: captured.encoded,
        });

        const result: TelemetryArchiveManifest = {
          operationId: request.operationId,
          tenantId: request.tenantId,
          bucket,
          objectKey,
          objectVersionId: stored.versionId,
          format: 'PARQUET',
          rangeStart: new Date(request.rangeStart).toISOString(),
          rangeEnd: new Date(request.rangeEnd).toISOString(),
          rowCount: captured.encoded.rowCount,
          minTime: captured.encoded.minTime,
          maxTime: captured.encoded.maxTime,
          schemaVersion: request.schemaVersion,
          snapshotId: captured.snapshot.snapshotId,
          walLsn: captured.snapshot.walLsn,
          sha256: captured.encoded.sha256,
          createdAt,
        };

        try {
          await this.dependencies.lifecycle.append({
            operationId: request.operationId,
            tenantId: request.tenantId,
            state: 'EXPORTED',
            rangeStart: request.rangeStart,
            rangeEnd: request.rangeEnd,
            objectKey,
            rowCount: captured.encoded.rowCount,
            sha256: captured.encoded.sha256,
            schemaVersion: request.schemaVersion,
            snapshotId: captured.snapshot.snapshotId,
            walLsn: captured.snapshot.walLsn,
            bucketName: bucket,
            objectVersionId: stored.versionId,
            archiveFormat: 'PARQUET',
            minTime: captured.encoded.minTime ?? undefined,
            maxTime: captured.encoded.maxTime ?? undefined,
          });
        } catch (ledgerError: unknown) {
          try {
            await this.dependencies.erasureStore.deleteObjectVersion({
              tenantId: request.tenantId,
              bucket,
              objectKey,
              versionId: stored.versionId,
            });
          } catch (compensationError: unknown) {
            throw new AggregateError(
              [ledgerError, compensationError],
              'Telemetry archive ledger transition and object compensation both failed',
            );
          }
          throw ledgerError;
        }
        return result;
      } finally {
        await captured.encoded.cleanup();
      }
    } catch (error: unknown) {
      await this.dependencies.lifecycle.append({
        operationId: request.operationId,
        tenantId: request.tenantId,
        state: 'FAILED',
        rangeStart: request.rangeStart,
        rangeEnd: request.rangeEnd,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async verify(operationId: string): Promise<void> {
    const manifest = await this.dependencies.lifecycle.getManifest(operationId, 'EXPORTED');
    this.assertManifest(manifest);
    const object = await this.dependencies.verifierStore.get({
      tenantId: manifest.tenantId,
      bucket: manifest.bucket,
      objectKey: manifest.objectKey,
      versionId: manifest.objectVersionId,
    });
    try {
      try {
        const inspection = await this.dependencies.parquet.inspect(object);
        if (
          inspection.rowCount !== manifest.rowCount ||
          inspection.minTime !== manifest.minTime ||
          inspection.maxTime !== manifest.maxTime ||
          inspection.sha256 !== manifest.sha256 ||
          inspection.format !== 'raw-v1' ||
          inspection.schemaVersion !== manifest.schemaVersion
        ) {
          throw new Error('Telemetry archive manifest mismatch; VERIFIED transition refused');
        }
      } catch (verificationError: unknown) {
        await this.dependencies.lifecycle.append({
          operationId: manifest.operationId,
          tenantId: manifest.tenantId,
          state: 'FAILED',
          rangeStart: manifest.rangeStart,
          rangeEnd: manifest.rangeEnd,
          errorMessage:
            verificationError instanceof Error
              ? verificationError.message
              : String(verificationError),
        });
        throw verificationError;
      }
      await this.dependencies.lifecycle.append({
        operationId: manifest.operationId,
        tenantId: manifest.tenantId,
        state: 'VERIFIED',
        rangeStart: manifest.rangeStart,
        rangeEnd: manifest.rangeEnd,
        objectKey: manifest.objectKey,
        rowCount: manifest.rowCount,
        sha256: manifest.sha256,
        schemaVersion: manifest.schemaVersion,
        snapshotId: manifest.snapshotId,
        walLsn: manifest.walLsn,
        bucketName: manifest.bucket,
        objectVersionId: manifest.objectVersionId,
        archiveFormat: manifest.format,
        minTime: manifest.minTime ?? undefined,
        maxTime: manifest.maxTime ?? undefined,
      });
    } finally {
      await object.cleanup();
    }
  }

  async restore(request: TelemetryArchiveRestoreRequest): Promise<TelemetryScratchRestoreResult> {
    const manifest = await this.dependencies.lifecycle.getManifest(request.operationId, 'VERIFIED');
    this.assertManifest(manifest);
    if (request.ttlSeconds < 1 || request.ttlSeconds > RESTORE_TTL_SECONDS_MAX) {
      throw new Error(`Restore TTL must be between 1 and ${RESTORE_TTL_SECONDS_MAX} seconds`);
    }
    const object = await this.dependencies.restoreStore.get({
      tenantId: manifest.tenantId,
      bucket: manifest.bucket,
      objectKey: manifest.objectKey,
      versionId: manifest.objectVersionId,
    });
    try {
      if (object.sha256 !== manifest.sha256) {
        throw new Error('Restore object SHA-256 does not match the verified manifest');
      }
      return await this.dependencies.scratchRestore.restore(
        {
          tenantId: manifest.tenantId,
          operationId: manifest.operationId,
          expectedSha256: manifest.sha256,
          ttlSeconds: request.ttlSeconds,
        },
        this.dependencies.parquet.decode(object),
      );
    } finally {
      await object.cleanup();
    }
  }

  async eraseTenantArchive(request: {
    readonly tenantId: string;
    readonly erasureOperationId: string;
  }): Promise<TelemetryArchiveErasureEvidence> {
    if (!isValidUUID(request.tenantId) || !isValidUUID(request.erasureOperationId)) {
      throw new Error('Archive erasure tenantId and operationId must be UUIDs');
    }
    await this.dependencies.legalHold.assertNoHold(request.tenantId, 'tenant');
    await this.dependencies.pendingExports.cancelTenant(
      request.tenantId,
      request.erasureOperationId,
    );
    await this.dependencies.legalHold.assertNoHold(request.tenantId, 'tenant');
    await this.dependencies.presigns.revokeTenant(request.tenantId);
    await this.dependencies.legalHold.assertNoHold(request.tenantId, 'tenant');
    await this.dependencies.erasureStore.deleteTenantBucket(
      request.tenantId,
      telemetryArchiveBucketName(request.tenantId),
      () => this.dependencies.legalHold.assertNoHold(request.tenantId, 'tenant'),
    );
    await this.dependencies.legalHold.assertNoHold(request.tenantId, 'tenant');
    return this.dependencies.erasure.eraseTenantLinks(request.tenantId, request.erasureOperationId);
  }

  private assertSeparateStorageIdentities(): void {
    const identities = new Set([
      this.dependencies.exporterStore.identity,
      this.dependencies.verifierStore.identity,
      this.dependencies.restoreStore.identity,
      this.dependencies.erasureStore.identity,
    ]);
    if (identities.size !== 4) {
      throw new Error(
        'Telemetry exporter, verifier, restore, and erasure identities must be distinct',
      );
    }
  }

  private assertRangeRequest(request: TelemetryArchiveRangeRequest): void {
    if (!isValidUUID(request.operationId) || !isValidUUID(request.tenantId)) {
      throw new Error('Archive operationId and tenantId must be UUIDs');
    }
    if (
      request.supersedesOperationId !== undefined &&
      !isValidUUID(request.supersedesOperationId)
    ) {
      throw new Error('Archive supersedesOperationId must be a UUID');
    }
    const rangeStart = new Date(request.rangeStart);
    const rangeEnd = new Date(request.rangeEnd);
    if (
      !Number.isFinite(rangeStart.getTime()) ||
      !Number.isFinite(rangeEnd.getTime()) ||
      rangeStart >= rangeEnd
    ) {
      throw new Error('Archive range must contain valid timestamps with rangeStart < rangeEnd');
    }
    if (request.schemaVersion !== ARCHIVE_SCHEMA_VERSION_CURRENT) {
      throw new Error(`Archive schemaVersion must be ${ARCHIVE_SCHEMA_VERSION_CURRENT}`);
    }
  }

  private assertManifest(manifest: TelemetryArchiveManifest): void {
    this.assertRangeRequest(manifest);
    if (manifest.format !== 'PARQUET') throw new Error('Raw telemetry archive must use PARQUET');
    if (manifest.bucket !== telemetryArchiveBucketName(manifest.tenantId)) {
      throw new Error('Archive manifest bucket is not isolated to its tenant');
    }
    if (manifest.objectKey !== `${manifest.operationId}.parquet`) {
      throw new Error('Archive manifest object key is not canonical');
    }
    if (manifest.objectVersionId.length === 0 || manifest.objectVersionId.length > 1_024) {
      throw new Error('Archive manifest object version ID is invalid');
    }
    if (!/^[0-9a-f]{64}$/.test(manifest.sha256)) {
      throw new Error('Archive manifest SHA-256 is invalid');
    }
    if (!Number.isSafeInteger(manifest.rowCount) || manifest.rowCount < 0) {
      throw new Error('Archive manifest rowCount must be a non-negative safe integer');
    }
  }
}

export function telemetryArchiveBucketName(tenantId: string): string {
  if (!isValidUUID(tenantId)) throw new Error('Archive bucket tenantId must be a UUID');
  return `aqua-telemetry-${tenantId.replaceAll('-', '')}`;
}
