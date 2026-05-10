/**
 * Storage Module
 * Provides MinIO storage services for file upload/download
 * @module Storage
 */
import { Module, DynamicModule, Global, Logger, Provider } from '@nestjs/common';
import { MinioClientService, STORAGE_CONFIG } from './minio-client.service';
import {
  DEFAULT_UPLOAD_POLICIES,
  FILE_UPLOAD_POLICIES,
  FileUploadSecurityService,
  type UploadPolicy,
} from './file-upload-security.service';
import { StorageOrphanCleanupService } from './orphan-cleanup.service';
import { StorageConfig, StorageModuleAsyncOptions } from './interfaces/storage.interfaces';

/**
 * Build the value provider that satisfies the `FILE_UPLOAD_POLICIES`
 * DI dependency of `FileUploadSecurityService`. Centralised here so
 * both `forRoot` and `forRootAsync` use the same fallback shape:
 * caller-supplied policies win; otherwise the canonical
 * `DEFAULT_UPLOAD_POLICIES` registry from
 * `file-upload-security.service.ts` is wired.
 *
 * Without this provider, NestJS DI would fail at module init —
 * `FileUploadSecurityService` declares the second constructor
 * parameter as `readonly UploadPolicy[]` and TypeScript's
 * decorator-metadata emit reduces array types to the bare `Array`
 * constructor, which the container cannot resolve. The explicit
 * token side-steps that ambiguity.
 */
function buildPoliciesProvider(
  override: readonly UploadPolicy[] | undefined,
): Provider {
  return {
    provide: FILE_UPLOAD_POLICIES,
    useValue: override ?? DEFAULT_UPLOAD_POLICIES,
  };
}

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
   *
   * @param config           MinIO connection configuration.
   * @param uploadPolicies   Optional override for the upload policy
   *                         registry consumed by
   *                         `FileUploadSecurityService`. Omit to use
   *                         the canonical `DEFAULT_UPLOAD_POLICIES`
   *                         table — that path covers every shipping
   *                         document type (chemical, batch, health,
   *                         transport).
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
        buildPoliciesProvider(uploadPolicies),
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
   *
   * The optional `uploadPolicies` field on the options bag overrides
   * the canonical `DEFAULT_UPLOAD_POLICIES` table consumed by
   * `FileUploadSecurityService`. The override stays static (resolved
   * at module boot) — async resolution of the policy table is not
   * needed today; if a tenant-narrowed policy table becomes a
   * requirement the contract can grow a `useUploadPoliciesFactory`
   * sibling without breaking callers.
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
        buildPoliciesProvider(options.uploadPolicies),
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
