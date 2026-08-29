import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CreateBucketCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { isValidUUID } from '@aquaculture/backend-common/database';
import { createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

import {
  telemetryArchiveBucketName,
  type TelemetryLocalArchiveObject,
  type TelemetryArchiveObjectStorePort,
} from './telemetry-archive-coordinator.service';

export type TelemetryArchiveStorageCapability = 'WRITE' | 'READ' | 'ERASE';

export interface TelemetryArchiveS3Port {
  send(command: TelemetryArchiveS3Command): Promise<unknown>;
}

export type TelemetryArchiveS3Command =
  | CreateBucketCommand
  | DeleteBucketCommand
  | DeleteObjectCommand
  | DeleteObjectsCommand
  | GetObjectCommand
  | ListObjectVersionsCommand
  | PutBucketPolicyCommand
  | PutBucketVersioningCommand
  | PutObjectCommand;

export class S3TelemetryArchiveObjectStore implements TelemetryArchiveObjectStorePort {
  constructor(
    readonly identity: string,
    private readonly capability: TelemetryArchiveStorageCapability,
    private readonly client: TelemetryArchiveS3Port,
  ) {
    if (identity.length === 0) throw new Error('Telemetry archive storage identity is required');
  }

  async put(request: {
    readonly tenantId: string;
    readonly bucket: string;
    readonly objectKey: string;
    readonly artifact: TelemetryLocalArchiveObject;
  }): Promise<{ readonly versionId: string }> {
    this.assertCapability('WRITE');
    this.assertLocation(request.tenantId, request.bucket, request.objectKey);
    if (!/^[0-9a-f]{64}$/.test(request.artifact.sha256)) {
      throw new Error('Telemetry archive object SHA-256 is invalid');
    }
    if (!Number.isSafeInteger(request.artifact.byteLength) || request.artifact.byteLength < 8) {
      throw new Error('Telemetry archive object byte length is invalid');
    }
    const response = await this.client.send(
      new PutObjectCommand({
        Bucket: request.bucket,
        Key: request.objectKey,
        Body: createReadStream(request.artifact.path),
        ContentLength: request.artifact.byteLength,
        ContentType: 'application/vnd.apache.parquet',
        Metadata: {
          'tenant-id': request.tenantId,
          sha256: request.artifact.sha256,
          'archive-format': 'raw-v1',
        },
      }),
    );
    if (!isRecord(response)) throw new Error('Telemetry archive upload response is invalid');
    const versionId = optionalString(response['VersionId']);
    if (versionId === undefined) {
      throw new Error('Versioned telemetry archive upload returned no VersionId');
    }
    return { versionId };
  }

  async get(request: {
    readonly tenantId: string;
    readonly bucket: string;
    readonly objectKey: string;
    readonly versionId: string;
  }): Promise<TelemetryLocalArchiveObject> {
    this.assertCapability('READ');
    this.assertLocation(request.tenantId, request.bucket, request.objectKey);
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: request.bucket,
        Key: request.objectKey,
        VersionId: request.versionId,
      }),
    );
    if (!isRecord(response) || !isAsyncByteBody(response['Body'])) {
      throw new Error('Telemetry archive object store returned no readable body');
    }
    const workDirectory = await mkdtemp(join(tmpdir(), 'aqua-telemetry-download-'));
    const objectPath = join(workDirectory, 'telemetry.parquet');
    const hash = createHash('sha256');
    const hashStream = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.from(response['Body']), hashStream, createWriteStream(objectPath));
      const fileStat = await stat(objectPath);
      return {
        path: objectPath,
        byteLength: fileStat.size,
        sha256: hash.digest('hex'),
        cleanup: () => rm(workDirectory, { recursive: true, force: true }),
      };
    } catch (error: unknown) {
      await rm(workDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async deleteObjectVersion(request: {
    readonly tenantId: string;
    readonly bucket: string;
    readonly objectKey: string;
    readonly versionId: string;
  }): Promise<void> {
    this.assertCapability('ERASE');
    this.assertLocation(request.tenantId, request.bucket, request.objectKey);
    if (request.versionId.length === 0 || request.versionId.length > 1_024) {
      throw new Error('Telemetry archive object version ID is invalid');
    }
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: request.bucket,
        Key: request.objectKey,
        VersionId: request.versionId,
      }),
    );
  }

  async deleteTenantBucket(
    tenantId: string,
    bucket: string,
    beforeDestructiveStep: () => Promise<void>,
  ): Promise<void> {
    this.assertCapability('ERASE');
    this.assertTenantBucket(tenantId, bucket);
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      );
      const page = parseVersionPage(response);
      if (page.objects.length > 0) {
        await beforeDestructiveStep();
        const deleteResponse = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: page.objects, Quiet: true },
          }),
        );
        assertDeleteObjectsSucceeded(deleteResponse);
      }
      keyMarker = page.nextKeyMarker;
      versionIdMarker = page.nextVersionIdMarker;
      if (page.isTruncated && keyMarker === undefined) {
        throw new Error('Truncated archive version listing returned no continuation marker');
      }
    } while (keyMarker !== undefined);
    await beforeDestructiveStep();
    await this.client.send(new DeleteBucketCommand({ Bucket: bucket }));
  }

  private assertCapability(expected: TelemetryArchiveStorageCapability): void {
    if (this.capability !== expected) {
      throw new Error(`${this.capability} identity ${this.identity} may not perform ${expected}`);
    }
  }

  private assertLocation(tenantId: string, bucket: string, objectKey: string): void {
    this.assertTenantBucket(tenantId, bucket);
    const operationId = objectKey.endsWith('.parquet') ? objectKey.slice(0, -8) : '';
    if (!isValidUUID(operationId) || objectKey !== `${operationId}.parquet`) {
      throw new Error('Telemetry archive object key must be a canonical operation UUID');
    }
  }

  private assertTenantBucket(tenantId: string, bucket: string): void {
    if (bucket !== telemetryArchiveBucketName(tenantId)) {
      throw new Error('Telemetry archive request is not addressed to its tenant bucket');
    }
  }
}

