/**
 * Tenant test-fixture SSoT for E2E integration + workflow specs.
 *
 * This module is the single source of truth for tenant/user/role lifecycle
 * helpers. Two helper families coexist here:
 *
 *  1. Token-based, live-platform helpers (integration specs) — every helper
 *     mirrors a REAL platform operation and is grounded with a file:line
 *     citation in the JSDoc above it. Tenant LIFECYCLE (create/suspend/
 *     activate/teardown) is REST-only in admin-api-service — the auth-service
 *     GraphQL `createTenant`/`suspendTenant`/`activateTenant` resolvers
 *     intentionally throw BadRequestException
 *     (apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts:99-130),
 *     so these helpers call the admin REST API. User/role/myTenant operations
 *     ARE GraphQL on the auth-service subgraph and go through the gateway.
 *
 *  2. `generateTenantFixture` / `TestTenantFixture` — offline fixture used by
 *     the workflow + tenant-admin module specs, which only need a token + ids
 *     without provisioning a live tenant.
 */

import * as crypto from 'crypto';

import { deleteTenantById, getTenantById, getTenantBySlug } from './db.helper';
import {
  graphqlMutation,
  graphqlQuery,
  graphqlRequest,
  type GraphQLResponse,
} from './graphql-client';
import { generateSuperAdminToken, generateTenantAdminToken } from './jwt.helper';
import { RestTestClient } from './rest-client';

// ============================================================================
// Service URLs
// ============================================================================

/**
 * admin-api-service origin. Tenant lifecycle (create/suspend/activate) is
 * REST-only here — there is no GraphQL equivalent. Overridable via env so CI
 * can point at the real service container.
 */
const ADMIN_API_URL =
  process.env['ADMIN_API_URL'] ?? process.env['ADMIN_SERVICE_URL'] ?? 'http://localhost:3008';

/**
 * Default password for seeded super-admin (set by the global-setup fixture via
 * fixtures/user.fixture.ts DEFAULT_PASSWORD_HASH = bcrypt('TestPassword123!')).
 */
const SUPER_ADMIN_EMAIL =
  process.env['E2E_SUPER_ADMIN_EMAIL'] ?? 'e2e-superadmin@test.aquaculture.io';
const SUPER_ADMIN_PASSWORD =
  process.env['E2E_SUPER_ADMIN_PASSWORD'] ?? 'TestPassword123!';

// ============================================================================
// GraphQL response shapes (mirror real auth-service code-first types)
// ============================================================================

/**
 * Nested user object on AuthPayload.
 * Mirrors User entity GraphQL fields
 * (apps/auth-service/src/modules/authentication/entities/user.entity.ts:71-109).
 */
export interface AuthUser {
  id: string;
  email: string;
  role: string;
  tenantId: string | null;
}

/**
 * `login` mutation return type — AuthPayload
 * (apps/auth-service/src/modules/authentication/dto/auth-response.dto.ts:6-58).
 */
export interface LoginResult {
  accessToken: string;
  user: AuthUser;
}

/**
 * `tenantRoles` query item — TenantRole
 * (apps/auth-service/src/modules/tenant/dto/tenant-role.dto.ts:71-108).
 */
export interface TenantRole {
  id: string;
  name: string;
  isDefault: boolean;
  level: number;
}

/**
 * `tenantUsers` query item — User entity (email-bearing subset)
 * (apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts:172-182).
 */
export interface TenantUser {
  id: string;
  email: string;
}

/**
 * `createTenantUser` mutation return type — CreatedTenantUserResult
 * (apps/auth-service/src/modules/tenant/dto/tenant-role.dto.ts:428-450).
 */
export interface CreatedTenantUser {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  roleAssignment: {
    roleId: string;
    roleName: string;
  };
}

/**
 * `myTenant` query return type — Tenant entity (id/name/slug/status subset)
 * (apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts:139-145;
 *  entity fields at .../tenant/entities/tenant.entity.ts).
 */
export interface MyTenant {
  id: string;
  name: string;
  slug: string;
  status: string;
}

// ============================================================================
// Input shapes (mirror real DTOs)
// ============================================================================

/**
 * Subset of CreateTenantDto used by tests
 * (apps/admin-api-service/src/tenant/dto/tenant.dto.ts — `name` required,
 *  `slug`/`contactEmail`/`plan` optional).
 */
export interface CreateTestTenantOverrides {
  name?: string;
  slug?: string;
  contactEmail?: string;
  plan?: string;
}

/**
 * The provisioned tenant returned to integration specs. `.id` is the canonical
 * tenant id (resolved from auth.tenants after the async REST provisioning
 * completes). `.adminToken` is a TENANT_ADMIN token for convenience.
 */
