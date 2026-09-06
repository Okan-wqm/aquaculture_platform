/**
 * Header Spoofing Prevention Tests
 *
 * Verifies that attackers cannot bypass security by spoofing internal headers:
 * - x-user-payload from external request is stripped or ignored
 * - x-tenant-id mismatch with JWT uses JWT's tenantId (trusted source)
 */

import { test, expect } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';

import { GraphQLTestClient } from '../../helpers/graphql-client';
import { issueTestToken, issueModuleUserToken } from '../../helpers/persisted-actor.fixture';

/** Response types (zero any policy) */
interface MeResponse {
  me: {
    id: string;
    email: string;
    role?: string;
    roles?: string[];
  } | null;
}

interface CurrentUserResponse {
  currentUser: {
    id: string;
    email: string;
    role?: string;
  } | null;
}

interface MyTenantResponse {
  myTenant: {
    id: string;
    name: string;
  } | null;
}

const REAL_TENANT_ID = uuidv4();
const SPOOFED_TENANT_ID = uuidv4();
const REAL_USER_ID = uuidv4();
const SPOOFED_USER_ID = uuidv4();

test.describe('Header Spoofing Prevention', () => {
  let client: GraphQLTestClient;

  test.beforeEach(({ request }) => {
    client = new GraphQLTestClient(request);
  });

  test('x-user-payload from external request does not override JWT identity', async () => {
    // Generate a MODULE_USER token with legitimate identity
    const legitimateToken = await issueModuleUserToken({
      sub: REAL_USER_ID,
      tenantId: REAL_TENANT_ID,
      email: 'legitimate@company.com',
    });

    // Craft a spoofed x-user-payload header with SUPER_ADMIN role
    const spoofedPayload = JSON.stringify({
      sub: SPOOFED_USER_ID,
      email: 'hacker@evil.com',
      tenantId: SPOOFED_TENANT_ID,
      roles: ['SUPER_ADMIN'],
      role: 'SUPER_ADMIN',
      type: 'access',
    });

    // Send request with valid JWT + spoofed x-user-payload header
    const response = await client.query<MeResponse>(
      `query { me: currentUser { id email } }`,
      {},
      {
        token: legitimateToken,
        extraHeaders: {
          'x-user-payload': spoofedPayload,
          'x-user-id': SPOOFED_USER_ID,
          'x-user-roles': JSON.stringify(['SUPER_ADMIN']),
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data?.me?.id).toBe(REAL_USER_ID);
  });

  test('x-tenant-id mismatch with JWT uses JWT value for tenant-scoped queries', async () => {
    // Generate a token for the real tenant
    const realTenantToken = await issueTestToken({
      sub: uuidv4(),
      tenantId: REAL_TENANT_ID,
      email: 'user@real-tenant.com',
      roles: ['TENANT_ADMIN'],
      role: 'TENANT_ADMIN',
    });

    // Send the request with mismatched X-Tenant-Id header
    const response = await client.query<MyTenantResponse>(
      `query { myTenant { id name } }`,
      {},
      {
        token: realTenantToken,
        tenantId: SPOOFED_TENANT_ID, // Different from JWT's tenantId
      },
    );

    // Two acceptable outcomes:
    // 1. TenantGuard rejects with 403 (tenantId mismatch)
    // 2. Query succeeds using JWT's tenantId (myTenant uses @CurrentUser('tenantId'))
    //
    // Unacceptable: returning SPOOFED_TENANT_ID's data

    if (response.body.errors && response.body.errors.length > 0) {
      // If errors, should be about tenant mismatch/forbidden
      const isTenantError = response.body.errors.some(
        (e) =>
          e.message.includes('does not belong') ||
          e.message.includes('Access denied') ||
          e.message.includes('Forbidden') ||
          e.message.includes('tenant') ||
          e.extensions?.code === 'FORBIDDEN',
      );
      expect(isTenantError).toBe(true);
    } else {
      // If successful, must return data for the JWT's tenant
      // myTenant uses @CurrentUser('tenantId') which comes from JWT
      expect(response.body.data?.myTenant?.id).toBe(REAL_TENANT_ID);
    }
  });

  test('Forged x-user-id header does not change authenticated user context', async () => {
    // Generate a token with known user ID
    const token = await issueTestToken({
      sub: REAL_USER_ID,
      tenantId: REAL_TENANT_ID,
      email: 'real@company.com',
      roles: ['MODULE_USER'],
    });

    // Attempt to forge user ID via header
    const response = await client.query<CurrentUserResponse>(
      `query { currentUser { id email } }`,
      {},
      {
        token,
        extraHeaders: {
          'x-user-id': SPOOFED_USER_ID,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data?.currentUser?.id).toBe(REAL_USER_ID);
  });
});
