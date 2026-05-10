/**
 * Storage Library
 * Provides MinIO/S3 storage capabilities for file uploads
 * @module Storage
 */

// Module
export { StorageModule } from './storage.module';

// Service
export { MinioClientService, STORAGE_CONFIG } from './minio-client.service';
export {
  FileUploadSecurityService,
  FILE_UPLOAD_POLICIES,
  DEFAULT_UPLOAD_POLICIES,
  type UploadPolicy,
  type SecureUploadRequest,
} from './file-upload-security.service';
export {
  StorageOrphanCleanupService,
  type OrphanCleanupRequest,
  type OrphanCleanupResult,
} from './orphan-cleanup.service';

// Interfaces — type-only re-exports under isolatedModules.
export type {
  StorageConfig,
  UploadResult,
  FileMetadata,
  PresignedUrlOptions,
  UploadOptions,
  StorageModuleAsyncOptions,
} from './interfaces/storage.interfaces';
