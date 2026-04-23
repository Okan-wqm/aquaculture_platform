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
  type UploadPolicy,
  type SecureUploadRequest,
} from './file-upload-security.service';

// Interfaces
export {
  StorageConfig,
  UploadResult,
  FileMetadata,
  PresignedUrlOptions,
  UploadOptions,
  StorageModuleAsyncOptions,
} from './interfaces/storage.interfaces';
