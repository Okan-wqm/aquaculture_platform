/**
 * Storage Module
 * Provides MinIO storage services for file upload/download
 * @module Storage
 */
import { Module, DynamicModule, Global, Logger } from '@nestjs/common';
import { MinioClientService, STORAGE_CONFIG } from './minio-client.service';
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
  static forRoot(config: StorageConfig): DynamicModule {
    StorageModule.guardDoubleRegistration();
    return {
      module: StorageModule,
      providers: [
        {
          provide: STORAGE_CONFIG,
          useValue: config,
        },
        MinioClientService,
      ],
      exports: [MinioClientService, STORAGE_CONFIG],
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
        MinioClientService,
      ],
      exports: [MinioClientService, STORAGE_CONFIG],
    };
  }
}
