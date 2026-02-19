---
name: shared-sdk-storage
description: Knowledge base for libs/shared, libs/sdk, and libs/storage - standardized error handling (ApplicationException, ErrorCode), Swagger API decorators, MinIO S3-compatible file storage, and the TypeScript SDK stub
---

# Shared / SDK / Storage Knowledge Base

## Overview

Three cross-cutting libraries used across all NestJS backend services:

- **`libs/shared`** - Standardized error codes, exception classes, global exception filter, and Swagger API response decorators. Imported by every service for consistent HTTP error handling and OpenAPI documentation.
- **`libs/storage`** - MinIO S3-compatible object storage client (`MinioClientService`). Used by any service that needs to store files (documents, images, attachments) with per-tenant path isolation.
- **`libs/sdk`** - TypeScript SDK stub (`libs/sdk/typescript/`). Currently a single `index.ts` entry point with minimal content; intended for external SDK consumers.

## Directory Structure

```
libs/shared/src/
  errors/
    error-codes.ts             # ERROR_CODES constant, ErrorCode and ErrorDefinition types
    application-exception.ts   # ApplicationException and subclass hierarchy
    global-exception.filter.ts # GlobalExceptionFilter - transforms all exceptions to standard format
    index.ts                   # Barrel re-export of all error types
  decorators/
    api-response.decorators.ts # Swagger API response decorators for consistent OpenAPI docs

libs/storage/src/
  minio-client.service.ts      # MinioClientService - core MinIO operations
  storage.module.ts            # StorageModule (DynamicModule, @Global())
  interfaces/
    storage.interfaces.ts      # StorageConfig, UploadResult, FileMetadata, PresignedUrlOptions, UploadOptions

libs/sdk/typescript/src/
  index.ts                     # SDK entry point (stub/minimal)
```

## Key Files & Configurations

### Error Codes (errors/error-codes.ts)

Domain-grouped numeric error codes. Each code maps to an HTTP status and default message:

```typescript
// Domain ranges:
// AUTH    1000-1999
// USER    2000-2999
// TENANT  3000-3999
// BILLING 4000-4999
// FARM    5000-5999
// SENSOR  6000-6999
// VALIDATION 7000-7999
// EXTERNAL   8000-8999
// INTERNAL   9000-9999

export type ErrorDefinition = {
  code: string;           // e.g., 'AUTH_TOKEN_INVALID'
  message: string;        // default message string
  status: HttpStatus;     // HTTP status code
};

export type ErrorCode = keyof typeof ERROR_CODES;

export const ERROR_CODES = {
  // AUTH domain
  AUTH_TOKEN_INVALID: { code: 'AUTH_TOKEN_INVALID', message: '...', status: HttpStatus.UNAUTHORIZED },
  AUTH_TOKEN_EXPIRED: { ... },
  AUTH_INVALID_CREDENTIALS: { ... },
  AUTH_FORBIDDEN: { ... },
  AUTH_ACCOUNT_LOCKED: { ... },
  AUTH_ACCOUNT_INACTIVE: { ... },

  // USER domain
  USER_NOT_FOUND: { code: 'USER_NOT_FOUND', message: '...', status: HttpStatus.NOT_FOUND },
  USER_ALREADY_EXISTS: { ... },
  USER_EMAIL_TAKEN: { ... },

  // TENANT domain
  TENANT_NOT_FOUND: { code: 'TENANT_NOT_FOUND', message: '...', status: HttpStatus.NOT_FOUND },
  TENANT_INACTIVE: { ... },
  TENANT_SUSPENDED: { ... },

  // BILLING domain
  SUBSCRIPTION_NOT_FOUND: { ... },
  SUBSCRIPTION_EXPIRED: { ... },
  SUBSCRIPTION_CANCELLED: { ... },
  INVOICE_NOT_FOUND: { ... },
  PAYMENT_FAILED: { ... },

  // FARM domain
  FARM_NOT_FOUND: { ... },
  BATCH_NOT_FOUND: { ... },
  TANK_NOT_FOUND: { ... },
  POND_NOT_FOUND: { ... },

  // SENSOR domain
  SENSOR_NOT_FOUND: { ... },
  SENSOR_OFFLINE: { ... },

  // VALIDATION
  VALIDATION_FAILED: { code: 'VALIDATION_FAILED', message: '...', status: HttpStatus.BAD_REQUEST },

  // EXTERNAL SERVICE
  EXTERNAL_SERVICE_UNAVAILABLE: { code: 'EXTERNAL_SERVICE_UNAVAILABLE', message: '...', status: HttpStatus.BAD_GATEWAY },
  EXTERNAL_SERVICE_TIMEOUT: { ... },

  // INTERNAL
  INTERNAL_SERVER_ERROR: { code: 'INTERNAL_SERVER_ERROR', message: '...', status: HttpStatus.INTERNAL_SERVER_ERROR },
  ...
};
```

