/**
 * MinioClientService over @aws-sdk/client-s3 — the command each public method
 * sends, and the contract details the swap from the `minio` client had to keep:
 * bare (unquoted) ETags, bare lowercase user metadata, the presigned upload
 * URL's Content-Type condition, and the internal URL shape.
 *
 * The S3Client constructor is replaced with one that hands back a client whose
 * `send` is a typed jest.fn; every command class stays real, so each assertion
 * narrows the sent value with `instanceof` and reads its typed `input`.
 */
import { Readable } from 'stream';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  PutObjectCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { StorageConfig } from '../interfaces/storage.interfaces';
import { MinioClientService } from '../minio-client.service';

const sendMock = jest.fn<Promise<unknown>, [unknown]>();

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  const FakeS3Client = jest.fn((): { send: typeof sendMock } => ({ send: sendMock }));
  return { ...actual, S3Client: FakeS3Client };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const config: StorageConfig = {
  endpoint: 'minio.internal',
  port: 9000,
  useSSL: false,
  accessKey: 'access',
  secretKey: 'secret',
  bucket: 'files',
  region: 'us-east-1',
};

/** A readable name for whatever was sent, for the narrowing failures above. */
function describeValue(value: unknown): string {
  return typeof value === 'object' && value !== null ? value.constructor.name : typeof value;
}

/** The command at `index` in the send log, narrowed to the class the test expects. */
function sent<T>(ctor: new (...args: never[]) => T, index = -1): T {
  const calls = sendMock.mock.calls;
  const call = calls[index < 0 ? calls.length + index : index];
  if (!call) throw new Error(`S3Client.send call ${index} was not made`);
  const [command] = call;
  if (!(command instanceof ctor)) {
    throw new Error(`expected ${ctor.name}, got ${describeValue(command)}`);
  }
  return command;
}

/** The command handed to getSignedUrl on its `index`-th call, narrowed the same way. */
function signed<T>(ctor: new (...args: never[]) => T, index = 0): { command: T; options: unknown } {
  const call = jest.mocked(getSignedUrl).mock.calls[index];
  if (!call) throw new Error(`getSignedUrl call ${index} was not made`);
  const [, command, options] = call;
  if (!(command instanceof ctor)) {
    throw new Error(`expected ${ctor.name}, got ${describeValue(command)}`);
  }
  return { command, options };
}

