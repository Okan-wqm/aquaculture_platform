/**
 * MinIO Client Service
 * Handles file storage operations against the platform's MinIO server over
 * the S3 API, through `@aws-sdk/client-s3`.
 *
 * WHY the AWS SDK and not the `minio` package: `minio@8` pins
 * `stream-json@^1.8` for its bucket-notification stream — an API this
 * platform never calls — and that range carries GHSA-528h-pc64-c93x. The
 * fixed `stream-json` line is ESM-only with a different layout, so `minio`
 * cannot be moved onto it with an override (its package main requires the
 * old CommonJS path eagerly), and no newer `minio` exists. `@aws-sdk/client-s3`
 * was already a dependency (messaging-service's media path) and MinIO speaks
 * S3, so the vulnerable client is replaced rather than the advisory ignored.
 * The class keeps its name: it is still the client of the MinIO server, and
 * every consumer imports it by that name. (SUPPLY-MEDIUM-008)
 *
 * @module Storage/MinioClientService
 */
import { Readable } from 'stream';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';

import {
  StorageConfig,
  UploadResult,
  FileMetadata,
  PresignedUrlOptions,
  UploadOptions,
} from './interfaces/storage.interfaces';

export const STORAGE_CONFIG = 'STORAGE_CONFIG';

/** Default presigned-URL lifetime (seconds). */
const DEFAULT_PRESIGN_EXPIRY_SECONDS = 3600;

/**
 * S3 returns ETags wrapped in double quotes (`"d41d8..."`); the `minio`
 * client stripped them, and `UploadResult.etag` has always been the bare
 * hash that consumers persist. Keep that contract.
 */
function bareEtag(etag: string | undefined, operation: string): string {
  if (etag === undefined) {
    throw new Error(`${operation} returned no ETag`);
  }
  return etag.replace(/^"|"$/g, '');
}

/**
 * S3 user metadata is bare, lowercase keys — the `x-amz-meta-` prefix is a
 * wire detail the SDK adds and strips. The `minio` client accepted either
 * form from callers, so both are still accepted here and normalised to the
 * form `HeadObject` hands back.
 */
function toObjectMetadata(entries: Record<string, string>): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(entries)) {
    const key = rawKey.toLowerCase();
    metadata[key.startsWith('x-amz-meta-') ? key.slice('x-amz-meta-'.length) : key] = value;
  }
  return metadata;
}

function isNotFound(error: unknown): boolean {
  return error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404;
}

