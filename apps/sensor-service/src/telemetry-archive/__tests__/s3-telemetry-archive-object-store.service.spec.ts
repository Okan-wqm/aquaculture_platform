import {
  S3TelemetryArchiveObjectStore,
  type TelemetryArchiveS3Port,
} from '../s3-telemetry-archive-object-store.service';
import { Readable } from 'stream';

const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const BUCKET = 'aqua-telemetry-22222222222242228222222222222222';
const OBJECT_KEY = '11111111-1111-4111-8111-111111111111.parquet';

describe('S3TelemetryArchiveObjectStore', () => {
  it('allows the exporter to write only to the tenant bucket', async () => {
    const commands: unknown[] = [];
    const client: TelemetryArchiveS3Port = {
      send: jest.fn(async (command) => {
        commands.push(command);
        return { VersionId: 'version-1' };
      }),
    };
    const store = new S3TelemetryArchiveObjectStore('telemetry-archive-exporter', 'WRITE', client);

    await expect(
      store.put({
        tenantId: TENANT_ID,
        bucket: BUCKET,
        objectKey: OBJECT_KEY,
        artifact: {
          path: __filename,
          byteLength: 12,
          sha256: 'a'.repeat(64),
          cleanup: jest.fn(async () => undefined),
        },
      }),
    ).resolves.toEqual({ versionId: 'version-1' });

    expect(commands).toHaveLength(1);
    expect(JSON.stringify(commands[0])).toContain(BUCKET);
    await expect(
      store.put({
        tenantId: TENANT_ID,
        bucket: 'shared-archive',
        objectKey: OBJECT_KEY,
        artifact: {
          path: __filename,
          byteLength: 12,
          sha256: 'a'.repeat(64),
          cleanup: jest.fn(async () => undefined),
        },
      }),
    ).rejects.toThrow(/tenant bucket/i);
    await expect(
      store.get({
        tenantId: TENANT_ID,
        bucket: BUCKET,
        objectKey: OBJECT_KEY,
        versionId: 'version-1',
      }),
    ).rejects.toThrow(/WRITE identity/i);
  });

  it('allows verifier and restore identities to read but never write or delete', async () => {
    const client: TelemetryArchiveS3Port = {
      send: jest.fn(async () => ({ Body: Readable.from([Buffer.from('PAR1dataPAR1')]) })),
    };
    for (const identity of ['telemetry-archive-verifier', 'telemetry-archive-restore']) {
      const store = new S3TelemetryArchiveObjectStore(identity, 'READ', client);
      const downloaded = await store.get({
        tenantId: TENANT_ID,
        bucket: BUCKET,
        objectKey: OBJECT_KEY,
        versionId: 'version-1',
      });
      expect(downloaded.byteLength).toBe(Buffer.byteLength('PAR1dataPAR1'));
      expect(downloaded.sha256).toMatch(/^[0-9a-f]{64}$/);
      await downloaded.cleanup();
      expect(JSON.stringify((client.send as jest.Mock).mock.calls.at(-1)?.[0])).toContain(
        'version-1',
      );
      await expect(
        store.deleteTenantBucket(TENANT_ID, BUCKET, async () => undefined),
      ).rejects.toThrow(/READ identity/i);
    }
  });

  it('uses the erasure identity to delete every object version before the bucket', async () => {
    const commands: string[] = [];
    const client: TelemetryArchiveS3Port = {
      send: jest.fn(async (command) => {
        const name = command.constructor.name;
        commands.push(name);
        if (name === 'ListObjectVersionsCommand') {
          return {
            Versions: [{ Key: OBJECT_KEY, VersionId: 'v1' }],
            DeleteMarkers: [{ Key: OBJECT_KEY, VersionId: 'v2' }],
            IsTruncated: false,
          };
        }
        return {};
      }),
    };
    const store = new S3TelemetryArchiveObjectStore('telemetry-archive-erasure', 'ERASE', client);

    const beforeDestructiveStep = jest.fn(async () => undefined);
    await store.deleteTenantBucket(TENANT_ID, BUCKET, beforeDestructiveStep);

    expect(commands).toEqual([
      'ListObjectVersionsCommand',
      'DeleteObjectsCommand',
      'DeleteBucketCommand',
    ]);
    expect(beforeDestructiveStep).toHaveBeenCalledTimes(2);
  });

  it('refuses to continue when S3 reports per-object delete failures in a 200 response', async () => {
    const commands: string[] = [];
    const client: TelemetryArchiveS3Port = {
      send: jest.fn(async (command) => {
        const name = command.constructor.name;
        commands.push(name);
        if (name === 'ListObjectVersionsCommand') {
          return {
            Versions: [{ Key: OBJECT_KEY, VersionId: 'v1' }],
            IsTruncated: false,
          };
        }
        if (name === 'DeleteObjectsCommand') {
          return { Errors: [{ Key: OBJECT_KEY, VersionId: 'v1', Code: 'AccessDenied' }] };
        }
        return {};
      }),
    };
    const store = new S3TelemetryArchiveObjectStore('telemetry-archive-erasure', 'ERASE', client);

    await expect(
      store.deleteTenantBucket(TENANT_ID, BUCKET, async () => undefined),
    ).rejects.toThrow(/delete.*failed/i);

    expect(commands).toEqual(['ListObjectVersionsCommand', 'DeleteObjectsCommand']);
  });

  it('uses the erasure identity to delete one exact uncommitted object version', async () => {
    const commands: unknown[] = [];
    const client: TelemetryArchiveS3Port = {
      send: jest.fn(async (command) => {
        commands.push(command);
        return {};
      }),
    };
    const store = new S3TelemetryArchiveObjectStore('telemetry-archive-erasure', 'ERASE', client);

    await store.deleteObjectVersion({
      tenantId: TENANT_ID,
      bucket: BUCKET,
      objectKey: OBJECT_KEY,
      versionId: 'version-1',
    });

    expect(commands).toHaveLength(1);
    expect(JSON.stringify(commands[0])).toContain(OBJECT_KEY);
    expect(JSON.stringify(commands[0])).toContain('version-1');
  });
});
