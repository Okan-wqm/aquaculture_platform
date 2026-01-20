/**
 * Storage Interfaces
 * @module Storage/Interfaces
 */

/**
 * Configuration for MinIO storage connection
 */
export interface StorageConfig {
  endpoint: string;
  port: number;
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
  /** Full URL to access the file */
  url: string;
  /** Storage path within the bucket */
  path: string;
  /** ETag (hash) of the uploaded file */
  etag: string;
  /** File size in bytes */
  size: number;
  /** Content type of the file */
  contentType: string;
}

/**
 * Metadata about a stored file
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
  /** Content-Disposition header for downloads */
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
export interface StorageModuleAsyncOptions {
  imports?: any[];
  useFactory: (...args: any[]) => Promise<StorageConfig> | StorageConfig;
  inject?: any[];
}