export interface ProvisionedTestTenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  adminToken: string;
}

/**
 * createTenantUser input — subset of CreateTenantUserInput
 * (apps/auth-service/src/modules/tenant/dto/tenant-role.dto.ts:374-423).
 */
export interface CreateTenantUserInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  roleId: string;
  sendInvitation?: boolean;
}

/**
 * createTenantRole input — subset of CreateTenantRoleInput
 * (apps/auth-service/src/modules/tenant/dto/tenant-role.dto.ts:213-245).
 */
export interface CreateTenantRoleInput {
  name: string;
  description?: string;
  level?: number;
  isDefault?: boolean;
  panelPermissions: Record<string, unknown>;
}

/**
 * updateTenantRole input — subset of UpdateTenantRoleInput
 * (apps/auth-service/src/modules/tenant/dto/tenant-role.dto.ts:250-287).
 */
export interface UpdateTenantRoleInput {
  name?: string;
  description?: string;
  level?: number;
  isDefault?: boolean;
  panelPermissions?: Record<string, unknown>;
}

/**
 * REST CreateTenantAcceptedResponse (202 async)
 * (apps/admin-api-service/src/tenant/dto/tenant.dto.ts:376-395).
 */
interface CreateTenantAcceptedResponse {
  status: string;
  tenantStatus?: string;
  statusUrl: string;
  retryAfterMs: number;
  availableActions: string[];
}

// ============================================================================
// Authentication
// ============================================================================

/**
 * Log in via the real `login` GraphQL mutation
 * (apps/auth-service/src/modules/authentication/resolvers/auth.resolver.ts:105-117,
 *  AuthPayload at .../dto/auth-response.dto.ts:6-58).
 */
export async function loginAs(email: string, password: string): Promise<LoginResult> {
  const data = await graphqlMutation<{ login: LoginResult }>(
    `mutation Login($input: LoginInput!) {
      login(input: $input) {
        accessToken
        user { id email role tenantId }
      }
    }`,
    { input: { email, password } },
  );
  return data.login;
}

/**
 * Log in as the seeded platform SUPER_ADMIN and return its access token.
 * Uses the real `login` mutation (same grounding as loginAs) with the
 * super-admin credentials seeded by global-setup.
 */
export async function loginAsSuperAdmin(): Promise<string> {
  const result = await loginAs(SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD);
  return result.accessToken;
}

// ============================================================================
// Tenant lifecycle (admin REST — no GraphQL equivalent exists)
// ============================================================================

/**
 * Create a tenant via the admin REST API and resolve its canonical id.
 *
 * POST /tenants is async (HTTP 202) and returns a CreateTenantAcceptedResponse
 * with a polling statusUrl, NOT the tenant id
 * (apps/admin-api-service/src/tenant/tenant.controller.ts:84-107;
 *  response DTO at .../dto/tenant.dto.ts:376-395). Because the response does
 * not surface the id, the id is resolved from auth.tenants by the slug we
 * chose, via the ground-truth DB read helper getTenantBySlug — after polling
 * the statusUrl until provisioning reaches SUCCEEDED.
 */
export async function createTestTenant(
  superAdminToken: string,
  overrides?: CreateTestTenantOverrides,
): Promise<ProvisionedTestTenant> {
  const rest = new RestTestClient(ADMIN_API_URL, superAdminToken);

  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const name = overrides?.name ?? `E2E Test Tenant ${unique}`;
  const slug = overrides?.slug ?? `e2e-test-${unique}`;
  const contactEmail = overrides?.contactEmail ?? `e2e-${unique}@test.aquaculture.dev`;
  const plan = overrides?.plan ?? 'professional';

  const accepted = await rest.post<CreateTenantAcceptedResponse>('/tenants', {
    name,
    slug,
    contactEmail,
    plan,
  });

  await pollProvisioningComplete(rest, accepted.data.statusUrl);

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    throw new Error(
      `Tenant '${slug}' not found in auth.tenants after provisioning completed`,
    );
  }

  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    plan: tenant.plan,
    adminToken: generateTenantAdminToken({ tenantId: tenant.id }),
  };
}

/**
 * Poll the provisioning status endpoint until the operation reports SUCCEEDED.
 * Mirrors GET {statusUrl} -> CreateTenantAcceptedResponse
 * (apps/admin-api-service/src/tenant/tenant.controller.ts:109-115;
 *  TenantProvisioningState.SUCCEEDED at .../dto/tenant.dto.ts:359-363).
 */
