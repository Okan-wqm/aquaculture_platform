import type { CdseProviderCredentialBundle } from '@aquaculture/backend-common/config-client';

import { MarineProviderCredentialUnavailableError } from '../marine-provider-credentials.service';
import {
  CDSE_TOKEN_CACHE_MAX_GENERATIONS,
  CDSE_TOKEN_MAX_RETRY_AFTER_MS,
  CDSE_TOKEN_REQUEST_TIMEOUT_MS,
  type CdseCredentialResolver,
  CdseTokenDelay,
  CdseTokenErrorCode,
  SentinelHubService,
} from '../sentinel-hub.service';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function tokenCacheOf(service: SentinelHubService): Map<unknown, unknown> {
  const cache: unknown = Reflect.get(service, 'tokenCache');
  if (!(cache instanceof Map)) {
    throw new Error('SentinelHubService token cache was not initialized');
  }
  return cache;
}

function resolvedCredential(
  configVersion: number,
  clientSecret = 'secret',
): {
  bundle: CdseProviderCredentialBundle;
  sourceTenantId: string;
  configVersion: number;
} {
  return {
    bundle: {
      clientId: 'client',
      clientSecret,
    },
    sourceTenantId: TENANT_ID,
    configVersion,
  };
}

/**
 * Effective-credential-generation token cache + in-flight dedup. Every call
 * resolves credential provenance/version first, so company or preserved
 * override rotation bypasses stale cache while tenants using the same company
 * generation share one provider token.
 */