### ApplicationException (errors/application-exception.ts)

Extends `HttpException`. Uses `ErrorCode` for type-safe construction. All exceptions emit the `ErrorResponse` shape.

```typescript
export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    timestamp: string;
    path?: string;
    requestId?: string;
  };
}

export class ApplicationException extends HttpException {
  constructor(
    errorCode: ErrorCode,
    details?: Record<string, unknown>,
    customMessage?: string,
  )

  // Static factories:
  static validation(fields: Record<string, string[]>, message?: string): ApplicationException
  static notFound(resource: string, id?: string): ApplicationException
  static conflict(resource: string, field: string): ApplicationException
  static unauthorized(message?: string): ApplicationException
  static forbidden(message?: string): ApplicationException
  static internal(message?: string, details?: Record<string, unknown>): ApplicationException

  getErrorResponse(): ErrorResponse
}
```

**Subclasses**:

| Class | Purpose |
|-------|---------|
| `BusinessRuleException` | Business logic violations (same constructor signature as `ApplicationException`) |
| `ExternalServiceException` | External service failures; takes `serviceName`, optional `originalError`; defaults to `EXTERNAL_SERVICE_UNAVAILABLE` |
| `ValidationException` | Field-specific validation errors; `fieldErrors: Record<string, string[]>`; static factories `.fromField(field, error)`, `.fromFields(fields)` |

**Usage pattern**:
```typescript
// Specific error code
throw new ApplicationException('TENANT_NOT_FOUND', { tenantId });

// Validation
throw ValidationException.fromField('email', 'Invalid email format');
throw ValidationException.fromFields({ email: 'required', name: ['too short', 'invalid chars'] });

// Business rule
throw new BusinessRuleException('SUBSCRIPTION_CANCELLED');

// External service
throw new ExternalServiceException('stripe', 'PAYMENT_FAILED', originalError);
```

### GlobalExceptionFilter (errors/global-exception.filter.ts)

Applied in each service's `main.ts` via `app.useGlobalFilters(new GlobalExceptionFilter())`.

Intercepts ALL exceptions and formats them as `ErrorResponse`:

1. `ApplicationException` instances: calls `getErrorResponse()`, appends `path` and `requestId`
2. `HttpException` instances: maps status code to error code string (400→`VALIDATION_FAILED`, 401→`AUTH_INVALID_CREDENTIALS`, 403→`AUTH_FORBIDDEN`, 404→`NOT_FOUND`, 409→`CONFLICT`, 429→`RATE_LIMIT_EXCEEDED`, 500→`INTERNAL_SERVER_ERROR`, 502/503→`EXTERNAL_SERVICE_UNAVAILABLE`, 504→`EXTERNAL_SERVICE_TIMEOUT`)
3. Unknown errors: returns `INTERNAL_SERVER_ERROR`; in non-production exposes the actual message

Logging behavior:
- Status >= 500: `logger.error()` with stack trace
- Status 400-499: `logger.warn()` without stack

Reads `x-request-id` header and includes it in the error response for tracing.

### API Response Decorators (decorators/api-response.decorators.ts)

Swagger/OpenAPI decorators for consistent documentation. All use `@nestjs/swagger` primitives.

```typescript
// 200 OK with typed data model
@ApiStandardResponse(UserDto, 'User retrieved successfully')

// 201 Created with typed data model
@ApiCreatedStandardResponse(UserDto)

// 200 OK with paginated array
@ApiPaginatedResponse(BatchDto, 'Batches retrieved')

// Standard 400/401/403/500 error responses (composite decorator)
@ApiStandardErrors()

// 404 Not Found for a named resource
@ApiNotFoundError('User')

// 409 Conflict
@ApiConflictError('Email already exists')
```

**Response envelope shapes**:

