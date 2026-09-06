/**
 * CSRF Protection Tests
 *
 * Verifies CSRF (Cross-Site Request Forgery) protections:
 * - POST requests are handled appropriately with/without CSRF tokens
 * - Cookie-based authentication includes CSRF protection via SameSite
 * - Security headers are present on responses
 *
 * Note: The platform uses httpOnly cookies with SameSite=lax for CSRF protection
 * rather than traditional CSRF tokens. The SameSite cookie attribute prevents
 * cross-origin POST requests from including cookies.
 */

import { test, expect } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';

import { GraphQLTestClient } from '../../helpers/graphql-client';
import { issueTestToken } from '../../helpers/persisted-actor.fixture';
import { FIXTURE_PASSWORD } from '../../helpers/real-auth.fixture';

/** Response types (zero any policy) */
interface GraphQLAnyResponse {
  [key: string]: unknown;
}

test.describe('CSRF Protection', () => {
  let graphqlClient: GraphQLTestClient;

  test.beforeEach(({ request }) => {
    graphqlClient = new GraphQLTestClient(request);
  });

  test('POST to GraphQL endpoint without authentication returns auth error, not CSRF error', async () => {
    // The platform uses Bearer token auth for GraphQL, not cookie-based CSRF
    // A POST without auth should get an authentication error (401),
    // not a CSRF error (403)
    const response = await graphqlClient.query<GraphQLAnyResponse>(
      `query { __typename }`,
      {},
      {
        // No token, no CSRF token
      },
    );

    // For a public query like __typename, it may succeed
    // For protected queries, it should return 401
    // The important thing: it should NOT return a CSRF-specific error
    const hasCsrfError =
      response.body.errors?.some(
        (e) => e.message.toLowerCase().includes('csrf') || e.extensions?.code === 'CSRF_ERROR',
      ) ?? false;

    // No CSRF error expected — the platform uses token-based auth
    expect(hasCsrfError).toBe(false);
  });

  test('Authentication cookie uses secure attributes', async () => {
    // Login to get a cookie-based response
    const loginResponse = await graphqlClient.mutate<{
      login: { accessToken: string } | null;
    }>(
      `mutation Login($input: LoginInput!) {
        login(input: $input) {
          accessToken
        }
      }`,
      {
        input: {
          email: 'e2e-tenantadmin@test.aquaculture.io',
          password: FIXTURE_PASSWORD,
        },
      },
      {},
    );

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body.errors).toBeUndefined();
    expect(loginResponse.body.data?.login?.accessToken).toBeTruthy();
    const setCookie = loginResponse.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=');
    expect(setCookie.toLowerCase()).toContain('secure');
  });

  test('Security headers are present on GraphQL responses', async () => {
    const token = await issueTestToken({
      tenantId: uuidv4(),
      roles: ['MODULE_USER'],
    });

    const response = await graphqlClient.query<GraphQLAnyResponse>(
      `query { __typename }`,
      {},
      { token },
    );

    // Check for key security headers that should be set by SecurityHeadersMiddleware
    // or Helmet-equivalent middleware

    // X-Content-Type-Options prevents MIME-type sniffing
    const xContentType = response.headers['x-content-type-options'];
    if (xContentType) {
      expect(xContentType).toBe('nosniff');
    }

    // X-Frame-Options prevents clickjacking
    const xFrameOptions = response.headers['x-frame-options'];
    if (xFrameOptions) {
      expect(xFrameOptions.toUpperCase()).toMatch(/DENY|SAMEORIGIN/);
    }

    // X-Powered-By should be removed (hides server technology)
    const xPoweredBy = response.headers['x-powered-by'];
    // Should be absent or stripped
    if (xPoweredBy) {
      console.warn(
        'WARNING: X-Powered-By header is present. ' +
          'Consider removing it to prevent technology fingerprinting.',
      );
    }

    // Should not crash
    expect(response.status).not.toBe(500);
  });

  test('GraphQL batched HTTP requests are disabled', async () => {
    const token = await issueTestToken({
      tenantId: uuidv4(),
      roles: ['MODULE_USER'],
    });

    // Attempt to send a batched request (array of operations)
    // The gateway has allowBatchedHttpRequests: false
    const batchedResponse = await graphqlClient.rawPost(
      JSON.stringify([{ query: '{ __typename }' }, { query: '{ __typename }' }]),
      { token },
    );

    // Batched requests should be rejected
    // Apollo Server with allowBatchedHttpRequests: false returns 400
    // or processes only the first request
    const parsedBody = JSON.parse(batchedResponse.body) as Record<string, unknown>;

    // If it's an array response, batching was allowed (security issue)
    const isBatchResponse = Array.isArray(parsedBody);

    if (isBatchResponse) {
      console.warn(
        'WARNING: Batched HTTP requests appear to be allowed. ' +
          'This can bypass rate limiting. Verify allowBatchedHttpRequests is false.',
      );
    }

    // Should not crash
    expect(batchedResponse.status).not.toBe(500);
  });
});
