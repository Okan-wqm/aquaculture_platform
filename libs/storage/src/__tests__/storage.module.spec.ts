/**
 * StorageModule wiring tests.
 *
 * Locks down the architectural fix that turned
 * `FileUploadSecurityService`'s `policies: readonly UploadPolicy[]`
 * dependency from an implicit reflect-metadata `Array` lookup into
 * an explicit `FILE_UPLOAD_POLICIES` DI token wired by
 * `StorageModule.forRoot` / `forRootAsync`.
 *
 * Before the fix, booting any module that imported
 * `StorageModule.forRoot(...)` crashed with:
 *
 *   "Nest can't resolve dependencies of FileUploadSecurityService
 *    (MinioClientService, ?). … argument Array at index [1] is
 *    available in the StorageModule module."
 *
 * because TypeScript's `emitDecoratorMetadata` reduces array types
 * to the bare `Array` constructor; the container had no provider
 * registered under that token.
 *
 * These tests assert that:
 *
 *   1. `forRoot(config)` resolves `FileUploadSecurityService`
 *      without an explicit policy override (the default
 *      `DEFAULT_UPLOAD_POLICIES` table is wired).
 *
 *   2. `forRoot(config, override)` honours the caller-supplied
 *      override — the service's policy lookups reflect the
 *      override registry, not the defaults.
 *
 *   3. `forRootAsync({ ..., uploadPolicies })` mirrors the static
 *      `forRoot` behaviour for the async-config code path
 *      (the path farm-service / gateway-api use in production).
 *
 *   4. The `FILE_UPLOAD_POLICIES` token is exported, so downstream
 *      modules can resolve the wired policy table directly when
 *      they need to introspect or audit it (e.g. admin-api
 *      compliance dashboards).
 *
 * MinIO is replaced with a stub that satisfies the
 * `MinioClientService` constructor + `OnModuleInit` surface — we
 * only care about the DI graph here, not network behaviour.
 */
import { Test } from '@nestjs/testing';

import {
  DEFAULT_UPLOAD_POLICIES,
  FILE_UPLOAD_POLICIES,
  FileUploadSecurityService,
  type UploadPolicy,
} from '../file-upload-security.service';
import { MinioClientService, STORAGE_CONFIG } from '../minio-client.service';
import { StorageModule } from '../storage.module';
import type { StorageConfig } from '../interfaces/storage.interfaces';

const TEST_CONFIG: StorageConfig = {
  endpoint: 'localhost',
  port: 9000,
  useSSL: false,
  accessKey: 'test-key',
  secretKey: 'test-secret',
  bucket: 'test-bucket',
  region: 'us-east-1',
};

const OVERRIDE_POLICIES: readonly UploadPolicy[] = [
  {
    documentType: 'CUSTOM_ONE_OFF_DOCUMENT',
    maxBytes: 1 * 1024 * 1024,
    allowedMime: ['application/pdf'],
  },
];

/**
 * Replace `MinioClientService` with a stub that returns immediately
 * from `onModuleInit`. The real service connects to MinIO; in this
 * test we only exercise DI graph wiring so the network call would
 * be irrelevant noise.
 */
class StubMinioClientService {
  async onModuleInit(): Promise<void> {
    // no-op — tests do not exercise the bucket connection path
  }
}

/**
 * StorageModule.forRoot is `@Global` and guards against
 * double-registration. Each `Test.createTestingModule` creates a
 * separate Nest container, but the static guard lives on the class
 * — reset between tests so each describe-block exercises a clean
 * registration.
 */
function resetRegistrationGuard(): void {
  // The guard is a private static; reaching into it via the
  // bracket form keeps the assertion shape explicit while
  // staying type-safe (no `as any`).
  (StorageModule as unknown as { registered: boolean }).registered = false;
}