Success (`ApiStandardResponse`):
```json
{ "success": true, "data": { ... }, "meta": { "timestamp": "...", "requestId": "..." } }
```

Paginated (`ApiPaginatedResponse`):
```json
{ "success": true, "data": [...], "meta": { "timestamp": "...", "pagination": { "page": 1, "limit": 20, "total": 100, "totalPages": 5, "hasNext": true, "hasPrevious": false } } }
```

Error (`ApiStandardErrors` / `ApiNotFoundError` / `ApiConflictError`):
```json
{ "success": false, "error": { "code": "ERROR_CODE", "message": "...", "details": {}, "timestamp": "...", "path": "...", "requestId": "..." } }
```

### MinioClientService (storage/minio-client.service.ts)

Injectable NestJS service. Wraps the `minio` npm client. Auto-creates the configured bucket on `onModuleInit`.

**File path convention** (tenant-isolated):
```
{tenantId}/{entityType}/{entityId}/{sanitized_filename}
```
Filenames are sanitized: all characters except `[a-zA-Z0-9._-]` are replaced with `_`.

**Methods**:

```typescript
// Upload
uploadFile(tenantId, entityType, entityId, filename, buffer, options?): Promise<UploadResult>
uploadStream(tenantId, entityType, entityId, filename, stream, size, options?): Promise<UploadResult>

// Delete
deleteFile(path: string): Promise<void>                                           // by raw path
deleteFileByContext(tenantId, entityType, entityId, filename): Promise<void>      // by context
deleteEntityFiles(tenantId, entityType, entityId): Promise<number>                // all files for entity

// Download
downloadFile(path: string): Promise<Buffer>
getFileStream(path: string): Promise<Readable>

// Presigned URLs
getPresignedUrl(path, options?: { expirySeconds?, responseContentDisposition? }): Promise<string>   // GET (download)
getPresignedUploadUrl(path, expirySeconds?): Promise<string>                                        // PUT (browser upload)

// Metadata
fileExists(path: string): Promise<boolean>
getFileStats(path: string): Promise<{ size, lastModified, contentType, etag } | null>
listObjects(prefix: string): Promise<Array<{ name, size, lastModified }>>

// Internal helpers
generateFilePath(tenantId, entityType, entityId, filename): string
ensureBucketExists(): Promise<void>
```

`UploadResult` fields: `url` (direct URL), `path` (bucket path), `etag`, `size`, `contentType`.

Custom metadata stored with each upload: `x-amz-meta-tenant-id`, `x-amz-meta-entity-type`, `x-amz-meta-entity-id`.

Content type auto-detected from file extension (pdf, doc, docx, xls, xlsx, png, jpg, gif, svg, txt, csv, json, xml, zip); unknown extensions default to `application/octet-stream`.

Presigned GET URL default expiry: 3600s (1 hour).

### StorageModule (storage/storage.module.ts)

`@Global()` dynamic module. Two configuration patterns:

```typescript
// Static config
StorageModule.forRoot({
  endpoint: 'minio',
  port: 9000,
  useSSL: false,
  accessKey: 'minioadmin',
  secretKey: 'minioadmin',
  bucket: 'aquaculture',
  region: 'us-east-1',
})

// Async config (inject ConfigService etc.)
StorageModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: (config: ConfigService) => ({
    endpoint: config.get('MINIO_ENDPOINT'),
    port: config.get('MINIO_PORT'),
    useSSL: config.get('MINIO_USE_SSL') === 'true',
    accessKey: config.get('MINIO_ACCESS_KEY'),
    secretKey: config.get('MINIO_SECRET_KEY'),
    bucket: config.get('MINIO_BUCKET'),
  }),
  inject: [ConfigService],
})
```

Exports `MinioClientService` only. Since `@Global()`, once registered in the root module, `MinioClientService` is available everywhere without re-importing `StorageModule`.

## Dependencies / Integrations