/** The message a caught value carries, for the structured error line. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class MinioClientService implements OnModuleInit {
  private readonly logger = new Logger(MinioClientService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;
  private readonly port?: number;
  private readonly useSSL: boolean;

  constructor(@Inject(STORAGE_CONFIG) private readonly config: StorageConfig) {
    this.bucket = config.bucket;
    this.endpoint = config.endpoint;
    this.port = config.port;
    this.useSSL = config.useSSL;

    this.client = new S3Client({
      endpoint: this.buildEndpointUrl(),
      region: config.region || 'us-east-1',
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      // MinIO addresses buckets by path (`/bucket/key`), not by virtual host.
      forcePathStyle: true,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucketExists();
  }

  /**
   * Ensure the default bucket exists, create if not
   */
  async ensureBucketExists(): Promise<void> {
    try {
      if (await this.bucketExists()) {
        this.logger.log(`Bucket exists: ${this.bucket}`);
        return;
      }
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Created bucket: ${this.bucket}`);
    } catch (error) {
      this.logger.error(`Failed to ensure bucket exists: ${describeError(error)}`);
      throw error;
    }
  }

  /**
   * Generate a storage path for a file
   * Format: {tenantId}/{entityType}/{entityId}/{filename}
   */
  generateFilePath(
    tenantId: string,
    entityType: string,
    entityId: string,
    filename: string,
  ): string {
    // Sanitize filename to prevent path traversal
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `${tenantId}/${entityType}/${entityId}/${safeFilename}`;
  }

  /**
   * Upload a file to MinIO storage
   */
  async uploadFile(
    tenantId: string,
    entityType: string,
    entityId: string,
    filename: string,
    buffer: Buffer,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    return this.putObject(tenantId, entityType, entityId, filename, buffer, buffer.length, options);
  }

  /**
   * Upload a file from a readable stream
   */
  async uploadStream(
    tenantId: string,
    entityType: string,
    entityId: string,
    filename: string,
    stream: Readable,
    size: number,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    return this.putObject(tenantId, entityType, entityId, filename, stream, size, options);
  }

  /**
   * Delete a file from storage
   */
  async deleteFile(path: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: path }));
      this.logger.log(`Deleted file: ${path}`);
    } catch (error) {
      this.logger.error(`Failed to delete file ${path}: ${describeError(error)}`);
      throw error;
    }
  }

  /**
   * Delete a file by tenant context
   */
  async deleteFileByContext(
    tenantId: string,
    entityType: string,
    entityId: string,
    filename: string,
  ): Promise<void> {
    const path = this.generateFilePath(tenantId, entityType, entityId, filename);
    await this.deleteFile(path);
  }

  /**
   * Delete all files for an entity
   */
  async deleteEntityFiles(tenantId: string, entityType: string, entityId: string): Promise<number> {
    const prefix = `${tenantId}/${entityType}/${entityId}/`;
    let deletedCount = 0;

    try {
      const objectsList = await this.listObjects(prefix);

      for (const obj of objectsList) {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: obj.name }));
        deletedCount++;
      }

      this.logger.log(`Deleted ${deletedCount} files for entity ${entityId}`);
      return deletedCount;
    } catch (error) {
      this.logger.error(`Failed to delete entity files: ${describeError(error)}`);
      throw error;
    }
  }

  /**
   * Get a presigned URL for downloading a file
   */
  async getPresignedUrl(path: string, options?: PresignedUrlOptions): Promise<string> {
    try {
      const expiresIn = options?.expirySeconds || DEFAULT_PRESIGN_EXPIRY_SECONDS;
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: path,
        ...(options?.responseContentDisposition
          ? { ResponseContentDisposition: options.responseContentDisposition }
          : {}),
      });
      return await getSignedUrl(this.client, command, { expiresIn });
    } catch (error) {
      this.logger.error(`Failed to generate presigned URL for ${path}: ${describeError(error)}`);
      throw error;
    }
  }

  /**
   * Get a presigned URL for uploading a file (for direct browser uploads).
   *
   * @param path - Storage path within the bucket
   * @param expirySeconds - URL expiry time in seconds (default: 3600)
   * @param contentType - Optional MIME type restriction. When provided, the
   *   `Content-Type` is part of the signature, so the browser must upload with
   *   the matching content type or the request is rejected.
   *   Example: `'application/pdf'`, `'image/png'`. If omitted, any content
   *   type is accepted.
   */
  async getPresignedUploadUrl(
    path: string,
    expirySeconds: number = DEFAULT_PRESIGN_EXPIRY_SECONDS,
    contentType?: string,
  ): Promise<string> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: path,
        ...(contentType ? { ContentType: contentType } : {}),
      });
      return await getSignedUrl(this.client, command, { expiresIn: expirySeconds });
    } catch (error) {
      this.logger.error(
        `Failed to generate presigned upload URL for ${path}: ${describeError(error)}`,
      );
      throw error;
    }
  }

  /**
   * List objects with a given prefix
   */
  async listObjects(
    prefix: string,
  ): Promise<Array<{ name: string; size: number; lastModified: Date }>> {
    const objects: Array<{ name: string; size: number; lastModified: Date }> = [];
    try {
      // Explicit continuation loop rather than the SDK paginator: the same
      // request/response shape, one fewer indirection, and nothing that
      // depends on the client's concrete class.
      let continuationToken: string | undefined;
      do {
        const page = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
          }),
        );
        for (const entry of page.Contents ?? []) {
          // A listing entry without a key, size or timestamp is not an object.
          if (
            entry.Key === undefined ||
            entry.Size === undefined ||
            entry.LastModified === undefined
          ) {
            continue;
          }
          objects.push({ name: entry.Key, size: entry.Size, lastModified: entry.LastModified });
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken !== undefined);
      return objects;
    } catch (error) {
      this.logger.error(`Failed to list objects with prefix ${prefix}: ${describeError(error)}`);
      throw error;
    }
  }

  /**
   * Check if a file exists
   */
  async fileExists(path: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: path }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file statistics
   */
  async getFileStats(path: string): Promise<{
    size: number;
    lastModified: Date;
    contentType: string;
    etag: string;
  } | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: path }),
      );
      return {
        size: head.ContentLength ?? 0,
        lastModified: head.LastModified ?? new Date(0),
        contentType: head.ContentType || 'application/octet-stream',
        etag: bareEtag(head.ETag, 'HeadObject'),
      };
    } catch {
      return null;
    }
  }

  /**
   * Get file metadata including custom x-amz-meta-* headers stored during upload
   */
  async getFileMetadata(path: string): Promise<FileMetadata | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: path }),
      );
      const meta = head.Metadata ?? {};

      return {
        tenantId: meta['tenant-id'] || '',
        entityType: meta['entity-type'] || '',
        entityId: meta['entity-id'] || '',
        filename: path.split('/').pop() || '',
        contentType: head.ContentType || 'application/octet-stream',
        size: head.ContentLength ?? 0,
        uploadedBy: meta['uploaded-by'] || '',
        uploadedAt: head.LastModified ?? new Date(0),
      };
    } catch {
      return null;
    }
  }

  /**
   * Download a file as a buffer
   */
  async downloadFile(path: string): Promise<Buffer> {
    try {
      const body = await this.getObjectBody(path);
      return await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        body.on('data', (chunk: Buffer) => chunks.push(chunk));
        body.on('end', () => resolve(Buffer.concat(chunks)));
        body.on('error', reject);
      });
    } catch (error) {
      this.logger.error(`Failed to download file ${path}: ${describeError(error)}`);
      throw error;
    }
  }

  /**
   * Get a readable stream for a file
   */
  async getFileStream(path: string): Promise<Readable> {
    try {
      return await this.getObjectBody(path);
    } catch (error) {
      this.logger.error(`Failed to get file stream for ${path}: ${describeError(error)}`);
      throw error;
    }
  }

  /**
   * The one PutObject call behind uploadFile and uploadStream: the same
   * metadata contract, the same result shape.
   */
  private async putObject(
    tenantId: string,
    entityType: string,
    entityId: string,
    filename: string,
    body: Buffer | Readable,
    size: number,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    const path = this.generateFilePath(tenantId, entityType, entityId, filename);
    const contentType = options?.contentType || this.detectContentType(filename);

    try {
      const output = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: path,
          Body: body,
          ContentLength: size,
          ContentType: contentType,
          Metadata: toObjectMetadata({
            'tenant-id': tenantId,
            'entity-type': entityType,
            'entity-id': entityId,
            ...(options?.metadata || {}),
          }),
        }),
      );

      this.logger.log(`Uploaded file: ${path} (${size} bytes)`);

      return {
        internalUrl: this.buildFileUrl(path),
        path,
        etag: bareEtag(output.ETag, 'PutObject'),
        size,
        contentType,
      };
    } catch (error) {
      this.logger.error(`Failed to upload file ${path}: ${describeError(error)}`);
      throw error;
    }
  }

  /**
   * GetObject whose body is a Node stream — the only shape the SDK produces
   * on Node, and the one both download paths need. A body of any other shape
   * (or none) is a contract violation, not a case to paper over.
   */
  private async getObjectBody(path: string): Promise<Readable> {
    const output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: path }));
    const body = output.Body;
    if (!(body instanceof Readable)) {
      throw new Error(`GetObject for ${path} returned no readable body`);
    }
    return body;
  }

  private async bucketExists(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw error;
    }
  }

  /** `http(s)://endpoint[:port]` — the S3 endpoint the client signs requests for. */
  private buildEndpointUrl(): string {
    const protocol = this.useSSL ? 'https' : 'http';
    const portSuffix = this.port !== undefined ? `:${this.port}` : '';
    return `${protocol}://${this.endpoint}${portSuffix}`;
  }

  /**
   * Build the internal URL for a file.
   * Note: This produces a MinIO-internal URL, not suitable for client-facing use.
   * Use getPresignedUrl() for client-accessible download links.
   */
  private buildFileUrl(path: string): string {
    const protocol = this.useSSL ? 'https' : 'http';
    const defaultPort = this.useSSL ? 443 : 80;

    // Omit port from URL when it matches the protocol default
    const portSuffix = this.port !== undefined && this.port !== defaultPort ? `:${this.port}` : '';

    return `${protocol}://${this.endpoint}${portSuffix}/${this.bucket}/${path}`;
  }

  /**
   * Detect content type from filename extension.
   *
   * Returns 'application/octet-stream' as a safe fallback for unknown extensions.
   * A debug log is emitted on fallback to aid development-time diagnostics; in
   * production the log level is filtered out by default so performance is unaffected.
   *
   * NOTE(ARCH-LOW-004): If you upload files with extensions not listed here you will
   * receive the generic fallback type. Add new entries to `mimeTypes` below following
   * the existing pattern rather than relying on the fallback in production.
   */
  private detectContentType(filename: string): string {
    // Handle compound extensions like .tar.gz before splitting on the last dot
    const lowerFilename = filename.toLowerCase();
    if (lowerFilename.endsWith('.tar.gz')) {
      return 'application/gzip';
    }
    if (lowerFilename.endsWith('.tar.bz2')) {
      return 'application/x-bzip2';
    }

    const ext = lowerFilename.split('.').pop();

    const mimeTypes: Record<string, string> = {
      // Documents
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      // Images
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      webp: 'image/webp',
      // Text / data
      txt: 'text/plain',
      csv: 'text/csv',
      tsv: 'text/tab-separated-values',
      json: 'application/json',
      xml: 'application/xml',
      // Archives / binary
      zip: 'application/zip',
      gz: 'application/gzip',
      tar: 'application/x-tar',
      bz2: 'application/x-bzip2',
      // Misc
      html: 'text/html',
      htm: 'text/html',
    };

    const resolved = mimeTypes[ext || ''];
    if (!resolved) {
      this.logger.debug(
        `detectContentType: unknown extension "${ext}" for file "${filename}", ` +
          `falling back to application/octet-stream`,
      );
      return 'application/octet-stream';
    }
    return resolved;
  }
}
