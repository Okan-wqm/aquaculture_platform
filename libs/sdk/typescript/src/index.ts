/**
 * Platform SDK
 *
 * Public types for API consumers (mobile app, web shell, external integrators).
 * Re-exports error types and codes from libs/shared for client-side error handling.
 *
 * NOTE(ARCH-HIGH-004): This SDK is currently a placeholder that re-exports shared types.
 * It does not yet contain a generated API client, authentication helpers, or domain-specific
 * DTOs. Future work should consider generating a typed API client from the OpenAPI spec
 * (gateway-api Swagger) and publishing this package so external consumers can import it
 * without depending on internal monorepo paths. Until then, the web shell and mobile app
 * consume the API directly via GraphQL / REST and replicate these types locally.
 */

// Error handling types — re-exported from @platform/shared for client consumers
export type { ErrorResponse } from '@platform/shared';
export { ERROR_CODES } from '@platform/shared';
export type { ErrorCode, ErrorDefinition } from '@platform/shared';

// Storage types (for consumers that interact with upload API responses)
export type { UploadResult, FileMetadata, PresignedUrlOptions } from '@platform/storage';
