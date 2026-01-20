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
  private port: number;
  private useSSL: boolean;

  constructor(
    @Inject(STORAGE_CONFIG) private readonly config: StorageConfig,
  ) {
    this.bucket = config.bucket;
    this.endpoint = config.endpoint;
    this.port = config.port;
    this.useSSL = config.useSSL;

    this.client = new Minio.Client({
      endPoint: config.endpoint,
      port: config.port,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: config.region || 'us-east-1',
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

      const url = this.buildFileUrl(path);

      this.logger.log(`Uploaded file: ${path} (${buffer.length} bytes)`);

      return {
        url,
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

      const url = this.buildFileUrl(path);

      this.logger.log(`Uploaded file: ${path} (${size} bytes)`);

      return {
        url,
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

      const url = await this.client.presignedGetObject(
        this.bucket,
        path,
        expirySeconds,
      );

      return url;
    } catch (error) {
      this.logger.error(`Failed to generate presigned URL for ${path}: ${error}`);
      throw error;
    }
  }

  /**
   * Get a presigned URL for uploading a file (for direct browser uploads)
   */
  async getPresignedUploadUrl(
    path: string,
    expirySeconds: number = 3600,
  ): Promise<string> {
    try {
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
   * Build the public URL for a file
   */
  private buildFileUrl(path: string): string {
    const protocol = this.useSSL ? 'https' : 'http';
    return `${protocol}://${this.endpoint}:${this.port}/${this.bucket}/${path}`;
  }

  /**
   * Detect content type from filename extension
   */
  private detectContentType(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop();

    const mimeTypes: Record<string, string> = {
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      txt: 'text/plain',
      csv: 'text/csv',
      json: 'application/json',
      xml: 'application/xml',
      zip: 'application/zip',
    };

    return mimeTypes[ext || ''] || 'application/octet-stream';
  }
}
