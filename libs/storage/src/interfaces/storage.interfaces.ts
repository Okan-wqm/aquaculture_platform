/**
 * Storage Interfaces
 * @module Storage/Interfaces
 */
import type { ModuleMetadata, InjectionToken } from '@nestjs/common';
import type { UploadPolicy } from '../file-upload-security.service';

/**
 * Configuration for MinIO storage connection
 */
export interface StorageConfig {
  endpoint: string;
  /** Port number. Optional — omit for protocol-default ports (80/443). */
  port?: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
}

/**
 * Result of a file upload operation
 */
export interface UploadResult {
  /**
   * @internal Direct MinIO internal URL (e.g., http://minio:9000/...).
   * Not suitable for client-facing use. Use `path` with `getPresignedUrl()` instead.
   */
  internalUrl: string;
  /** Storage path within the bucket — persist this value for later retrieval */
  path: string;
  /** ETag (hash) of the uploaded file */
  etag: string;
  /** File size in bytes */
  size: number;
  /** Content type of the file */
  contentType: string;
}

/**
 * Metadata about a stored file.
 * Returned by `getFileMetadata()` which reads back custom x-amz-meta-* headers.
 */
export interface FileMetadata {
  /** Tenant owning this file */
  tenantId: string;
  /** Type of entity this file belongs to (e.g., 'chemicals', 'suppliers') */
  entityType: string;
  /** ID of the entity this file belongs to */
  entityId: string;
  /** Original filename */
  filename: string;
  /** MIME type */
  contentType: string;
  /** File size in bytes */
  size: number;
  /** User who uploaded the file */
  uploadedBy: string;
  /** Upload timestamp */
  uploadedAt: Date;
}

/**
 * Options for generating presigned URLs
 */
export interface PresignedUrlOptions {
  /** URL expiry time in seconds (default: 3600 = 1 hour) */
  expirySeconds?: number;
  /** Content-Disposition header for downloads (e.g., 'attachment; filename="report.pdf"') */
  responseContentDisposition?: string;
}

/**
 * File upload options
 */
export interface UploadOptions {
  /** Override content type detection */
  contentType?: string;
  /** Custom metadata to store with the file */
  metadata?: Record<string, string>;
}

/**
 * Storage module async options for dynamic configuration
 */
export interface StorageModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  // WHY: NestJS resolves inject[] tokens at runtime and passes them as positional args.
  // The factory signature must accept any resolved type, matching NestJS's own pattern.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory: (...args: any[]) => Promise<StorageConfig> | StorageConfig;
  inject?: InjectionToken[];
  /** Optional upload-policy override. Omitted means the platform default registry. */
  uploadPolicies?: readonly UploadPolicy[];
}
