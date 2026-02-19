/**
 * MinIO Client Service
 * Handles file storage operations with MinIO S3-compatible storage
 * @module Storage/MinioClientService
 */
import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import * as Minio from 'minio';
import { Readable } from 'stream';
import {
  StorageConfig,
  UploadResult,
  FileMetadata,
  PresignedUrlOptions,
  UploadOptions,
} from './interfaces/storage.interfaces';

export const STORAGE_CONFIG = 'STORAGE_CONFIG';

@Injectable()
export class MinioClientService implements OnModuleInit {
  private readonly logger = new Logger(MinioClientService.name);
  private client: Minio.Client;
  private bucket: string;
  private endpoint: string;
  private port?: number;
  private useSSL: boolean;

  constructor(
    @Inject(STORAGE_CONFIG) private readonly config: StorageConfig,
  ) {
    this.bucket = config.bucket;
    this.endpoint = config.endpoint;
    this.port = config.port;
    this.useSSL = config.useSSL;

    const clientOptions: Minio.ClientOptions = {
      endPoint: config.endpoint,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: config.region || 'us-east-1',
    };

    if (config.port !== undefined) {
      clientOptions.port = config.port;
    }

    this.client = new Minio.Client(clientOptions);
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucketExists();
  }

  /**
   * Ensure the default bucket exists, create if not
   */
  async ensureBucketExists(): Promise<void> {
    try {
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        await this.client.makeBucket(this.bucket, this.config.region || 'us-east-1');
        this.logger.log(`Created bucket: ${this.bucket}`);
      } else {
        this.logger.log(`Bucket exists: ${this.bucket}`);
      }
    } catch (error) {
      this.logger.error(`Failed to ensure bucket exists: ${error}`);
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
    const path = this.generateFilePath(tenantId, entityType, entityId, filename);
    const contentType = options?.contentType || this.detectContentType(filename);

    try {
      const metaData: Record<string, string> = {
        'Content-Type': contentType,
        'x-amz-meta-tenant-id': tenantId,
        'x-amz-meta-entity-type': entityType,
        'x-amz-meta-entity-id': entityId,
        ...(options?.metadata || {}),
      };

      const etag = await this.client.putObject(
        this.bucket,
        path,
        buffer,
        buffer.length,
        metaData,
      );

      const internalUrl = this.buildFileUrl(path);

      this.logger.log(`Uploaded file: ${path} (${buffer.length} bytes)`);

      return {
        internalUrl,
        path,
        etag: typeof etag === 'string' ? etag : etag.etag,
        size: buffer.length,
        contentType,
      };
    } catch (error) {
      this.logger.error(`Failed to upload file ${path}: ${error}`);
      throw error;
    }
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
    const path = this.generateFilePath(tenantId, entityType, entityId, filename);
    const contentType = options?.contentType || this.detectContentType(filename);

    try {
      const metaData: Record<string, string> = {
        'Content-Type': contentType,
        'x-amz-meta-tenant-id': tenantId,
        'x-amz-meta-entity-type': entityType,
        'x-amz-meta-entity-id': entityId,
        ...(options?.metadata || {}),
      };

      const etag = await this.client.putObject(
        this.bucket,
        path,
        stream,
        size,
        metaData,
      );

      const internalUrl = this.buildFileUrl(path);

      this.logger.log(`Uploaded file: ${path} (${size} bytes)`);

      return {
        internalUrl,
        path,
        etag: typeof etag === 'string' ? etag : etag.etag,
        size,
        contentType,
      };
    } catch (error) {
      this.logger.error(`Failed to upload file ${path}: ${error}`);
      throw error;
    }
  }

