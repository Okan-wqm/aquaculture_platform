import { getAccessToken, silentRefresh, tokenLifecycle } from '@aquaculture/shared-ui';
import {
  ADMIN_JSON_CODEC_POLICY,
  AdminHttpContractError,
  adminManualResponse,
  adminResponse,
  createAdminBinaryRouteDefinition,
  createAdminRequestContract,
  createAdminRouteAuthorizationV1,
  createAdminRouteDefinition,
} from '@platform/admin-http-contracts';
import { Role } from '@platform/identity';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch, apiFetchBlob } from '../http-client';

const LOGICAL_REQUEST_ID = 'client_request_123';
const bearerAdminAuthorization = createAdminRouteAuthorizationV1(
  'bearer-session',
  [Role.SUPER_ADMIN],
  [],
);
const emptyObject = adminResponse.object({});
const emptyRequest = createAdminRequestContract(
  emptyObject,
  emptyObject,
  {},
  emptyObject,
  adminResponse.void(),
  null,
);
const mutationRequest = createAdminRequestContract(
  emptyObject,
  emptyObject,
  {},
  emptyObject,
  adminResponse.object({ value: adminResponse.string() }),
  'application/json',
);
const encodedRequest = createAdminRequestContract(
  adminResponse.object({ id: adminResponse.string() }),
  adminResponse.object({
    levels: adminResponse.optional(adminResponse.string()),
    search: adminResponse.optional(adminResponse.string()),
  }),
  { levels: 'comma-separated', search: 'scalar' },
  adminResponse.object({ 'idempotency-key': adminResponse.optional(adminResponse.string()) }),
  adminResponse.void(),
  null,
);

const securityEventsRoute = createAdminRouteDefinition(
  'GET',
  '/security/events',
  emptyRequest,
  bearerAdminAuthorization,
  200,
  adminResponse.object({ ok: adminResponse.boolean() }),
);
const encodedRoute = createAdminRouteDefinition(
  'GET',
  '/security/events/:id',
  encodedRequest,
  bearerAdminAuthorization,
  200,
  adminResponse.object({ ok: adminResponse.boolean() }),
);
const tenantPageRoute = createAdminRouteDefinition(
  'GET',
  '/admin/tenants',
  emptyRequest,
  bearerAdminAuthorization,
  200,
  adminResponse.page(adminResponse.object({ id: adminResponse.string() })),
);
const mutationRoute = createAdminRouteDefinition(
  'POST',
  '/admin/mutation',
  mutationRequest,
  bearerAdminAuthorization,
  200,
  adminResponse.object({ ok: adminResponse.boolean() }),
);
const noContentRoute = createAdminRouteDefinition(
  'DELETE',
  '/admin/resource',
  emptyRequest,
  bearerAdminAuthorization,
  204,
  adminResponse.void(),
);
const binaryRoute = createAdminBinaryRouteDefinition(
  'GET',
  '/reports/export',
  emptyRequest,
  bearerAdminAuthorization,
  adminManualResponse.binary([200], ['text/csv'], 8),
);

function streamedResponse(chunks: readonly Uint8Array[], init: ResponseInit): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    init,
  );
}

function stalledResponse(init: ResponseInit): {
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly response: Response;
} {
  const cancel = vi.fn();
  return {
    cancel,
    response: new Response(
      new ReadableStream<Uint8Array>({
        cancel,
      }),
      init,
    ),
  };
}

vi.mock('@aquaculture/shared-ui', () => ({
  getAccessToken: vi.fn(),
  tokenLifecycle: { waitForReady: vi.fn() },
  silentRefresh: vi.fn(),
  clearSession: vi.fn(),
}));

function successEnvelope(data: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({
      contractVersion: 'admin-http.v1',
      success: true,
      data,
      meta: {
        timestamp: '2026-08-05T12:00:00.000Z',
        requestId: LOGICAL_REQUEST_ID,
      },
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-ID': LOGICAL_REQUEST_ID,
      },
    },
  );
}

function pageEnvelope(
  data: readonly unknown[],
  pagination: { total: number; page: number; limit: number; totalPages: number },
): Response {
  return new Response(
    JSON.stringify({
      contractVersion: 'admin-http.v1',
      success: true,
      data,
      meta: {
        timestamp: '2026-08-05T12:00:00.000Z',
        requestId: LOGICAL_REQUEST_ID,
        pagination,
      },
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': LOGICAL_REQUEST_ID,
      },
    },
  );
}

