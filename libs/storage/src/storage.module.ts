/**
 * Storage Module
 * Provides MinIO storage services for file upload/download
 * @module Storage
 */
import { Module, DynamicModule, Global } from '@nestjs/common';
import { MinioClientService, STORAGE_CONFIG } from './minio-client.service';
import { StorageConfig, StorageModuleAsyncOptions } from './interfaces/storage.interfaces';

@Global()
@Module({})
export class StorageModule {
  /**
   * Configure storage module with static configuration
   */
  static forRoot(config: StorageConfig): DynamicModule {
    return {
      module: StorageModule,
      providers: [
        {
          provide: STORAGE_CONFIG,
          useValue: config,
        },
        MinioClientService,
      ],
      exports: [MinioClientService],
    };
  }

  /**
   * Configure storage module with async configuration
   * Use this when config depends on other services (e.g., ConfigService)
   */
  static forRootAsync(options: StorageModuleAsyncOptions): DynamicModule {
    return {
      module: StorageModule,
      imports: options.imports || [],
      providers: [
        {
          provide: STORAGE_CONFIG,
          useFactory: options.useFactory,
          inject: options.inject || [],
        },
        MinioClientService,
      ],
      exports: [MinioClientService],
    };
  }
}