describe('SentinelHubService — config generation-aware token cache', () => {
  let service: SentinelHubService;
  let providerCredentials: CdseCredentialResolver;
  let resolveCdse: jest.MockedFunction<CdseCredentialResolver['resolveCdse']>;
  let fetchSpy: jest.SpyInstance;
  let delay: jest.Mocked<CdseTokenDelay>;

  beforeEach(() => {
    resolveCdse = jest.fn().mockResolvedValue(resolvedCredential(1));
    providerCredentials = { resolveCdse };
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ access_token: 'token-1', expires_in: 1800 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    delay = { wait: jest.fn().mockResolvedValue(undefined) };
    service = new SentinelHubService(providerCredentials, delay);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns null only when no effective credential exists', async () => {
    resolveCdse.mockResolvedValueOnce(null);

    await expect(service.getAccessToken(TENANT_ID)).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('classifies config-service transport failure and bounds resolution to two attempts', async () => {
    resolveCdse.mockRejectedValue(new MarineProviderCredentialUnavailableError());

    await expect(service.getAccessToken(TENANT_ID)).rejects.toMatchObject({
      code: CdseTokenErrorCode.CREDENTIAL_SERVICE,
      retryable: true,
      message: 'CDSE credential service is unavailable',
    });
    expect(resolveCdse).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serves the same config generation from cache', async () => {
    const first = await service.getAccessToken(TENANT_ID);
    const second = await service.getAccessToken(TENANT_ID);

    expect(first?.accessToken).toBe('token-1');
    expect(second?.accessToken).toBe('token-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refreshes during the final sub-second cache boundary instead of returning expiresIn zero', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T12:00:00.000Z'));
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'boundary-token', expires_in: 61 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'refreshed-token', expires_in: 1800 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    await expect(service.getAccessToken(TENANT_ID)).resolves.toMatchObject({
      accessToken: 'boundary-token',
    });
    jest.setSystemTime(new Date('2026-07-31T12:00:00.001Z'));

    await expect(service.getAccessToken(TENANT_ID)).resolves.toMatchObject({
      accessToken: 'refreshed-token',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent refreshes for one tenant and generation', async () => {
    const [first, second, third] = await Promise.all([
      service.getAccessToken(TENANT_ID),
      service.getAccessToken(TENANT_ID),
      service.getAccessToken(TENANT_ID),
    ]);

    expect(first?.accessToken).toBe('token-1');
    expect(second?.accessToken).toBe('token-1');
    expect(third?.accessToken).toBe('token-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('re-authenticates automatically when the config version rotates', async () => {
    await service.getAccessToken(TENANT_ID);
    resolveCdse.mockResolvedValue(resolvedCredential(2, 'rotated-secret'));
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'token-2', expires_in: 1800 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const rotated = await service.getAccessToken(TENANT_ID);

    expect(rotated?.accessToken).toBe('token-2');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps tenant token caches isolated', async () => {
    resolveCdse.mockImplementation(async (tenantId: string) => ({
      ...resolvedCredential(1),
      sourceTenantId: tenantId,
    }));

    await service.getAccessToken(TENANT_ID);
    await service.getAccessToken('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('shares one OAuth token for tenants resolved to the same company credential generation', async () => {
    resolveCdse.mockResolvedValue({
      bundle: {
        clientId: 'company-client',
        clientSecret: 'company-secret',
      },
      sourceTenantId: '00000000-0000-0000-0000-000000000000',
      configVersion: 7,
    });

    const [first, second] = await Promise.all([
      service.getAccessToken(TENANT_ID),
      service.getAccessToken('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    ]);

    expect(first?.accessToken).toBe('token-1');
    expect(second?.accessToken).toBe('token-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('removes expired bearer generations from memory during the next lookup', async () => {
    const tokenCache = tokenCacheOf(service);
    tokenCache.set('expired-generation', {
      accessToken: 'expired-bearer-must-not-remain',
      expiresAt: Date.now() - 1,
      credentialGeneration: 'expired-generation',
    });

    await service.getAccessToken(TENANT_ID);

    expect(tokenCache.has('expired-generation')).toBe(false);
  });

  it('caps retained credential generations with least-recently-used eviction', async () => {
    const tokenCache = tokenCacheOf(service);
    const expiresAt = Date.now() + 60_000;
    for (let index = 0; index < CDSE_TOKEN_CACHE_MAX_GENERATIONS; index += 1) {
      const generation = `seed-generation-${index}`;
      tokenCache.set(generation, {
        accessToken: `seed-bearer-${index}`,
        expiresAt,
        credentialGeneration: generation,
      });
    }

    await service.getAccessToken(TENANT_ID);

    expect(tokenCache.size).toBe(CDSE_TOKEN_CACHE_MAX_GENERATIONS);
    expect(tokenCache.has('seed-generation-0')).toBe(false);
    expect(tokenCache.has(`${TENANT_ID}:1`)).toBe(true);
  });

  it('rejects a declared oversized token response before reading its body', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'must-not-be-used' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(16 * 1024 + 1),
        },
      }),
    );

    await expect(service.getAccessToken('oversized-declared')).rejects.toMatchObject({
      code: CdseTokenErrorCode.SCHEMA,
      retryable: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-decimal Content-Length instead of accepting exponent notation', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'must-not-be-used' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '1e3',
        },
      }),
    );

    await expect(service.getAccessToken('invalid-content-length')).rejects.toMatchObject({
      code: CdseTokenErrorCode.SCHEMA,
      retryable: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels an oversized streamed token response before JSON parsing', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('x'.repeat(16 * 1024 + 1), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(service.getAccessToken('oversized-streamed')).rejects.toMatchObject({
      code: CdseTokenErrorCode.SCHEMA,
      retryable: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403])(
    'classifies invalid client status %s as non-retryable authentication',
    async (status) => {
      const cancel = jest.fn();
      fetchSpy.mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel,
          }),
          { status },
        ),
      );

      await expect(service.getAccessToken(`rejected-credential-${status}`)).rejects.toMatchObject({
        code: CdseTokenErrorCode.AUTHENTICATION,
        retryable: false,
        httpStatus: status,
      });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a successful token response without an application/json media type', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'must-not-be-used' }), {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    await expect(service.getAccessToken('wrong-media-type')).rejects.toMatchObject({
      code: CdseTokenErrorCode.SCHEMA,
      retryable: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([1.5, 86_401, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe or unreasonable expires_in value %s',
    async (expiresIn) => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'must-not-be-used', expires_in: expiresIn }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await expect(service.getAccessToken(`invalid-expiry-${expiresIn}`)).rejects.toMatchObject({
        code: CdseTokenErrorCode.SCHEMA,
        retryable: false,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('classifies network failure as retryable transport and makes only two attempts', async () => {
    fetchSpy.mockRejectedValue(new Error('network unavailable'));

    await expect(service.getAccessToken(TENANT_ID)).rejects.toMatchObject({
      code: CdseTokenErrorCode.TRANSPORT,
      retryable: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries a transient 5xx token response once and then succeeds', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'recovered-token', expires_in: 1800 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(service.getAccessToken(TENANT_ID)).resolves.toMatchObject({
      accessToken: 'recovered-token',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('caps strict Retry-After delay at two seconds and makes only one retry', async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: { 'retry-after': '999999999999999999999' },
      }),
    );

    await expect(service.getAccessToken(TENANT_ID)).rejects.toMatchObject({
      code: CdseTokenErrorCode.RATE_LIMITED,
      retryable: true,
      retryAfterMs: CDSE_TOKEN_MAX_RETRY_AFTER_MS,
    });
    expect(delay.wait).toHaveBeenCalledTimes(1);
    expect(delay.wait).toHaveBeenCalledWith(CDSE_TOKEN_MAX_RETRY_AFTER_MS);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not honor non-decimal Retry-After syntax', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '1e3' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'recovered-token', expires_in: 1800 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    await expect(service.getAccessToken(TENANT_ID)).resolves.toMatchObject({
      accessToken: 'recovered-token',
    });
    expect(delay.wait).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('classifies a bounded token request timeout and makes only two attempts', async () => {
    jest.useFakeTimers();
    fetchSpy.mockImplementation(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );

    const pending = service.getAccessToken(TENANT_ID);
    const assertion = expect(pending).rejects.toMatchObject({
      code: CdseTokenErrorCode.TIMEOUT,
      retryable: true,
    });
    await jest.advanceTimersByTimeAsync(CDSE_TOKEN_REQUEST_TIMEOUT_MS + 1);
    await jest.advanceTimersByTimeAsync(CDSE_TOKEN_REQUEST_TIMEOUT_MS + 1);
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