async function pollProvisioningComplete(
  rest: RestTestClient,
  statusUrl: string,
  maxAttempts = 30,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await rest.get<CreateTenantAcceptedResponse>(statusUrl);
    if (status.data.status === 'SUCCEEDED') {
      return;
    }
    if (status.data.status === 'FAILED') {
      throw new Error(`Tenant provisioning failed for ${statusUrl}`);
    }
    await delay(status.data.retryAfterMs > 0 ? status.data.retryAfterMs : 500);
  }
  throw new Error(`Tenant provisioning did not complete after ${maxAttempts} attempts`);
}

/**
 * Suspend a tenant via the admin REST API and return the updated tenant.
 * PATCH /admin/tenants/:id/suspend (requires `reason`)
 * (apps/admin-api-service/src/tenant/tenant.controller.ts:347-356,
 *  SuspendTenantDto at .../dto/tenant.dto.ts:472-477).
 */
export async function suspendTenant(
  superAdminToken: string,
  tenantId: string,
): Promise<{ status: string }> {
  const rest = new RestTestClient(ADMIN_API_URL, superAdminToken);
  const result = await rest.patch<{ status: string }>(
    `/admin/tenants/${tenantId}/suspend`,
    { reason: 'E2E suspension test' },
  );
  return result.data;
}

/**
 * Activate (reactivate) a suspended tenant and return the updated tenant.
 * PATCH /admin/tenants/:id/activate (no body)
 * (apps/admin-api-service/src/tenant/tenant.controller.ts:358-366).
 */
export async function activateTenant(
  superAdminToken: string,
  tenantId: string,
): Promise<{ status: string }> {
  const rest = new RestTestClient(ADMIN_API_URL, superAdminToken);
  const result = await rest.patch<{ status: string }>(
    `/admin/tenants/${tenantId}/activate`,
  );
  return result.data;
}

/**
 * Tear down a provisioned test tenant: drop its schema and remove the
 * auth.tenants row (plus its users) directly via the ground-truth DB helper.
 *
 * The REST archive path (DELETE /admin/tenants/:id) requires a SUSPENDED ->
 * ARCHIVED FSM transition and never PURGES the schema/row, so it is unsuitable
 * for test cleanup. Direct DB teardown is the correct ground-truth reset and
 * matches TestDatabase.deleteTenant (drops schema CASCADE + deletes tenant row;
 * see db.helper.ts:313-321) — wrapped here via the standalone deleteTenant
 * helper so specs need not hold a TestDatabase instance.
 */
export async function teardownTenant(tenantId: string): Promise<void> {
  await teardownTenantById(tenantId);
}

// ============================================================================
// Tenant users (auth-service GraphQL via gateway)
// ============================================================================

/**
 * Create a tenant user via the real `createTenantUser` mutation
 * (apps/auth-service/src/modules/tenant/resolvers/tenant-role.resolver.ts:275-321;
 *  return type CreatedTenantUserResult at .../dto/tenant-role.dto.ts:428-450).
 */
export async function createTenantUser(
  token: string,
  input: CreateTenantUserInput,
): Promise<CreatedTenantUser> {
  const data = await graphqlMutation<{ createTenantUser: CreatedTenantUser }>(
    `mutation CreateTenantUser($input: CreateTenantUserInput!) {
      createTenantUser(input: $input) {
        userId
        email
        firstName
        lastName
        roleAssignment { roleId roleName }
      }
    }`,
    { input },
    { token },
  );
  return data.createTenantUser;
}

/**
 * Delete (deactivate) a tenant user via the real `deleteTenantUser` mutation
 * (apps/auth-service/src/modules/tenant/resolvers/tenant-role.resolver.ts:366-382;
 *  returns Boolean).
 */
export async function deleteTenantUser(token: string, userId: string): Promise<boolean> {
  const data = await graphqlMutation<{ deleteTenantUser: boolean }>(
    `mutation DeleteTenantUser($userId: ID!) {
      deleteTenantUser(userId: $userId)
    }`,
    { userId },
    { token },
  );
  return data.deleteTenantUser;
}

/**
 * Query the current tenant's users via the real `tenantUsers` query, returning
 * the raw GraphQL envelope so specs can assert isolation (errors vs data)
 * (apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts:172-182).
 */
export async function queryTenantUsers(
  token: string,
): Promise<GraphQLResponse<{ tenantUsers: TenantUser[] }>> {
  return graphqlRequest<{ tenantUsers: TenantUser[] }>(
    `query TenantUsers {
      tenantUsers { id email }
    }`,
    {},
    { token },
  );
}

