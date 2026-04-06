/**
 * Shared test constants — deterministic values for reproducible tests.
 */

/** Standard valid UUID v4 for tests */
export const TEST_TENANT_ID = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
export const TEST_TENANT_SCHEMA = 'tenant_4b529829ea7948da';

/** Second tenant for cross-tenant isolation tests */
export const TEST_TENANT_ID_2 = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
export const TEST_TENANT_SCHEMA_2 = 'tenant_aaaabbbbccccdddd';

/** Standard user IDs */
export const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
export const TEST_ADMIN_ID = '22222222-2222-2222-2222-222222222222';

/** Invalid UUID strings for parameterized boundary tests */
export const INVALID_UUIDS: [string, string][] = [
  ['empty string', ''],
  ['plain string', 'not-a-uuid'],
  ['SQL injection', "'; DROP TABLE users; --"],
  ['partial UUID', '4b529829-ea79'],
  ['path traversal', '../../../etc/passwd'],
];