describe('StorageModule (DI wiring)', () => {
  beforeEach(() => {
    resetRegistrationGuard();
  });

  describe('forRoot', () => {
    it('resolves FileUploadSecurityService with the default policy registry when no override is supplied', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [StorageModule.forRoot(TEST_CONFIG)],
      })
        .overrideProvider(MinioClientService)
        .useClass(StubMinioClientService)
        .compile();

      const service = moduleRef.get(FileUploadSecurityService);
      expect(service).toBeInstanceOf(FileUploadSecurityService);

      // The default registry is wired: every documentType in
      // DEFAULT_UPLOAD_POLICIES resolves to a policy.
      for (const policy of DEFAULT_UPLOAD_POLICIES) {
        expect(service.getPolicy(policy.documentType)).toEqual(policy);
      }

      // The token is exported for downstream introspection.
      const wiredPolicies = moduleRef.get<readonly UploadPolicy[]>(FILE_UPLOAD_POLICIES);
      expect(wiredPolicies).toBe(DEFAULT_UPLOAD_POLICIES);

      // STORAGE_CONFIG is exported too.
      const wiredConfig = moduleRef.get<StorageConfig>(STORAGE_CONFIG);
      expect(wiredConfig).toEqual(TEST_CONFIG);

      await moduleRef.close();
    });

    it('honours a caller-supplied policy override', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [StorageModule.forRoot(TEST_CONFIG, OVERRIDE_POLICIES)],
      })
        .overrideProvider(MinioClientService)
        .useClass(StubMinioClientService)
        .compile();

      const service = moduleRef.get(FileUploadSecurityService);

      // The override is wired: the override's documentType resolves.
      expect(service.getPolicy('CUSTOM_ONE_OFF_DOCUMENT')).toEqual(
        OVERRIDE_POLICIES[0],
      );

      // Default-registry document types are NOT present — the
      // override completely replaces the registry by design (the
      // caller opts into a tighter / narrower policy set).
      expect(service.getPolicy('HEALTH_CERTIFICATE')).toBeUndefined();

      const wiredPolicies = moduleRef.get<readonly UploadPolicy[]>(FILE_UPLOAD_POLICIES);
      expect(wiredPolicies).toBe(OVERRIDE_POLICIES);

      await moduleRef.close();
    });
  });

  describe('forRootAsync', () => {
    it('resolves FileUploadSecurityService with the default policy registry via async config', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          StorageModule.forRootAsync({
            useFactory: () => TEST_CONFIG,
          }),
        ],
      })
        .overrideProvider(MinioClientService)
        .useClass(StubMinioClientService)
        .compile();

      const service = moduleRef.get(FileUploadSecurityService);
      expect(service).toBeInstanceOf(FileUploadSecurityService);

      // The default-policy fallback fires when uploadPolicies is omitted.
      expect(service.getPolicy('HEALTH_CERTIFICATE')).toBeDefined();
      expect(service.getPolicy('TREATMENT_PHOTO')).toBeDefined();

      const wiredPolicies = moduleRef.get<readonly UploadPolicy[]>(FILE_UPLOAD_POLICIES);
      expect(wiredPolicies).toBe(DEFAULT_UPLOAD_POLICIES);

      await moduleRef.close();
    });

    it('honours uploadPolicies override on the async-options bag', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          StorageModule.forRootAsync({
            useFactory: () => TEST_CONFIG,
            uploadPolicies: OVERRIDE_POLICIES,
          }),
        ],
      })
        .overrideProvider(MinioClientService)
        .useClass(StubMinioClientService)
        .compile();

      const service = moduleRef.get(FileUploadSecurityService);
      expect(service.getPolicy('CUSTOM_ONE_OFF_DOCUMENT')).toEqual(
        OVERRIDE_POLICIES[0],
      );

      // Override replaces the registry — defaults are NOT merged in.
      expect(service.getPolicy('HEALTH_CERTIFICATE')).toBeUndefined();

      const wiredPolicies = moduleRef.get<readonly UploadPolicy[]>(FILE_UPLOAD_POLICIES);
      expect(wiredPolicies).toBe(OVERRIDE_POLICIES);

      await moduleRef.close();
    });
  });
});
