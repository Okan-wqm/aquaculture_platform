/**
 * E2E Test Fixtures — re-exports for convenient imports.
 *
 * Usage in tests:
 *   import { createTestTenant, createTestUser } from '../fixtures';
 */

export {
  createTestTenant,
  teardownTestTenant,
  createTestTenants,
  teardownTestTenants,
} from './tenant.fixture';
export type {
  TestTenant,
  TestTenantStatus,
  TestTenantPlan,
  CreateTestTenantOptions,
} from './tenant.fixture';

export {
  createTestUser,
  createSuperAdmin,
  createTenantAdmin,
  createModuleManager,
  createModuleUser,
  teardownTestUser,
  createTenantUserSet,
  teardownTenantUserSet,
} from './user.fixture';
export type {
  TestUser,
  CreateTestUserOptions,
  TenantUserSet,
} from './user.fixture';