// ============================================================================
// Tenant roles (auth-service GraphQL via gateway)
// ============================================================================

/**
 * Query the current tenant's roles via the real `tenantRoles` query
 * (apps/auth-service/src/modules/tenant/resolvers/tenant-role.resolver.ts:86-94;
 *  TenantRole type with id + isDefault at .../dto/tenant-role.dto.ts:71-108).
 */
export async function getTenantRoles(token: string): Promise<TenantRole[]> {
  const data = await graphqlQuery<{ tenantRoles: TenantRole[] }>(
    `query TenantRoles {
      tenantRoles { id name isDefault level }
    }`,
    {},
    { token },
  );
  return data.tenantRoles;
}

/**
 * Create a custom tenant role via the real `createTenantRole` mutation
 * (apps/auth-service/src/modules/tenant/resolvers/tenant-role.resolver.ts:153-187;
 *  CreateTenantRoleInput at .../dto/tenant-role.dto.ts:213-245).
 */
export async function createTenantRole(
  token: string,
  input: CreateTenantRoleInput,
): Promise<TenantRole> {
  const data = await graphqlMutation<{ createTenantRole: TenantRole }>(
    `mutation CreateTenantRole($input: CreateTenantRoleInput!) {
      createTenantRole(input: $input) {
        id name isDefault level
      }
    }`,
    { input },
    { token },
  );
  return data.createTenantRole;
}

/**
 * Update a tenant role's permissions via the real `updateTenantRole` mutation
 * (apps/auth-service/src/modules/tenant/resolvers/tenant-role.resolver.ts:194-227;
 *  UpdateTenantRoleInput at .../dto/tenant-role.dto.ts:250-287).
 */
export async function updateTenantRole(
  token: string,
  roleId: string,
  input: UpdateTenantRoleInput,
): Promise<TenantRole> {
  const data = await graphqlMutation<{ updateTenantRole: TenantRole }>(
    `mutation UpdateTenantRole($roleId: ID!, $input: UpdateTenantRoleInput!) {
      updateTenantRole(roleId: $roleId, input: $input) {
        id name isDefault level
      }
    }`,
    { roleId, input },
    { token },
  );
  return data.updateTenantRole;
}

// ============================================================================
// Current-tenant query (auth-service GraphQL via gateway)
// ============================================================================

/**
 * Query the current tenant via the real `myTenant` query, returning the raw
 * GraphQL envelope so specs can assert both success and rejection paths
 * (apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts:139-145).
 */
export async function queryMyTenant(
  token: string,
): Promise<GraphQLResponse<{ myTenant: MyTenant }>> {
  return graphqlRequest<{ myTenant: MyTenant }>(
    `query MyTenant {
      myTenant { id name slug status }
    }`,
    {},
    { token },
  );
}

// ============================================================================
// Test data generators
// ============================================================================

/**
 * Generate a unique test email with a stable prefix.
 */
export function generateTestEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@test.aquaculture.dev`;
}

/**
 * Generate a password that satisfies the platform password policy
 * (upper + lower + digit + symbol, length >= 12).
 */
export function generateTestPassword(): string {
  return `Aa1!${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// ============================================================================
// Offline fixture (workflow + tenant-admin module specs)
// ============================================================================

/**
 * Offline test tenant fixture data — tokens + ids without provisioning a live
 * tenant. Consumed by workflow + tenant-admin module specs that only need an
 * authenticated client.
 */
export interface TestTenantFixture {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  adminUserId: string;
  adminToken: string;
  superAdminToken: string;
}

/**
 * Generate fixture data (tokens + ids) for a tenant without creating it.
 * Useful for workflow specs that authenticate a client and exercise read
 * queries without standing up a live tenant.
 */
export function generateTenantFixture(tenantId?: string): TestTenantFixture {
  const id = tenantId ?? crypto.randomUUID();
  const adminUserId = crypto.randomUUID();
  const unique = `${Date.now()}-${id.slice(0, 8)}`;

  return {
    tenantId: id,
    tenantName: `E2E Fixture Tenant ${unique}`,
    tenantSlug: `e2e-fixture-${unique}`,
    adminUserId,
    adminToken: generateTenantAdminToken({ tenantId: id, userId: adminUserId }),
    superAdminToken: generateSuperAdminToken(),
  };
}

// ============================================================================
// Internal teardown (ground-truth DB reset)
// ============================================================================

async function teardownTenantById(tenantId: string): Promise<void> {
  // getTenantById confirms the row exists before we attempt the cascade drop;
  // both reads use the ground-truth DB helpers (no app layer involved).
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return;
  }
  await deleteTenantById(tenantId);
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
