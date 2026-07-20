/**
 * API Client Tests
 *
 * Comprehensive tests for the api-client module covering:
 * - Token management (setTokens, getAccessToken, clearTokens)
 * - Tenant ID management (setTenantId, getTenantId)
 * - GraphQL client (authorization headers, 401 retry, retry limit)
 * - REST client (authorization headers, 401 retry, retry limit)
 * - Silent refresh (httpOnly cookie flow)
 * - Token refresh deduplication (concurrent refresh prevention)
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// We need to mock import.meta.env before importing the module
// Vitest handles this natively

// Dynamic import to reset module state between test groups
let apiClient: typeof import('../api-client');

// Helper to create a fresh module instance
async function loadFreshModule() {
  // Reset the module registry so in-memory tokens are fresh
  vi.resetModules();
  apiClient = await import('../api-client');
}

// ============================================================================
// Mock fetch
// ============================================================================

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Helper to build a mock Response
function mockResponse(status: number, body: unknown, ok?: boolean): Response {
  return {
    ok: ok ?? (status >= 200 && status < 300),
    status,
    json: () => Promise.resolve(body),
    headers: new Headers(),
    redirected: false,
    statusText: '',
    type: 'basic',
    url: '',
    clone: () => mockResponse(status, body, ok),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

describe('api-client', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    localStorage.clear();
    // Clean up window.__AQUACULTURE_AUTH__ if possible
    // (it may be non-configurable after first install, which is by design)
    await loadFreshModule();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================================
  // Token Management
  // ============================================================================

  describe('Token Management', () => {
    describe('setTokens / getAccessToken', () => {
      it('should store access token in memory and retrieve it', async () => {
        apiClient.setTokens('test-access-token-123');
        expect(apiClient.getAccessToken()).toBe('test-access-token-123');
      });

      it('should return null when no token is set', async () => {
        expect(apiClient.getAccessToken()).toBeNull();
      });

      it('should overwrite previous token on re-set', async () => {
        apiClient.setTokens('first-token');
        apiClient.setTokens('second-token');
        expect(apiClient.getAccessToken()).toBe('second-token');
      });

      it('should ignore the refresh token parameter (httpOnly cookie)', async () => {
        apiClient.setTokens('access-token', 'refresh-token');
        // Only access token should be retrievable
        expect(apiClient.getAccessToken()).toBe('access-token');
      });
    });

    describe('clearTokens', () => {
      it('should clear access token from memory', async () => {
        apiClient.setTokens('token-to-clear');
        expect(apiClient.getAccessToken()).toBe('token-to-clear');

        apiClient.clearTokens();
        expect(apiClient.getAccessToken()).toBeNull();
      });

      it('should NOT clear tenant_id from localStorage (preserved for refresh cycles)', async () => {
        localStorage.setItem('tenant_id', 'tenant-123');
        apiClient.clearTokens();
        // tenantId is intentionally preserved during token clear (refresh cycles)
        // Use clearSession() to also clear tenantId
        expect(localStorage.getItem('tenant_id')).toBe('tenant-123');
      });
    });

    describe('clearSession', () => {
      it('should clear access token from memory', async () => {
        apiClient.setTokens('token-to-clear');
        expect(apiClient.getAccessToken()).toBe('token-to-clear');

        apiClient.clearSession();
        expect(apiClient.getAccessToken()).toBeNull();
      });

      it('should clear tenant_id from localStorage', async () => {
        localStorage.setItem('tenant_id', 'tenant-123');
        apiClient.clearSession();
        expect(localStorage.getItem('tenant_id')).toBeNull();
      });

      it('should not throw when localStorage is unavailable', async () => {
        const originalRemoveItem = localStorage.removeItem;
        localStorage.removeItem = () => {
          throw new Error('localStorage disabled');
        };

        expect(() => apiClient.clearSession()).not.toThrow();
        localStorage.removeItem = originalRemoveItem;
      });
    });
  });

  // ============================================================================
  // Tenant ID Management
  // ============================================================================

  describe('Tenant ID Management', () => {
    describe('setTenantId / getTenantId', () => {
      it('should store tenant ID in memory and localStorage', async () => {
        apiClient.setTenantId('tenant-abc');
        expect(apiClient.getTenantId()).toBe('tenant-abc');
        expect(localStorage.getItem('tenant_id')).toBe('tenant-abc');
      });

      it('should remove tenant ID when set to null', async () => {
        apiClient.setTenantId('tenant-abc');
        apiClient.setTenantId(null);
        expect(localStorage.getItem('tenant_id')).toBeNull();
      });

      it('should fall back to localStorage when memory is empty', async () => {
        // Directly set in localStorage (simulating another tab or page load)
        localStorage.setItem('tenant_id', 'tenant-from-storage');
        // Fresh module has null in memory, should fall back to localStorage
        expect(apiClient.getTenantId()).toBe('tenant-from-storage');
      });

      it('should return null when neither memory nor localStorage has value', async () => {
        expect(apiClient.getTenantId()).toBeNull();
      });

      it('should prefer memory over localStorage', async () => {
        localStorage.setItem('tenant_id', 'storage-value');
        apiClient.setTenantId('memory-value');
        expect(apiClient.getTenantId()).toBe('memory-value');
      });

      it('should not throw when localStorage throws', async () => {
        const originalSetItem = localStorage.setItem;
        localStorage.setItem = () => {
          throw new Error('QuotaExceededError');
        };

        expect(() => apiClient.setTenantId('test')).not.toThrow();
        localStorage.setItem = originalSetItem;
      });
    });
  });

  // ============================================================================
  // GraphQL Client
  // ============================================================================

  describe('GraphQL Client', () => {
    it('should include Authorization header when token is set', async () => {
      apiClient.setTokens('gql-test-token');

      mockFetch.mockResolvedValueOnce(mockResponse(200, { data: { users: [] } }));

      await apiClient.graphqlClient.request('{ users { id } }');

      const [, fetchInit] = mockFetch.mock.calls[0];
      expect(fetchInit.headers['Authorization']).toBe('Bearer gql-test-token');
    });

    it('surfaces a typed BACKEND_UNAVAILABLE error on a 502 (never parses HTML as JSON)', async () => {
      apiClient.setTokens('token');
      // nginx returns a 502 HTML page when the gateway is down. json() would throw a
      // bare SyntaxError that callers can't classify, blanking cached data. The client
      // must short-circuit on !response.ok and throw a TYPED transport error first.
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
        text: () => Promise.resolve('<html>502 Bad Gateway</html>'),
        headers: new Headers(),
      } as Response);

      await expect(apiClient.graphqlClient.request('{ ok }')).rejects.toMatchObject({
        name: 'GraphQLClientError',
        code: 'BACKEND_UNAVAILABLE',
      });
    });

    it('should include X-Tenant-Id header when tenant is set', async () => {
      apiClient.setTokens('token');
      apiClient.setTenantId('tenant-42');

      mockFetch.mockResolvedValueOnce(mockResponse(200, { data: { tenants: [] } }));

      await apiClient.graphqlClient.request('{ tenants { id } }');

      const [, fetchInit] = mockFetch.mock.calls[0];
      expect(fetchInit.headers['X-Tenant-Id']).toBe('tenant-42');
    });

    it('should include X-Request-Id header for distributed tracing', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(200, { data: { ok: true } }));

      await apiClient.graphqlClient.request('{ ok }');

      const [, fetchInit] = mockFetch.mock.calls[0];
      expect(fetchInit.headers['X-Request-Id']).toBeDefined();
      expect(typeof fetchInit.headers['X-Request-Id']).toBe('string');
    });

    it('should send credentials: include for cookie-based auth', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(200, { data: { ok: true } }));

      await apiClient.graphqlClient.request('{ ok }');

      const [, fetchInit] = mockFetch.mock.calls[0];
      expect(fetchInit.credentials).toBe('include');
    });

    it('should return data on successful response', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, { data: { users: [{ id: '1', name: 'Test' }] } }),
      );

      const result = await apiClient.graphqlClient.request<{
        users: { id: string; name: string }[];
      }>('{ users { id name } }');

      expect(result.users).toHaveLength(1);
      expect(result.users[0].name).toBe('Test');
    });

    it('should throw GraphQLClientError on GraphQL errors', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, {
          errors: [{ message: 'Not found', extensions: { code: 'NOT_FOUND' } }],
        }),
      );

      await expect(apiClient.graphqlClient.request('{ users { id } }')).rejects.toThrow(
        apiClient.GraphQLClientError,
      );
    });

    describe('401 retry with token refresh', () => {
      it('should retry once after successful token refresh on HTTP 401', async () => {
        apiClient.setTokens('expired-token');

        // 1st call: 401
        mockFetch.mockResolvedValueOnce(mockResponse(401, {}));
        // Refresh call: success
        mockFetch.mockResolvedValueOnce(
          mockResponse(200, {
            data: { refreshToken: { accessToken: 'new-token' } },
          }),
        );
        // 2nd (retry) call: success
        mockFetch.mockResolvedValueOnce(mockResponse(200, { data: { users: [] } }));

        const result = await apiClient.graphqlClient.request<{ users: unknown[] }>(
          '{ users { id } }',
        );

        expect(result.users).toEqual([]);
        // 3 fetch calls: original + refresh + retry
        expect(mockFetch).toHaveBeenCalledTimes(3);
      });

      it('should not retry more than once (prevent infinite loop - CRIT-01)', async () => {
        apiClient.setTokens('expired-token');

        // 1st call: 401
        mockFetch.mockResolvedValueOnce(mockResponse(401, {}));
        // Refresh call: success
        mockFetch.mockResolvedValueOnce(
          mockResponse(200, {
            data: { refreshToken: { accessToken: 'new-token-2' } },
          }),
        );
        // 2nd (retry) call: 401 again
        mockFetch.mockResolvedValueOnce(mockResponse(401, {}));

        // Should not attempt a third call, should parse the 401 body
        // The request will proceed to json parse of the 401 response
        // and either return data or throw based on the response body
        await apiClient.graphqlClient.request('{ users { id } }');
        // 3 calls total, no further retry
        expect(mockFetch).toHaveBeenCalledTimes(3);
      });

      it('should throw when refresh token itself fails', async () => {
        apiClient.setTokens('expired-token');

        // Original call: 401
        mockFetch.mockResolvedValueOnce(mockResponse(401, {}));
        // Refresh call: fails
        mockFetch.mockResolvedValueOnce(mockResponse(401, {}));

        await expect(apiClient.graphqlClient.request('{ users { id } }')).rejects.toThrow(
          'Session expired',
        );
      });

      it('should clear tokens when refresh fails', async () => {
        apiClient.setTokens('expired-token');

        // Original call: 401
        mockFetch.mockResolvedValueOnce(mockResponse(401, {}));
        // Refresh call: fails
        mockFetch.mockResolvedValueOnce(
          mockResponse(200, { errors: [{ message: 'Refresh expired' }] }),
        );

        await expect(apiClient.graphqlClient.request('{ users { id } }')).rejects.toThrow();

        expect(apiClient.getAccessToken()).toBeNull();
      });
    });

    describe('GraphQL-level auth error retry', () => {
      it('should retry on UNAUTHENTICATED extension code in 200 response', async () => {
        apiClient.setTokens('token');

        // 1st call: 200 but with UNAUTHENTICATED error
        mockFetch.mockResolvedValueOnce(
          mockResponse(200, {
            errors: [
              {
                message: 'Token expired',
                extensions: { code: 'UNAUTHENTICATED' },
              },
            ],
          }),
        );
        // Refresh: success
        mockFetch.mockResolvedValueOnce(
          mockResponse(200, {
            data: { refreshToken: { accessToken: 'refreshed-token' } },
          }),
        );
        // Retry: success
        mockFetch.mockResolvedValueOnce(mockResponse(200, { data: { me: { id: '1' } } }));

        const result = await apiClient.graphqlClient.request<{ me: { id: string } }>(
          '{ me { id } }',
        );

        expect(result.me.id).toBe('1');
        expect(mockFetch).toHaveBeenCalledTimes(3);
      });

      it('should not clear session or refresh for service identity signature errors', async () => {
        apiClient.setTokens('valid-user-token');

        mockFetch.mockResolvedValueOnce(
          mockResponse(200, {
            errors: [
              {
                message:
                  'Invalid service identity signature. Request may be forged, expired, or fields tampered with.',
                extensions: { code: 'GRAPHQL_ERROR' },
              },
            ],
          }),
        );

        await expect(apiClient.graphqlClient.request('{ tenantBilling { id } }')).rejects.toThrow(
          apiClient.GraphQLClientError,
        );

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(apiClient.getAccessToken()).toBe('valid-user-token');
      });
    });

    describe('Error handling', () => {
      it('should throw TIMEOUT error on abort', async () => {
        mockFetch.mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              const err = new Error('AbortError');
              err.name = 'AbortError';
              reject(err);
            }),
        );

        await expect(apiClient.graphqlClient.request('{ ok }')).rejects.toThrow(
          'Request timed out',
        );
      });

      it('should throw NETWORK_ERROR on fetch failure', async () => {
        mockFetch.mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')));

        await expect(apiClient.graphqlClient.request('{ ok }')).rejects.toThrow(
          'Unable to connect to server',
        );
      });
    });
  });

  // ============================================================================
  // REST Client
  // ============================================================================

  describe('REST Client', () => {
    // FARM-MEDIUM-091: multipart upload + blob download support
    it('sends a FormData body as multipart — no JSON Content-Type, body passed through', async () => {
      apiClient.setTokens('rest-test-token');
      apiClient.setTenantId('tenant-1');
      mockFetch.mockResolvedValueOnce(mockResponse(200, { documentId: 'd1' }));

      const fd = new FormData();
      fd.append('file', new Blob(['x']), 'a.txt');
      await apiClient.restClient.request('POST', '/upload/doc', { body: fd });

      const [, init] = mockFetch.mock.calls[0];
      expect(init.body).toBe(fd); // FormData passed through, NOT JSON.stringify'd
      expect(init.headers['Content-Type']).toBeUndefined(); // browser sets the multipart boundary
      expect(init.headers['Authorization']).toBe('Bearer rest-test-token');
      expect(init.headers['X-Tenant-Id']).toBe('tenant-1');
    });

    it('still JSON-serializes a plain object body with application/json', async () => {
      apiClient.setTokens('t');
      mockFetch.mockResolvedValueOnce(mockResponse(200, { ok: true }));

      await apiClient.restClient.request('POST', '/x', { body: { a: 1 } });

      const [, init] = mockFetch.mock.calls[0];
      expect(init.body).toBe(JSON.stringify({ a: 1 }));
      expect(init.headers['Content-Type']).toBe('application/json');
    });

    it('requestBlob returns the raw Blob through the shared auth transport', async () => {
      apiClient.setTokens('blob-token');
      mockFetch.mockResolvedValueOnce(mockResponse(200, {}));

      const result = await apiClient.restClient.requestBlob('GET', '/marine/tiles/x.png');

      expect(result).toBeInstanceOf(Blob);
      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['Authorization']).toBe('Bearer blob-token');
    });

    it('should use getAccessToken() for Authorization header', async () => {
      apiClient.setTokens('rest-test-token');

      mockFetch.mockResolvedValueOnce(mockResponse(200, { items: [] }));

      await apiClient.restClient.get('/users');

      const [url, fetchInit] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/users');
      expect(fetchInit.headers['Authorization']).toBe('Bearer rest-test-token');
    });

    it('should include X-Tenant-Id header', async () => {
      apiClient.setTokens('token');
      apiClient.setTenantId('rest-tenant-99');

      mockFetch.mockResolvedValueOnce(mockResponse(200, { ok: true }));

      await apiClient.restClient.get('/data');

      const [, fetchInit] = mockFetch.mock.calls[0];
      expect(fetchInit.headers['X-Tenant-Id']).toBe('rest-tenant-99');
    });

    it('should send credentials: include for cookie-based auth', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(200, { ok: true }));

      await apiClient.restClient.get('/data');

      const [, fetchInit] = mockFetch.mock.calls[0];
      expect(fetchInit.credentials).toBe('include');
    });

    it('should append query params', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(200, { items: [] }));

      await apiClient.restClient.get('/users', { page: 1, limit: 10 });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('page=1');
      expect(url).toContain('limit=10');
    });

    it('should send JSON body for POST', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(201, { id: '1' }));

      await apiClient.restClient.post('/users', { name: 'Test' });

      const [, fetchInit] = mockFetch.mock.calls[0];
      expect(fetchInit.method).toBe('POST');
      expect(JSON.parse(fetchInit.body)).toEqual({ name: 'Test' });
    });

    it('should return undefined for 204 No Content', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(204, null));

      const result = await apiClient.restClient.delete('/users/1');
      expect(result).toBeUndefined();
    });

    it('keeps the request deadline active while the JSON body is still streaming', async () => {
      vi.useFakeTimers();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(() => {}),
      } as Response);

      const request = apiClient.restClient.request('GET', '/stalled-json', { timeout: 5_000 });
      const rejection = expect(request).rejects.toMatchObject({
        message: 'Request timed out',
        statusCode: 408,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
    });

    describe('401 retry with token refresh', () => {
      it('should retry once after successful token refresh on 401', async () => {
        apiClient.setTokens('expired-rest-token');

        // 1st call: 401
        mockFetch.mockResolvedValueOnce(mockResponse(401, {}));
        // Refresh call: success
        mockFetch.mockResolvedValueOnce(
          mockResponse(200, {
            data: { refreshToken: { accessToken: 'new-rest-token' } },
          }),
        );
        // Retry call: success
        mockFetch.mockResolvedValueOnce(mockResponse(200, { items: ['a', 'b'] }));

        const result = await apiClient.restClient.get<{ items: string[] }>('/items');
        expect(result.items).toEqual(['a', 'b']);
        expect(mockFetch).toHaveBeenCalledTimes(3);
      });

      it('should not retry more than once (prevent infinite loop)', async () => {
        apiClient.setTokens('expired-rest-token');

        // 1st call: 401
        mockFetch.mockResolvedValueOnce(mockResponse(401, {}));
        // Refresh: success
        mockFetch.mockResolvedValueOnce(
          mockResponse(200, {
            data: { refreshToken: { accessToken: 'new-token' } },
          }),
        );
        // Retry: 401 again
        mockFetch.mockResolvedValueOnce(mockResponse(401, { message: 'Still unauthorized' }));

        // Should throw RestClientError, not infinite loop
        await expect(apiClient.restClient.get('/restricted')).rejects.toThrow();

        // Exactly 3 calls: original + refresh + one retry
        expect(mockFetch).toHaveBeenCalledTimes(3);
      });

      it('should throw when refresh fails', async () => {
        apiClient.setTokens('expired-rest-token');

        // 1st call: 401
        mockFetch.mockResolvedValueOnce(mockResponse(401, {}));
        // Refresh: fails
        mockFetch.mockResolvedValueOnce(mockResponse(500, {}));

        await expect(apiClient.restClient.get('/items')).rejects.toThrow('Session expired');
      });
    });

    describe('REST error handling', () => {
      it('should throw RestClientError for non-OK responses', async () => {
        apiClient.setTokens('token');
        mockFetch.mockResolvedValueOnce(
          mockResponse(404, {
            success: false,
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'Resource not found',
              timestamp: '2026-07-20T12:00:00.000Z',
            },
          }),
        );

        await expect(apiClient.restClient.get('/missing')).rejects.toThrow('Resource not found');
      });

      it('should include status code in RestClientError', async () => {
        apiClient.setTokens('token');

        mockFetch.mockResolvedValueOnce(
          mockResponse(422, {
            success: false,
            error: {
              code: 'HTTP_UNPROCESSABLE_ENTITY',
              message: 'The request data could not be processed',
              timestamp: '2026-07-20T12:00:00.000Z',
            },
          }),
        );

        try {
          await apiClient.restClient.post('/users', {});
          expect.fail('Should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(apiClient.RestClientError);
          expect((error as InstanceType<typeof apiClient.RestClientError>).statusCode).toBe(422);
        }
      });

      it.each([
        { message: 'legacy top-level message' },
        { success: false, error: { message: 'missing code and timestamp' } },
        '<html>proxy failure</html>',
      ])('uses only a safe status fallback for malformed error bodies', async (body) => {
        mockFetch.mockResolvedValueOnce(mockResponse(415, body));

        await expect(apiClient.restClient.get('/invalid-media')).rejects.toThrow('HTTP 415');
      });
    });

    describe('Convenience methods', () => {
      it('should support PUT method', async () => {
        apiClient.setTokens('token');

        mockFetch.mockResolvedValueOnce(mockResponse(200, { updated: true }));

        await apiClient.restClient.put('/users/1', { name: 'Updated' });

        const [, fetchInit] = mockFetch.mock.calls[0];
        expect(fetchInit.method).toBe('PUT');
      });

      it('should support PATCH method', async () => {
        apiClient.setTokens('token');

        mockFetch.mockResolvedValueOnce(mockResponse(200, { patched: true }));

        await apiClient.restClient.patch('/users/1', { name: 'Patched' });

        const [, fetchInit] = mockFetch.mock.calls[0];
        expect(fetchInit.method).toBe('PATCH');
      });

      it('should support DELETE method', async () => {
        apiClient.setTokens('token');

        mockFetch.mockResolvedValueOnce(mockResponse(204, null));

        await apiClient.restClient.delete('/users/1');

        const [, fetchInit] = mockFetch.mock.calls[0];
        expect(fetchInit.method).toBe('DELETE');
      });
    });
  });

  // ============================================================================
  // Silent Refresh
  // ============================================================================

  describe('silentRefresh', () => {
    it('should return true and set token on successful refresh', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, {
          data: {
            refreshToken: {
              accessToken: 'silently-refreshed-token',
              user: { id: '1', email: 'test@example.com', role: 'TENANT_ADMIN', tenantId: 't1' },
            },
          },
        }),
      );

      const result = await apiClient.silentRefresh();
      expect(result).toBe(true);
      expect(apiClient.getAccessToken()).toBe('silently-refreshed-token');
    });

    it('should send credentials: include for httpOnly cookie', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, {
          data: {
            refreshToken: { accessToken: 'token' },
          },
        }),
      );

      await apiClient.silentRefresh();

      const [, fetchInit] = mockFetch.mock.calls[0];
      expect(fetchInit.credentials).toBe('include');
    });

    it('should return false when server returns non-OK status', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(401, {}));

      const result = await apiClient.silentRefresh();
      expect(result).toBe(false);
    });

    it('should return false when response has errors', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, {
          errors: [{ message: 'Refresh token expired' }],
        }),
      );

      const result = await apiClient.silentRefresh();
      expect(result).toBe(false);
    });

    it('should return false when accessToken is missing from response', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, {
          data: { refreshToken: {} },
        }),
      );

      const result = await apiClient.silentRefresh();
      expect(result).toBe(false);
    });

    it('should return false on network error', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const result = await apiClient.silentRefresh();
      expect(result).toBe(false);
    });

    it('should load tenant_id from localStorage', async () => {
      localStorage.setItem('tenant_id', 'tenant-from-storage');

      mockFetch.mockResolvedValueOnce(
        mockResponse(200, {
          data: { refreshToken: { accessToken: 'token' } },
        }),
      );

      await apiClient.silentRefresh();
      expect(apiClient.getTenantId()).toBe('tenant-from-storage');
    });

    it('should clear tenant_id when refresh response explicitly returns null tenantId', async () => {
      localStorage.setItem('tenant_id', 'stale-tenant');

      mockFetch.mockResolvedValueOnce(
        mockResponse(200, {
          data: { refreshToken: { accessToken: 'token', user: { tenantId: null } } },
        }),
      );

      await apiClient.silentRefresh();
      expect(apiClient.getTenantId()).toBeNull();
      expect(localStorage.getItem('tenant_id')).toBeNull();
    });
  });

  // ============================================================================
  // Token Refresh Deduplication
  // ============================================================================

  describe('Token refresh deduplication', () => {
    it('should not make multiple concurrent refresh calls', async () => {
      apiClient.setTokens('expired-token');

      let refreshCallCount = 0;

      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);

        // Detect refresh mutation
        if (body.query && body.query.includes('refreshToken')) {
          refreshCallCount++;
          return Promise.resolve(
            mockResponse(200, {
              data: { refreshToken: { accessToken: 'deduped-token' } },
            }),
          );
        }

        // All other requests: first returns 401, then 200
        if (refreshCallCount === 0) {
          return Promise.resolve(mockResponse(401, {}));
        }
        return Promise.resolve(mockResponse(200, { data: { result: 'ok' } }));
      });

      // Fire two requests concurrently — both should hit 401
      // but only ONE refresh should happen
      await Promise.all([
        apiClient.graphqlClient.request('{ query1 }'),
        apiClient.graphqlClient.request('{ query2 }'),
      ]);

      // Only 1 refresh call should have been made (deduplication)
      expect(refreshCallCount).toBe(1);
    });
  });

  // ============================================================================
  // GraphQLClientError
  // ============================================================================

  describe('GraphQLClientError', () => {
    it('should have correct name, code, and message', () => {
      const error = new apiClient.GraphQLClientError('Test error', 'TEST_CODE');
      expect(error.name).toBe('GraphQLClientError');
      expect(error.code).toBe('TEST_CODE');
      expect(error.message).toBe('Test error');
      expect(error).toBeInstanceOf(Error);
    });

    it('should store graphqlErrors array', () => {
      const gqlErrors = [{ message: 'Field error', path: ['users', 'id'] }];
      const error = new apiClient.GraphQLClientError('Error', 'GQL_ERROR', gqlErrors);
      expect(error.graphqlErrors).toEqual(gqlErrors);
    });
  });

  // ============================================================================
  // RestClientError
  // ============================================================================

  describe('RestClientError', () => {
    it('should have correct name, statusCode, and message', () => {
      const error = new apiClient.RestClientError('Not found', 404);
      expect(error.name).toBe('RestClientError');
      expect(error.statusCode).toBe(404);
      expect(error.message).toBe('Not found');
      expect(error).toBeInstanceOf(Error);
    });

    it('should store response data', () => {
      const data = { field: 'email', reason: 'invalid' };
      const error = new apiClient.RestClientError('Validation', 422, data);
      expect(error.data).toEqual(data);
    });
  });

  // ============================================================================
  // loadTokensFromStorage
  // ============================================================================

  describe('loadTokensFromStorage', () => {
    it('should load tenant_id from localStorage', async () => {
      localStorage.setItem('tenant_id', 'stored-tenant');
      apiClient.loadTokensFromStorage();
      expect(apiClient.getTenantId()).toBe('stored-tenant');
    });

    it('should not throw when localStorage is unavailable', async () => {
      const originalGetItem = localStorage.getItem;
      localStorage.getItem = () => {
        throw new Error('Disabled');
      };

      expect(() => apiClient.loadTokensFromStorage()).not.toThrow();
      localStorage.getItem = originalGetItem;
    });
  });
});
