/**
 * Storage Module
 * Provides MinIO storage services for file upload/download
 * @module Storage
 */
import { Module, DynamicModule, Global, Logger } from '@nestjs/common';
import { MinioClientService, STORAGE_CONFIG } from './minio-client.service';
import {
  DEFAULT_UPLOAD_POLICIES,
  FILE_UPLOAD_POLICIES,
  FileUploadSecurityService,
  type UploadPolicy,
} from './file-upload-security.service';
import { StorageOrphanCleanupService } from './orphan-cleanup.service';
import { StorageConfig, StorageModuleAsyncOptions } from './interfaces/storage.interfaces';

@Global()
@Module({})
export class StorageModule {
  private static registered = false;
  private static readonly logger = new Logger(StorageModule.name);

  private static guardDoubleRegistration(): void {
    if (StorageModule.registered) {
      throw new Error(
        'StorageModule has already been registered. Call forRoot() or forRootAsync() only once in the root AppModule.',
      );
    }
    StorageModule.registered = true;
  }

  /**
   * Configure storage module with static configuration.
   * Must be registered exactly once in the root AppModule (module is @Global).
   */
  static forRoot(
    config: StorageConfig,
    uploadPolicies?: readonly UploadPolicy[],
  ): DynamicModule {
    StorageModule.guardDoubleRegistration();
    return {
      module: StorageModule,
      providers: [
        {
          provide: STORAGE_CONFIG,
          useValue: config,
        },
        {
          provide: FILE_UPLOAD_POLICIES,
          useValue: uploadPolicies ?? DEFAULT_UPLOAD_POLICIES,
        },
        MinioClientService,
        FileUploadSecurityService,
        StorageOrphanCleanupService,
      ],
      exports: [
        MinioClientService,
        FileUploadSecurityService,
        StorageOrphanCleanupService,
        STORAGE_CONFIG,
        FILE_UPLOAD_POLICIES,
      ],
    };
  }

  /**
   * Configure storage module with async configuration.
   * Use this when config depends on other services (e.g., ConfigService).
   * Must be registered exactly once in the root AppModule (module is @Global).
   */
  static forRootAsync(options: StorageModuleAsyncOptions): DynamicModule {
    StorageModule.guardDoubleRegistration();
    return {
      module: StorageModule,
      imports: options.imports || [],
      providers: [
        {
          provide: STORAGE_CONFIG,
          useFactory: options.useFactory,
          inject: options.inject || [],
        },
        {
          provide: FILE_UPLOAD_POLICIES,
          useValue: options.uploadPolicies ?? DEFAULT_UPLOAD_POLICIES,
        },
        MinioClientService,
        FileUploadSecurityService,
        StorageOrphanCleanupService,
      ],
      exports: [
        MinioClientService,
        FileUploadSecurityService,
        StorageOrphanCleanupService,
        STORAGE_CONFIG,
        FILE_UPLOAD_POLICIES,
      ],
    };
  }
}
