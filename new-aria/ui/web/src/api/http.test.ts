import { describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../../../shared/api-contract.ts';
import { ApiClientError } from './errors.ts';
import { buildHeaders, isPublicPath, requestJson, type Transport } from './http.ts';
import { fillPath, withQuery } from './query.ts';

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function fakeTransport(token: string | null, respond: (captured: Captured) => Response): { transport: Transport; calls: Captured[] } {
  const calls: Captured[] = [];
  const transport: Transport = {
    tokenProvider: () => token,
    fetchImpl: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const captured: Captured = { url, init };
      calls.push(captured);
      return respond(captured);
    },
  };
  return { transport, calls };
}

describe('buildHeaders', () => {
  it('sets the Bearer authorization header and JSON accept', () => {
    const headers = buildHeaders('secret-token', { hasBody: false });
    expect(headers.get('authorization')).toBe('Bearer secret-token');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('content-type')).toBeNull();
  });

  it('adds content-type only when a body is sent and omits authorization without a token', () => {
    const headers = buildHeaders(null, { hasBody: true });
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('content-type')).toBe('application/json');
  });
});

describe('isPublicPath', () => {
  it('treats only /health as public', () => {
    expect(isPublicPath(ENDPOINTS.health.path)).toBe(true);
    expect(isPublicPath(ENDPOINTS.overview.path)).toBe(false);
    expect(isPublicPath(`${ENDPOINTS.health.path}?x=1`)).toBe(true);
  });
});

describe('requestJson', () => {
  it('sends the token on protected endpoints and parses the JSON body', async () => {
    const { transport, calls } = fakeTransport('tok-123', () => new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await requestJson<{ status: string }>(ENDPOINTS.overview.path, {}, transport);
    expect(result.status).toBe('ok');
    expect(calls).toHaveLength(1);
    const sent = new Headers(calls[0]?.init?.headers);
    expect(sent.get('authorization')).toBe('Bearer tok-123');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('never sends a token to the public health endpoint', async () => {
    const { transport, calls } = fakeTransport('tok-123', () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    await requestJson(ENDPOINTS.health.path, {}, transport);
    const sent = new Headers(calls[0]?.init?.headers);
    expect(sent.get('authorization')).toBeNull();
  });

  it('fails before the network when a protected endpoint has no token', async () => {
    const { transport, calls } = fakeTransport(null, () => new Response('{}', { status: 200 }));
    await expect(requestJson(ENDPOINTS.cycles.path, {}, transport)).rejects.toMatchObject({ status: 401, payload: { error: 'missing_token' } });
    expect(calls).toHaveLength(0);
  });

  it('parses a contract ApiError body into ApiClientError', async () => {
    const { transport } = fakeTransport('tok', () => new Response(JSON.stringify({ error: 'forbidden', detail: 'actions disabled' }), { status: 403 }));
    const failure = await requestJson(ENDPOINTS.actionControl.path, { method: 'POST', body: { verb: 'pause', reason: 'test' } }, transport).catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(ApiClientError);
    if (failure instanceof ApiClientError) {
      expect(failure.status).toBe(403);
      expect(failure.payload).toEqual({ error: 'forbidden', detail: 'actions disabled' });
      expect(failure.message).toBe('forbidden: actions disabled');
      expect(failure.isUnauthorized).toBe(false);
    }
  });

  it('wraps a non-JSON error body as HTTP <status> with the text as detail', async () => {
    const { transport } = fakeTransport('tok', () => new Response('<html>bad gateway</html>', { status: 502 }));
    const failure = await requestJson(ENDPOINTS.tools.path, {}, transport).catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(ApiClientError);
    if (failure instanceof ApiClientError) {
      expect(failure.payload.error).toBe('HTTP 502');
      expect(failure.payload.detail).toContain('bad gateway');
    }
  });

  it('serialises POST bodies as JSON with content-type', async () => {
    const { transport, calls } = fakeTransport('tok', () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await requestJson(ENDPOINTS.actionControl.path, { method: 'POST', body: { verb: 'resume', reason: 'ops' } }, transport);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ verb: 'resume', reason: 'ops' }));
    expect(new Headers(calls[0]?.init?.headers).get('content-type')).toBe('application/json');
  });
});

describe('path helpers', () => {
  it('fills and encodes path params', () => {
    expect(fillPath(ENDPOINTS.cycle.path, { cycleId: 'c/1 x' })).toBe('/api/v1/cycles/c%2F1%20x');
    expect(() => fillPath(ENDPOINTS.cycle.path, {})).toThrow(/cycleId/);
  });

  it('drops undefined and empty query params', () => {
    expect(withQuery('/x', { limit: 10, since: undefined, event: '' })).toBe('/x?limit=10');
    expect(withQuery('/x', {})).toBe('/x');
  });
});
