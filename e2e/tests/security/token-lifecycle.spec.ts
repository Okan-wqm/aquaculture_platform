/**
 * Token Lifecycle Security Tests
 *
 * Verifies JWT token security controls:
 * - Expired tokens are rejected with 401
 * - Tampered/wrong-secret tokens are rejected
 * - Tokens without jti are rejected (production mode)
 * - Tokens with wrong audience are rejected
 */

import { test, expect } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';
import { createTestTenant } from '../../fixtures/tenant.fixture';
import { createTestUser } from '../../fixtures/user.fixture';
import { TestDatabase } from '../../helpers/db.helper';
import { FIXTURE_PASSWORD } from '../../helpers/real-auth.fixture';

import { GraphQLTestClient, GraphQLError } from '../../helpers/graphql-client';
import {
  generateExpiredToken,
  generateTokenWithoutJti,
  generateTokenWithWrongAudience,
  generateTokenWithWrongSecret,
} from '../../helpers/jwt.helper';

/** Response types (zero any policy) */
interface MeResponse {
  me: {
    id: string;
    email: string;
  } | null;
}

interface CurrentUserResponse {
  currentUser: {
    id: string;
    email: string;
  } | null;
}

/**
 * Helper: assert that a response indicates unauthorized access
 */
function expectUnauthorized(errors: GraphQLError[] | undefined, status: number): void {
  const isUnauthorizedStatus = status === 401;
  const hasForbiddenStatus = status === 403;
  const hasAuthError =
    errors?.some(
      (e) =>
        e.message.includes('Unauthorized') ||
        e.message.includes('Authentication') ||
        e.message.includes('Invalid') ||
        e.message.includes('expired') ||
        e.message.includes('token') ||
        e.message.includes('Authorization') ||
        e.extensions?.code === 'UNAUTHENTICATED' ||
        e.extensions?.code === 'UNAUTHORIZED' ||
        e.extensions?.code === 'FORBIDDEN',
    ) ?? false;

  expect(
    isUnauthorizedStatus || hasForbiddenStatus || hasAuthError,
    `Expected unauthorized response. Status: ${status}, Errors: ${JSON.stringify(errors)}`,
  ).toBe(true);
}

/** Simple authenticated query to test token validity */
const ME_QUERY = `query { me: currentUser { id email } }`;
const CURRENT_USER_QUERY = `query { currentUser { id email } }`;

test.describe('Token Security', () => {
  let client: GraphQLTestClient;

  test.beforeEach(({ request }) => {
    client = new GraphQLTestClient(request);
  });

  test('Expired token is rejected with 401', async () => {
    const expiredToken = generateExpiredToken({
      tenantId: uuidv4(),
      email: 'expired@test.com',
    });

    const response = await client.query<MeResponse>(ME_QUERY, {}, { token: expiredToken });

    // Expired token must be rejected
    expectUnauthorized(response.body.errors, response.status);

    // No user data should be returned
    if (response.body.data) {
      expect(response.body.data.me).toBeNull();
    }
  });

  test('Tampered token (wrong secret) is rejected', async () => {
    const tamperedToken = generateTokenWithWrongSecret({
      tenantId: uuidv4(),
      email: 'tampered@test.com',
      roles: ['SUPER_ADMIN'],
    });

    const response = await client.query<MeResponse>(ME_QUERY, {}, { token: tamperedToken });

    // Token signed with wrong secret must be rejected
    expectUnauthorized(response.body.errors, response.status);

    // No user data should be returned
    if (response.body.data) {
      expect(response.body.data.me).toBeNull();
    }
  });

  test('Token without jti is rejected', async () => {
    // In production mode, tokens without jti should be rejected
    // In development mode, they may be allowed but logged
    const noJtiToken = generateTokenWithoutJti({
      tenantId: uuidv4(),
      email: 'nojti@test.com',
    });

    const response = await client.query<CurrentUserResponse>(
      CURRENT_USER_QUERY,
      {},
      { token: noJtiToken },
    );

    expectUnauthorized(response.body.errors, response.status);

  });

  test('Token with wrong audience is rejected', async () => {
    const wrongAudToken = generateTokenWithWrongAudience({
      tenantId: uuidv4(),
      email: 'wrongaud@test.com',
    });

    const response = await client.query<MeResponse>(ME_QUERY, {}, { token: wrongAudToken });

    expectUnauthorized(response.body.errors, response.status);

  });

  test('real login and bookkeeping preserve access; deactivation rejects the prior session and new login', async ({ request }) => {
    const db = new TestDatabase();
    try {
      const tenant = await createTestTenant(db);
      const user = await createTestUser(db, { tenantId: tenant.id });
      const before = await client.query<CurrentUserResponse>(CURRENT_USER_QUERY, {}, { token: user.token });
      expect(before.status).toBe(200);
      expect(before.body.errors).toBeUndefined();
      expect(before.body.data?.currentUser?.id).toBe(user.id);
      await db.query('UPDATE auth.users SET "lastLoginAt" = CURRENT_TIMESTAMP, "failedLoginAttempts" = 0 WHERE id = $1', [user.id]);
      const bookkeeping = await client.query<CurrentUserResponse>(CURRENT_USER_QUERY, {}, { token: user.token });
      expect(bookkeeping.body.errors).toBeUndefined();
      expect(bookkeeping.body.data?.currentUser?.id).toBe(user.id);
      await db.query('UPDATE auth.users SET "isActive" = false WHERE id = $1', [user.id]);
      const after = await client.query<CurrentUserResponse>(CURRENT_USER_QUERY, {}, { token: user.token });
      expectUnauthorized(after.body.errors, after.status);
      expect(after.body.data?.currentUser).toBeFalsy();
      const denied = await request.post('/graphql', {
        data: { query: 'mutation Login($input: LoginInput!) { login(input: $input) { accessToken } }',
          variables: { input: { email: user.email, password: FIXTURE_PASSWORD } } },
      });
      const deniedBody: { data?: { login?: { accessToken?: string } }; errors?: GraphQLError[] } = await denied.json();
      expectUnauthorized(deniedBody.errors, denied.status());
      expect(deniedBody.data?.login?.accessToken).toBeFalsy();
    } finally {
      await db.close();
    }
  });

  test('Request without authorization header is rejected', async () => {
    const response = await client.query<MeResponse>(
      ME_QUERY,
      {},
      {}, // No token
    );

    // Must require authentication
    expectUnauthorized(response.body.errors, response.status);
  });

  test('Malformed authorization header is rejected', async () => {
    const response = await client.query<MeResponse>(
      ME_QUERY,
      {},
      {
        extraHeaders: {
          Authorization: 'NotBearer some-random-string',
        },
      },
    );

    // Must reject non-Bearer scheme
    expectUnauthorized(response.body.errors, response.status);
  });
});
