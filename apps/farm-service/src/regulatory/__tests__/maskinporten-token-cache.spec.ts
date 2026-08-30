import type { ConfigService } from '@nestjs/config';

import type { CircuitBreakerService } from '@aquaculture/backend-common/resilience';

import { MaskinportenService } from '../maskinporten.service';
import type { RegulatorySettingsService } from '../regulatory-settings.service';

/**
 * London-school tests for the Maskinporten token-cache resilience refinements
 * (FARM-MEDIUM-172): single-flight dedup of concurrent token acquisitions and an
 * LRU cache sized to the tenant population (no FIFO thrash of a still-valid
 * token). The circuit breaker is mocked to return canned discovery/token results
 * so no real fetch or JWT signing runs — the token-acquisition orchestration is
 * what's under test, not the HTTP transport.
 */

interface Latch<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function latch<T>(): Latch<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function buildService(overrides?: { clientId?: () => Promise<string | null> }): {
  service: MaskinportenService;
  clientIdMock: jest.Mock;
} {
  const clientIdMock = jest.fn(overrides?.clientId ?? (() => Promise.resolve('client-1')));
  const settings = {
    getDecryptedClientId: clientIdMock,
    getDecryptedPrivateKey: jest.fn().mockResolvedValue('pk'),
    getMaskinportenConfig: jest.fn().mockResolvedValue({ environment: 'TEST', keyId: 'kid' }),
  } as Partial<RegulatorySettingsService> as RegulatorySettingsService;

  const circuitBreaker = {
    execute: jest.fn(({ serviceName }: { serviceName: string }) => {
      if (serviceName === 'maskinporten-discovery') {
        return Promise.resolve({ tokenEndpoint: 'https://token', issuer: 'iss' });
      }
      return Promise.resolve({
        access_token: 'TOK',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: '',
      });
    }),
  } as Partial<CircuitBreakerService> as CircuitBreakerService;

  const config = {
    get: jest.fn().mockReturnValue('TEST'),
  } as Partial<ConfigService> as ConfigService;

  const service = new MaskinportenService(config, settings, circuitBreaker);
  return { service, clientIdMock };
}

describe('MaskinportenService token cache — single-flight (FARM-MEDIUM-172)', () => {
  it('collapses concurrent misses for the same tenant+scopes onto one acquisition', async () => {
    const gate = latch<string>();
    const { service, clientIdMock } = buildService({
      // First (and only) acquisition parks on this gate so all three callers
      // overlap the in-flight window before any completes.
      clientId: () => gate.promise,
    });

    const calls = Promise.all([
      service.getSeaLiceToken('tenant-A'),
      service.getSeaLiceToken('tenant-A'),
      service.getSeaLiceToken('tenant-A'),
    ]);
    gate.resolve('client-1');
    const [a, b, c] = await calls;

    expect(a).toBe('TOK');
    expect(b).toBe('TOK');
    expect(c).toBe('TOK');
    // Single-flight: exactly ONE credential fetch (one acquisition) for 3 callers.
    expect(clientIdMock).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('serves the cached token on the next call (no second acquisition)', async () => {
    const { service, clientIdMock } = buildService();
    await service.getSeaLiceToken('tenant-A');
    await service.getSeaLiceToken('tenant-A');
    expect(clientIdMock).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('re-acquires after the tenant cache is cleared', async () => {
    const { service, clientIdMock } = buildService();
    await service.getSeaLiceToken('tenant-A');
    service.clearTenantCache('tenant-A');
    await service.getSeaLiceToken('tenant-A');
    expect(clientIdMock).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });
});

describe('MaskinportenService token cache — LRU sized to tenant population', () => {
  it('does NOT evict still-valid tokens past the old fixed 100-entry cap', async () => {
    const { service } = buildService();
    // 130 distinct tenants, each caching one valid token. Under the old FIFO cap
    // of 100 the first 30 would be evicted while still valid; the population-sized
    // LRU keeps all 130.
    for (let i = 0; i < 130; i++) {
      await service.getSeaLiceToken(`tenant-${i}`);
    }
    expect(service.getCacheStats().tokenCacheSize).toBe(130);
    service.onModuleDestroy();
  });
});