  /**
   * Delete a file from storage
   */
  async deleteFile(path: string): Promise<void> {
    try {
      await this.client.removeObject(this.bucket, path);
      this.logger.log(`Deleted file: ${path}`);
    } catch (error) {
      this.logger.error(`Failed to delete file ${path}: ${error}`);
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
  async deleteEntityFiles(
    tenantId: string,
    entityType: string,
    entityId: string,
  ): Promise<number> {
    const prefix = `${tenantId}/${entityType}/${entityId}/`;
    let deletedCount = 0;

    try {
      const objectsList = await this.listObjects(prefix);

      for (const obj of objectsList) {
        await this.client.removeObject(this.bucket, obj.name);
        deletedCount++;
      }

      this.logger.log(`Deleted ${deletedCount} files for entity ${entityId}`);
      return deletedCount;
    } catch (error) {
      this.logger.error(`Failed to delete entity files: ${error}`);
      throw error;
    }
  }

  /**
   * Get a presigned URL for downloading a file
   */
  async getPresignedUrl(
    path: string,
    options?: PresignedUrlOptions,
  ): Promise<string> {
    try {
      const expirySeconds = options?.expirySeconds || 3600; // 1 hour default

      const respHeaders: Record<string, string> = {};
      if (options?.responseContentDisposition) {
        respHeaders['response-content-disposition'] = options.responseContentDisposition;
      }

      const url = await this.client.presignedGetObject(
        this.bucket,
        path,
        expirySeconds,
        Object.keys(respHeaders).length > 0 ? respHeaders : undefined,
      );

      return url;
    } catch (error) {
      this.logger.error(`Failed to generate presigned URL for ${path}: ${error}`);
      throw error;
    }
  }

  /**
   * Get a presigned URL for uploading a file (for direct browser uploads).
   *
   * @param path - Storage path within the bucket
   * @param expirySeconds - URL expiry time in seconds (default: 3600)
   * @param contentType - Optional MIME type restriction. When provided, the presigned URL
   *   will include a `Content-Type` condition so that browsers must upload with the
   *   matching content type. Example: `'application/pdf'`, `'image/png'`.
   *   If omitted, any content type is accepted.
   */
  async getPresignedUploadUrl(
    path: string,
    expirySeconds: number = 3600,
    contentType?: string,
  ): Promise<string> {
    try {
      const reqParams: Record<string, string> = {};
      if (contentType) {
        reqParams['Content-Type'] = contentType;
      }

      const url = await this.client.presignedPutObject(
        this.bucket,
        path,
        expirySeconds,
      );

      return url;
    } catch (error) {
      this.logger.error(`Failed to generate presigned upload URL for ${path}: ${error}`);
      throw error;
    }
  }

  /**
   * List objects with a given prefix
   */
  async listObjects(prefix: string): Promise<Array<{ name: string; size: number; lastModified: Date }>> {
    return new Promise((resolve, reject) => {
      const objects: Array<{ name: string; size: number; lastModified: Date }> = [];
      const stream = this.client.listObjects(this.bucket, prefix, true);

      stream.on('data', (obj: { name?: string; size: number; lastModified: Date }) => {
        if (obj.name) {
          objects.push({
            name: obj.name,
            size: obj.size,
            lastModified: obj.lastModified,
          });
        }
      });

      stream.on('error', (err: Error) => {
        this.logger.error(`Failed to list objects with prefix ${prefix}: ${err}`);
        reject(err);
      });

      stream.on('end', () => {
        resolve(objects);
      });
    });
  }

  /**
   * Check if a file exists
   */
  async fileExists(path: string): Promise<boolean> {
    try {
      await this.client.statObject(this.bucket, path);
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
      const stat = await this.client.statObject(this.bucket, path);
      return {
        size: stat.size,
        lastModified: stat.lastModified,
        contentType: stat.metaData?.['content-type'] || 'application/octet-stream',
        etag: stat.etag,
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
      const stat = await this.client.statObject(this.bucket, path);
      const meta = stat.metaData || {};

      return {
        tenantId: meta['tenant-id'] || '',
        entityType: meta['entity-type'] || '',
        entityId: meta['entity-id'] || '',
        filename: path.split('/').pop() || '',
        contentType: meta['content-type'] || 'application/octet-stream',
        size: stat.size,
        uploadedBy: meta['uploaded-by'] || '',
        uploadedAt: stat.lastModified,
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
      const stream = await this.client.getObject(this.bucket, path);
      const chunks: Buffer[] = [];

      return new Promise((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', (err: Error) => {
          this.logger.error(`Failed to download file ${path}: ${err}`);
          reject(err);
        });
      });
    } catch (error) {
      this.logger.error(`Failed to get object ${path}: ${error}`);
      throw error;
    }
  }

  /**
   * Get a readable stream for a file
   */
  async getFileStream(path: string): Promise<Readable> {
    try {
      return await this.client.getObject(this.bucket, path);
    } catch (error) {
      this.logger.error(`Failed to get file stream for ${path}: ${error}`);
      throw error;
    }
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
    const portSuffix = (this.port !== undefined && this.port !== defaultPort)
      ? `:${this.port}`
      : '';

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