describe('MinioClientService (S3 SDK)', () => {
  let service: MinioClientService;

  beforeEach(() => {
    sendMock.mockReset();
    jest.mocked(getSignedUrl).mockReset();
    service = new MinioClientService(config);
  });

  describe('ensureBucketExists', () => {
    it('does nothing when HeadBucket succeeds', async () => {
      sendMock.mockResolvedValueOnce({});
      await service.ensureBucketExists();
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sent(HeadBucketCommand).input).toEqual({ Bucket: 'files' });
    });

    it('creates the bucket when HeadBucket reports 404', async () => {
      sendMock
        .mockRejectedValueOnce(
          new NotFound({ message: 'no bucket', $metadata: { httpStatusCode: 404 } }),
        )
        .mockResolvedValueOnce({});
      await service.ensureBucketExists();
      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(sent(CreateBucketCommand).input).toEqual({ Bucket: 'files' });
    });

    it('rethrows a non-404 HeadBucket failure instead of creating over it', async () => {
      sendMock.mockRejectedValueOnce(
        new S3ServiceException({
          name: 'AccessDenied',
          $fault: 'client',
          $metadata: { httpStatusCode: 403 },
        }),
      );
      await expect(service.ensureBucketExists()).rejects.toThrow();
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('uploads', () => {
    it('uploadFile sends PutObject with bare metadata, content type and length, and returns a bare etag', async () => {
      sendMock.mockResolvedValueOnce({ ETag: '"abc123"' });
      const result = await service.uploadFile('t1', 'batch', 'b1', 'report.pdf', Buffer.from('x'), {
        metadata: { 'x-amz-meta-uploaded-by': 'u1', Source: 'ui' },
      });

      expect(sent(PutObjectCommand).input).toMatchObject({
        Bucket: 'files',
        Key: 't1/batch/b1/report.pdf',
        ContentLength: 1,
        ContentType: 'application/pdf',
        Metadata: {
          'tenant-id': 't1',
          'entity-type': 'batch',
          'entity-id': 'b1',
          'uploaded-by': 'u1',
          source: 'ui',
        },
      });
      expect(result).toEqual({
        internalUrl: 'http://minio.internal:9000/files/t1/batch/b1/report.pdf',
        path: 't1/batch/b1/report.pdf',
        etag: 'abc123',
        size: 1,
        contentType: 'application/pdf',
      });
    });

    it('uploadStream passes the stream through with the caller-declared size', async () => {
      sendMock.mockResolvedValueOnce({ ETag: '"e"' });
      const stream = Readable.from(['data']);
      const result = await service.uploadStream('t1', 'doc', 'd1', 'a b.csv', stream, 4, {
        contentType: 'text/csv',
      });
      expect(sent(PutObjectCommand).input).toMatchObject({
        Key: 't1/doc/d1/a_b.csv',
        Body: stream,
        ContentLength: 4,
        ContentType: 'text/csv',
      });
      expect(result.size).toBe(4);
    });

    it('fails loudly when PutObject returns no ETag', async () => {
      sendMock.mockResolvedValueOnce({});
      await expect(
        service.uploadFile('t1', 'batch', 'b1', 'f.txt', Buffer.from('x')),
      ).rejects.toThrow('PutObject returned no ETag');
    });
  });

  describe('deletes', () => {
    it('deleteFile sends DeleteObject for the key', async () => {
      sendMock.mockResolvedValueOnce({});
      await service.deleteFile('t1/batch/b1/f.txt');
      expect(sent(DeleteObjectCommand).input).toEqual({
        Bucket: 'files',
        Key: 't1/batch/b1/f.txt',
      });
    });

    it('deleteEntityFiles lists the entity prefix and deletes each object', async () => {
      const now = new Date('2026-09-05T00:00:00Z');
      sendMock
        .mockResolvedValueOnce({
          Contents: [
            { Key: 't1/batch/b1/a.txt', Size: 1, LastModified: now },
            { Key: 't1/batch/b1/b.txt', Size: 2, LastModified: now },
          ],
          IsTruncated: false,
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const deleted = await service.deleteEntityFiles('t1', 'batch', 'b1');

      expect(deleted).toBe(2);
      expect(sent(ListObjectsV2Command, 0).input).toMatchObject({
        Bucket: 'files',
        Prefix: 't1/batch/b1/',
      });
      expect(sent(DeleteObjectCommand, 1).input).toEqual({
        Bucket: 'files',
        Key: 't1/batch/b1/a.txt',
      });
      expect(sent(DeleteObjectCommand, 2).input).toEqual({
        Bucket: 'files',
        Key: 't1/batch/b1/b.txt',
      });
    });
  });

  describe('presigned URLs', () => {
    it('getPresignedUrl signs a GetObject with the disposition and expiry', async () => {
      jest.mocked(getSignedUrl).mockResolvedValueOnce('https://signed/get');
      const url = await service.getPresignedUrl('t1/f.pdf', {
        expirySeconds: 60,
        responseContentDisposition: 'attachment; filename="f.pdf"',
      });
      expect(url).toBe('https://signed/get');
      const { command, options } = signed(GetObjectCommand);
      expect(command.input).toEqual({
        Bucket: 'files',
        Key: 't1/f.pdf',
        ResponseContentDisposition: 'attachment; filename="f.pdf"',
      });
      expect(options).toEqual({ expiresIn: 60 });
    });

    it('getPresignedUploadUrl puts the Content-Type into the signed request when given', async () => {
      jest.mocked(getSignedUrl).mockResolvedValueOnce('https://signed/put');
      await service.getPresignedUploadUrl('t1/f.png', 120, 'image/png');
      const { command, options } = signed(PutObjectCommand);
      expect(command.input).toEqual({ Bucket: 'files', Key: 't1/f.png', ContentType: 'image/png' });
      expect(options).toEqual({ expiresIn: 120 });
    });

    it('getPresignedUploadUrl leaves the content type open when none is given', async () => {
      jest.mocked(getSignedUrl).mockResolvedValueOnce('https://signed/put');
      await service.getPresignedUploadUrl('t1/f.bin');
      const { command, options } = signed(PutObjectCommand);
      expect(command.input).toEqual({ Bucket: 'files', Key: 't1/f.bin' });
      expect(options).toEqual({ expiresIn: 3600 });
    });
  });

  describe('reads', () => {
    it('listObjects walks every page and maps Key/Size/LastModified', async () => {
      const t = new Date('2026-09-05T00:00:00Z');
      sendMock
        .mockResolvedValueOnce({
          Contents: [{ Key: 'p/a', Size: 1, LastModified: t }],
          IsTruncated: true,
          NextContinuationToken: 'tok',
        })
        .mockResolvedValueOnce({
          Contents: [{ Key: 'p/b', Size: 2, LastModified: t }],
          IsTruncated: false,
        });

      const objects = await service.listObjects('p/');

      expect(objects).toEqual([
        { name: 'p/a', size: 1, lastModified: t },
        { name: 'p/b', size: 2, lastModified: t },
      ]);
      expect(sent(ListObjectsV2Command, 1).input).toMatchObject({ ContinuationToken: 'tok' });
    });

    it('fileExists is true on HeadObject success and false on failure', async () => {
      sendMock.mockResolvedValueOnce({});
      await expect(service.fileExists('t1/f')).resolves.toBe(true);
      expect(sent(HeadObjectCommand).input).toEqual({ Bucket: 'files', Key: 't1/f' });
      sendMock.mockRejectedValueOnce(
        new NotFound({ message: 'gone', $metadata: { httpStatusCode: 404 } }),
      );
      await expect(service.fileExists('t1/f')).resolves.toBe(false);
    });

    it('getFileStats and getFileMetadata read HeadObject fields with bare keys', async () => {
      const t = new Date('2026-09-05T00:00:00Z');
      const head = {
        ContentLength: 7,
        LastModified: t,
        ContentType: 'text/plain',
        ETag: '"h1"',
        Metadata: {
          'tenant-id': 't1',
          'entity-type': 'batch',
          'entity-id': 'b1',
          'uploaded-by': 'u',
        },
      };
      sendMock.mockResolvedValueOnce(head).mockResolvedValueOnce(head);

      await expect(service.getFileStats('t1/batch/b1/n.txt')).resolves.toEqual({
        size: 7,
        lastModified: t,
        contentType: 'text/plain',
        etag: 'h1',
      });
      await expect(service.getFileMetadata('t1/batch/b1/n.txt')).resolves.toEqual({
        tenantId: 't1',
        entityType: 'batch',
        entityId: 'b1',
        filename: 'n.txt',
        contentType: 'text/plain',
        size: 7,
        uploadedBy: 'u',
        uploadedAt: t,
      });
    });

    it('downloadFile buffers the GetObject body and getFileStream returns it as a stream', async () => {
      sendMock.mockResolvedValueOnce({
        Body: Readable.from([Buffer.from('he'), Buffer.from('llo')]),
      });
      await expect(service.downloadFile('t1/f')).resolves.toEqual(Buffer.from('hello'));
      expect(sent(GetObjectCommand).input).toEqual({ Bucket: 'files', Key: 't1/f' });

      const stream = Readable.from(['x']);
      sendMock.mockResolvedValueOnce({ Body: stream });
      await expect(service.getFileStream('t1/f')).resolves.toBe(stream);
    });

    it('downloadFile fails loudly when GetObject has no body', async () => {
      sendMock.mockResolvedValueOnce({});
      await expect(service.downloadFile('t1/f')).rejects.toThrow('returned no readable body');
    });
  });
});