function errorEnvelope(status: number): Response {
  return new Response(
    JSON.stringify({
      contractVersion: 'admin-http-error.v1',
      success: false,
      error: {
        status,
        code: status === 401 ? 'UNAUTHENTICATED' : 'SERVICE_UNAVAILABLE',
        message: status === 401 ? 'expired' : 'unavailable',
        timestamp: '2026-08-05T12:00:00.000Z',
        path: '/api/security/events',
        requestId: LOGICAL_REQUEST_ID,
      },
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': LOGICAL_REQUEST_ID,
      },
    },
  );
}

type FetchCall = [input: RequestInfo | URL, init?: RequestInit];

function sentHeaders(call: FetchCall): Record<string, string> {
  const headers = call[1]?.headers;
  if (headers === undefined || headers instanceof Headers || Array.isArray(headers)) {
    throw new Error('transport must send one plain header record');
  }
  return headers;
}

describe('admin HTTP transport kernel', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(successEnvelope({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => LOGICAL_REQUEST_ID) });
    vi.mocked(getAccessToken).mockReturnValue('access-token');
    vi.mocked(tokenLifecycle.waitForReady).mockResolvedValue(undefined);
    vi.mocked(silentRefresh).mockResolvedValue(true);
  });

  it('encodes path, per-field query codecs, and declared caller headers from one route DAG', async () => {
    await apiFetch(encodedRoute, {
      path: { id: 'event 1' },
      query: { levels: ['high', 'critical'], search: 'pond' },
      headers: { 'idempotency-key': 'idem-1' },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/security/events/event%201?levels=high%2Ccritical&search=pond',
    );
    const headers = sentHeaders(fetchMock.mock.calls[0]!);
    expect(headers.Authorization).toBe('Bearer access-token');
    expect(headers['X-Request-ID']).toBe(LOGICAL_REQUEST_ID);
    expect(headers['idempotency-key']).toBe('idem-1');
  });

  it('fails locally when readiness resolves without a bearer token', async () => {
    vi.mocked(getAccessToken).mockReturnValue(null);
    await expect(apiFetch(securityEventsRoute)).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid and already-aborted signals before transport', async () => {
    expect(() => securityEventsRoute.encode({ signal: {} as AbortSignal })).toThrow(
      'signal must be an AbortSignal',
    );
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(
      apiFetch(securityEventsRoute, { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    const nonErrorReason = new AbortController();
    nonErrorReason.abort('caller supplied an invalid rejection value');
    await expect(
      apiFetch(securityEventsRoute, { signal: nonErrorReason.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an encoded path delimiter at the canonical request-target gate', async () => {
    await expect(apiFetch(encodedRoute, { path: { id: 'tenant/escape' } })).rejects.toThrow(
      'percent-encodes a canonical path byte',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates route status and JSON media type before parsing a success body', async () => {
    const json = vi.fn().mockRejectedValue(new Error('must not parse'));
    fetchMock.mockResolvedValueOnce({
      ...successEnvelope({ ok: true }, 201),
      status: 201,
      ok: true,
      json,
      headers: new Headers({ 'Content-Type': 'text/html' }),
    } as Response);

    await expect(apiFetch(securityEventsRoute)).rejects.toThrow('success status 201 is outside');
    expect(json).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );
    await expect(apiFetch(securityEventsRoute)).rejects.toThrow('expected application/json');
  });

  it('validates error JSON media type before parsing the error body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>bad gateway</html>', {
        status: 503,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    await expect(apiFetch(securityEventsRoute)).rejects.toThrow('expected application/json');
  });

  it('decodes canonical and honest empty stale pages', async () => {
    fetchMock.mockResolvedValueOnce(
      pageEnvelope([{ id: 'tenant-1' }], {
        total: 3,
        page: 1,
        limit: 1,
        totalPages: 3,
      }),
    );
    await expect(apiFetch(tenantPageRoute)).resolves.toMatchObject({
      items: [{ id: 'tenant-1' }],
      hasNextPage: true,
      hasPreviousPage: false,
    });

    fetchMock.mockResolvedValueOnce(
      pageEnvelope([], {
        total: 0,
        page: 2,
        limit: 10,
        totalPages: 1,
      }),
    );
    await expect(apiFetch(tenantPageRoute)).resolves.toEqual({
      items: [],
      total: 0,
      page: 2,
      limit: 10,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: true,
    });
  });

  it('accepts a declared 204 only as an empty void response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 204,
        headers: { 'X-Request-ID': LOGICAL_REQUEST_ID },
      }),
    );
    await expect(apiFetch(noContentRoute)).resolves.toBeNull();
  });

  it('bounds streamed JSON and rejects invalid UTF-8', async () => {
    fetchMock.mockResolvedValueOnce(
      streamedResponse(
        [new Uint8Array(ADMIN_JSON_CODEC_POLICY.maxWireBytes), new Uint8Array([0x20])],
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Request-ID': LOGICAL_REQUEST_ID,
          },
        },
      ),
    );
    await expect(apiFetch(securityEventsRoute)).rejects.toThrow(
      'response body exceeds route budget',
    );

    fetchMock.mockResolvedValueOnce(
      streamedResponse([new Uint8Array([0xc3, 0x28])], {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': LOGICAL_REQUEST_ID,
        },
      }),
    );
    await expect(apiFetch(securityEventsRoute)).rejects.toThrow('response body is not valid UTF-8');
  });

  it('reads binary responses only within the generated profile', async () => {
    fetchMock.mockResolvedValueOnce(
      streamedResponse([new TextEncoder().encode('a,b\n')], {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="report.csv"',
          'X-Request-ID': LOGICAL_REQUEST_ID,
        },
      }),
    );
    const result = await apiFetchBlob(binaryRoute);
    expect(result.filename).toBe('report.csv');
    expect(result.blob.size).toBe(4);

    fetchMock.mockResolvedValueOnce(
      streamedResponse([new Uint8Array(9)], {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="report.csv"',
          'X-Request-ID': LOGICAL_REQUEST_ID,
        },
      }),
    );
    await expect(apiFetchBlob(binaryRoute)).rejects.toThrow('exceeds route budget 8 bytes');
  });

  it('keeps the total deadline live through stalled JSON and binary response bodies', async () => {
    vi.useFakeTimers();
    const stalledJson = stalledResponse({
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': LOGICAL_REQUEST_ID,
      },
    });
    fetchMock.mockResolvedValueOnce(stalledJson.response);
    const jsonRequest = apiFetch(securityEventsRoute);
    const jsonExpectation = expect(jsonRequest).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(securityEventsRoute.policy.deadlineMs);
    await jsonExpectation;
    expect(stalledJson.cancel).toHaveBeenCalledTimes(1);

    const stalledBinary = stalledResponse({
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="report.csv"',
        'X-Request-ID': LOGICAL_REQUEST_ID,
      },
    });
    fetchMock.mockResolvedValueOnce(stalledBinary.response);
    const binaryRequest = apiFetchBlob(binaryRoute);
    const binaryExpectation = expect(binaryRequest).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(binaryRoute.policy.deadlineMs);
    await binaryExpectation;
    expect(stalledBinary.cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps caller abort wired after headers and cancels the response reader', async () => {
    const stalled = stalledResponse({
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': LOGICAL_REQUEST_ID,
      },
    });
    fetchMock.mockResolvedValueOnce(stalled.response);
    const caller = new AbortController();
    const request = apiFetch(securityEventsRoute, { signal: caller.signal });
    await Promise.resolve();
    caller.abort(new DOMException('cancelled after headers', 'AbortError'));
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
  });

  it('bounds a hanging auth refresh by the same deadline and caller signal', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(errorEnvelope(401));
    vi.mocked(silentRefresh).mockReturnValueOnce(new Promise<boolean>(() => undefined));
    const timedOut = apiFetch(securityEventsRoute);
    const timeoutExpectation = expect(timedOut).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(securityEventsRoute.policy.deadlineMs);
    await timeoutExpectation;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(errorEnvelope(401));
    vi.mocked(silentRefresh).mockReturnValueOnce(new Promise<boolean>(() => undefined));
    const caller = new AbortController();
    const aborted = apiFetch(securityEventsRoute, { signal: caller.signal });
    await vi.advanceTimersByTimeAsync(0);
    caller.abort(new DOMException('cancelled during refresh', 'AbortError'));
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never automatically retries a mutation after 503 or 401', async () => {
    fetchMock.mockResolvedValueOnce(errorEnvelope(503));
    await expect(apiFetch(mutationRoute, { body: { value: 'one' } })).rejects.toMatchObject({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      requestId: LOGICAL_REQUEST_ID,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(errorEnvelope(401));
    await expect(apiFetch(mutationRoute, { body: { value: 'two' } })).rejects.toMatchObject({
      code: 'UNSAFE_AUTH_REPLAY_BLOCKED',
      requestId: LOGICAL_REQUEST_ID,
    });
    expect(silentRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries safe reads with one request id and aborts a pending backoff', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(errorEnvelope(503))
      .mockResolvedValueOnce(successEnvelope({ ok: true }));
    const retried = apiFetch(securityEventsRoute);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(retried).resolves.toEqual({ ok: true });
    expect(sentHeaders(fetchMock.mock.calls[1]!)['X-Request-ID']).toBe(
      sentHeaders(fetchMock.mock.calls[0]!)['X-Request-ID'],
    );

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(errorEnvelope(503));
    const caller = new AbortController();
    const aborted = apiFetch(securityEventsRoute, { signal: caller.signal });
    await vi.advanceTimersByTimeAsync(0);
    caller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
