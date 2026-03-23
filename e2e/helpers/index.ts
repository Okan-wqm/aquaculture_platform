/**
 * E2E Test Helpers — re-exports for convenient imports.
 *
 * Usage in tests:
 *   import { generateTestToken, GraphQLTestClient, TestDatabase } from '../helpers';
 */

export {
  generateTestToken,
  generateExpiredToken,
  generateTokenWithoutJti,
  generateTokenWithWrongSecret,
  decodeTestToken,
  verifyTestToken,
  generateModuleUserToken,
  generateTenantAdminToken,
  decodeJwt,
  extractResourcePermissions,
  createExpiredJwt,
} from './jwt.helper';
export type { TestRole, TestTokenOptions, TestJwtPayload, RoleTokenOptions } from './jwt.helper';

export {
  GraphQLTestClient,
  UnauthenticatedGraphQLTestClient,
  GraphQLTestError,
  graphqlRequest,
  graphqlQuery,
  graphqlMutation,
} from './graphql-client';
export type {
  GraphQLError,
  GraphQLResponse,
  GraphQLRequestOptions,
} from './graphql-client';

export { RestTestClient, RestTestError } from './rest-client';
export type { RestResponse, RestRequestOptions } from './rest-client';

export { TestDatabase } from './db.helper';
export type { UserRow, TenantRow } from './db.helper';

export {
  generateTenantFixture,
  loginAsSuperAdmin,
  loginAs,
  createTestTenant,
} from './tenant.fixture';
export type { TestTenantFixture } from './tenant.fixture';