- **`libs/shared`**: Imported by ALL backend services as `@app/shared`. The `GlobalExceptionFilter` is registered in each service's `main.ts`. `ApplicationException` subclasses are thrown throughout domain service layers.
- **`libs/storage`**: Used by farm-service and other services needing document/attachment storage (batch documents, MSDS sheets, supplier certificates, employee docs). MinIO runs as a container in Docker Compose (service name: `minio`, port 9000).
- **`libs/sdk`**: Minimal/stub at this time. The `libs/sdk/typescript/src/index.ts` is nearly empty. Intended for future external TypeScript SDK consumers but not yet actively developed.
- **MinIO in Docker**: In `docker-compose.infra.yml` and `docker-compose.yml`, MinIO is configured with `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`. Services connect to `http://minio:9000` inside Docker network.
- **`x-request-id` header**: The `GlobalExceptionFilter` reads this header to attach `requestId` to error responses. The gateway-api should inject this header via middleware for end-to-end tracing.

## Known Gotchas

1. **`ErrorCode` must exactly match `ERROR_CODES` key** - `ErrorCode` is `keyof typeof ERROR_CODES`. Passing a string not present in `ERROR_CODES` is a TypeScript compile error. When adding new error codes, add to `ERROR_CODES` first, then use the new key.

2. **`ApplicationException.notFound()` dynamic code lookup** - The static `notFound(resource)` factory tries `${resource.toUpperCase()}_NOT_FOUND` as an `ErrorCode`. If no matching code exists (e.g., `resource = 'CustomEntity'` and `CUSTOMENTITY_NOT_FOUND` is not in `ERROR_CODES`), it falls back to `INTERNAL_SERVER_ERROR` with the custom message. This means the HTTP status becomes 500 instead of 404. Always add specific `_NOT_FOUND` codes for new resources.

3. **`ApplicationException.conflict()` uses `INTERNAL_SERVER_ERROR`** - The static `conflict()` factory hardcodes `INTERNAL_SERVER_ERROR` as the error code, making it a 500 response. This appears to be a bug or placeholder. Throw `new ApplicationException('SOME_CONFLICT_CODE', ...)` directly for proper 409 responses.

4. **`GlobalExceptionFilter` is HTTP-only** - It uses `host.switchToHttp()`. It does NOT handle GraphQL exceptions. NestJS GraphQL services should use a separate `GqlExceptionFilter` or NestJS's built-in GraphQL exception handling. The `GlobalExceptionFilter` registered via `app.useGlobalFilters()` will not catch GraphQL resolver errors.

5. **`StorageModule` is `@Global()`** - Register it exactly once in your root AppModule. If accidentally imported in multiple feature modules, NestJS will warn about duplicate global modules. `MinioClientService` is automatically available in all modules once the root module registers `StorageModule`.

6. **MinIO bucket auto-creation on init** - `MinioClientService.onModuleInit()` calls `ensureBucketExists()`. If the MinIO service is not available at startup, this throws and the NestJS app fails to start. Ensure MinIO is healthy before starting backend services (use `depends_on` with healthcheck in Docker Compose).

7. **File path sanitization only replaces characters, not path segments** - `generateFilePath` sanitizes only the filename portion, not `entityType` or `entityId`. If `entityType` or `entityId` contain `/` characters, they would create unexpected nested paths. Validate inputs before calling storage methods.

8. **Direct URL from `buildFileUrl` vs presigned URL** - `uploadFile` / `uploadStream` return a `url` built via `buildFileUrl()` which constructs `{protocol}://{endpoint}:{port}/{bucket}/{path}`. This is the MinIO internal direct URL, not publicly accessible without MinIO configured for anonymous bucket access. For production use, generate presigned URLs via `getPresignedUrl()` instead of exposing the direct `UploadResult.url`.

9. **`listObjects` uses recursive listing** - `this.client.listObjects(bucket, prefix, true)` with `true` = recursive. This is a streaming API. For large buckets with many objects, this can be slow. The `deleteEntityFiles` method lists all objects before deleting them sequentially, which is O(n) round-trips.

10. **`libs/sdk` is a stub** - Do not import from `@app/sdk` expecting a functional client. The `index.ts` has minimal content. Any SDK-like functionality should be sourced from the specific service's own client or the shared library.

11. **`ValidationException.fromFields` normalizes string values to arrays** - If you pass `{ email: 'required' }` (string, not array), it is converted to `{ email: ['required'] }`. The `fieldErrors` property always stores `Record<string, string[]>`.

12. **`ExternalServiceException` wraps `originalError` in details** - The `originalError.message` is stored in `details.originalMessage`. In production, this message may expose internal service details to API consumers if not filtered. The `GlobalExceptionFilter` does not strip details in production - only the top-level unknown error message is sanitized.
