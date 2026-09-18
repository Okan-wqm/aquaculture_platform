/**
 * socketReconnect specs — FAZ 3.1 DoD: jittered bounded backoff, auth-failure
 * classification (401/4401/4403 both shapes), and the strict /health/live gate.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  HEALTH_PROBE_TIMEOUT_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
  gatewayHealthy,
  isAuthDisconnectError,
  jitteredBackoffDelay,
} from '../socketReconnect';

describe('jitteredBackoffDelay', () => {
  it('doubles the ladder per attempt, jittered into [delay/2, delay]', () => {
    expect(jitteredBackoffDelay(0, () => 0)).toBe(500); // 1000 * (0.5 + 0)
    expect(jitteredBackoffDelay(0, () => 1)).toBe(1000); // 1000 * (0.5 + 0.5)
    expect(jitteredBackoffDelay(1, () => 0)).toBe(1000);
    expect(jitteredBackoffDelay(1, () => 1)).toBe(2000);
    expect(jitteredBackoffDelay(2, () => 1)).toBe(4000);
  });

  it('caps the ladder at 30s (jitter floor 15s)', () => {
    expect(jitteredBackoffDelay(10, () => 1)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(jitteredBackoffDelay(10, () => 0)).toBe(15_000);
  });

  it('never returns a non-integer or negative value', () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const delay = jitteredBackoffDelay(attempt, () => 0.42);
      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
    }
  });

  it('bounds the attempt budget (constant documents the policy)', () => {
    expect(RECONNECT_MAX_ATTEMPTS).toBe(20); // NOT Infinity — outage-safe
  });
});

describe('isAuthDisconnectError', () => {
  it('classifies connect_error Errors carrying status tokens', () => {
    expect(isAuthDisconnectError(new Error('xhr poll error status 401'))).toBe(true);
    expect(isAuthDisconnectError(Object.assign(new Error('handshake failed'), { description: 'code 4401' }))).toBe(true);
  });

  it('classifies the gateway in-band error envelopes (code or message)', () => {
    expect(isAuthDisconnectError({ message: 'Re-authentication failed', code: 4401 })).toBe(true);
    expect(isAuthDisconnectError({ message: 'User suspended', code: 4403 })).toBe(true);
    expect(isAuthDisconnectError({ message: 'Invalid token' })).toBe(true);
    expect(isAuthDisconnectError({ message: 'Authentication required' })).toBe(true);
    expect(isAuthDisconnectError({ message: 'nope', code: '4401' })).toBe(true); // string code
  });

  it('does NOT classify transport/outage failures as auth', () => {
    expect(isAuthDisconnectError(new Error('xhr poll error'))).toBe(false);
    expect(isAuthDisconnectError({ message: 'server error', code: 502 })).toBe(false);
    expect(isAuthDisconnectError(new Error('websocket error, port 14013 unreachable'))).toBe(false);
    expect(isAuthDisconnectError(undefined)).toBe(false);
  });
});

describe('gatewayHealthy', () => {
  it('probes GET /health/live with no-store and accepts only 2xx', async () => {
    const fetchMock = vi.fn(() => new Response('ok', { status: 200 }));
    await expect(gatewayHealthy(fetchMock as unknown as typeof fetch)).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/health/live');
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');

    const fiveHundred = vi.fn(() => new Response('down', { status: 503 }));
    await expect(gatewayHealthy(fiveHundred as unknown as typeof fetch)).resolves.toBe(false);
  });

  it('a hung gateway (no response within the timeout) counts as unhealthy', async () => {
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const start = Date.now();
    await expect(gatewayHealthy(hanging as unknown as typeof fetch)).resolves.toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(HEALTH_PROBE_TIMEOUT_MS - 50);
  });

  it('a rejected fetch (network down) counts as unhealthy without throwing', async () => {
    const rejecting = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    await expect(gatewayHealthy(rejecting as unknown as typeof fetch)).resolves.toBe(false);
  });
});