interface VersionPage {
  readonly objects: Array<{ Key: string; VersionId: string }>;
  readonly isTruncated: boolean;
  readonly nextKeyMarker?: string;
  readonly nextVersionIdMarker?: string;
}

function parseVersionPage(value: unknown): VersionPage {
  if (!isRecord(value)) throw new Error('Archive object version listing is invalid');
  return {
    objects: [
      ...parseObjectVersions(value['Versions']),
      ...parseObjectVersions(value['DeleteMarkers']),
    ],
    isTruncated: value['IsTruncated'] === true,
    nextKeyMarker: optionalString(value['NextKeyMarker']),
    nextVersionIdMarker: optionalString(value['NextVersionIdMarker']),
  };
}

function parseObjectVersions(value: unknown): Array<{ Key: string; VersionId: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Archive object version list is invalid');
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('Archive object version entry is invalid');
    const key = optionalString(entry['Key']);
    const versionId = optionalString(entry['VersionId']);
    if (key === undefined || versionId === undefined) {
      throw new Error('Archive object version entry lacks key or version');
    }
    return { Key: key, VersionId: versionId };
  });
}

function assertDeleteObjectsSucceeded(value: unknown): void {
  if (!isRecord(value)) throw new Error('Archive object delete response is invalid');
  const errors = value['Errors'];
  if (errors === undefined) return;
  if (!Array.isArray(errors)) throw new Error('Archive object delete errors are invalid');
  if (errors.length > 0) {
    throw new Error(`Telemetry archive object delete failed for ${errors.length} version(s)`);
  }
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Archive object store marker must be a non-empty string');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAsyncByteBody(value: unknown): value is AsyncIterable<Uint8Array> {
  if (typeof value !== 'object' || value === null) return false;
  return Symbol.asyncIterator in value;
}
