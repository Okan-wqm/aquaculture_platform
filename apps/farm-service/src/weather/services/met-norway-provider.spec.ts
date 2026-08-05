import {
  MET_NORWAY_MAX_JSON_BYTES,
  MET_NORWAY_REQUEST_TIMEOUT_MS,
  MetNorwayHttpClient,
  MetNorwayProvider,
  MetNorwayProviderError,
  MetNorwayProviderErrorCode,
} from './met-norway-provider';

const NOW = new Date('2026-07-31T00:00:00.000Z');
const REQUEST_URL = new URL(
  'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=60&lon=5',
);

function jsonResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  });
}

describe('MetNorwayHttpClient', () => {
  const clock = { now: (): Date => NOW };

  async function requestWith(response: Response): Promise<unknown> {
    const fetchFn = jest.fn<Promise<Response>, [string | URL, RequestInit?]>();
    fetchFn.mockResolvedValue(response);
    const client = new MetNorwayHttpClient(fetchFn, clock);
    return client.getJson({
      provider: MetNorwayProvider.LOCATIONFORECAST,
      url: REQUEST_URL,
      allowedOrigin: 'https://api.met.no',
      allowedPath: '/weatherapi/locationforecast/2.0/compact',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'AquaSaaS/1.0 support@example.test',
      },
    });
  }

  it.each([
    [401, MetNorwayProviderErrorCode.CONFIGURATION, false],
    [403, MetNorwayProviderErrorCode.CONFIGURATION, false],
    [500, MetNorwayProviderErrorCode.UPSTREAM, true],
    [503, MetNorwayProviderErrorCode.UPSTREAM, true],
  ])('classifies HTTP %i as %s', async (status, expectedCode, retryable) => {
    await expect(requestWith(jsonResponse('{}', { status }))).rejects.toMatchObject({
      code: expectedCode,
      retryable,
      httpStatus: status,
    });
  });

  it('returns a typed no-coverage result for HTTP 404', async () => {
    await expect(requestWith(jsonResponse('{}', { status: 404 }))).resolves.toEqual({
      status: 'NO_COVERAGE',
    });
  });

  it('cancels response bodies on status paths that do not consume them', async () => {
    const cancel = jest.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel,
      }),
      {
        status: 404,
        headers: { 'content-type': 'application/json' },
      },
    );

    await expect(requestWith(response)).resolves.toEqual({ status: 'NO_COVERAGE' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('preserves Retry-After for HTTP 429', async () => {
    await expect(
      requestWith(
        jsonResponse('{}', {
          status: 429,
          headers: { 'retry-after': '37' },
        }),
      ),
    ).rejects.toMatchObject({
      code: MetNorwayProviderErrorCode.RATE_LIMITED,
      retryable: true,
      retryAfterSeconds: 37,
    });
  });

  it('does not interpret exponent notation as Retry-After delta-seconds', async () => {
    await expect(
      requestWith(
        jsonResponse('{}', {
          status: 429,
          headers: { 'retry-after': '1e3' },
        }),
      ),
    ).rejects.toMatchObject({
      code: MetNorwayProviderErrorCode.RATE_LIMITED,
      retryAfterSeconds: undefined,
    });
  });

  it('blocks redirects without following their Location header', async () => {
    await expect(
      requestWith(
        jsonResponse('', {
          status: 302,
          headers: { location: 'https://attacker.invalid/weather' },
        }),
      ),
    ).rejects.toMatchObject({
      code: MetNorwayProviderErrorCode.REDIRECT_BLOCKED,
      retryable: false,
    });
  });

  it('rejects JSON larger than two MiB even without Content-Length', async () => {
    const oversizedBody = JSON.stringify({
      value: 'x'.repeat(MET_NORWAY_MAX_JSON_BYTES),
    });
    await expect(requestWith(jsonResponse(oversizedBody))).rejects.toMatchObject({
      code: MetNorwayProviderErrorCode.RESPONSE_TOO_LARGE,
    });
  });

  it('rejects a non-decimal Content-Length instead of accepting exponent notation', async () => {
    await expect(
      requestWith(
        jsonResponse('{}', {
          headers: { 'content-length': '1e3' },
        }),
      ),
    ).rejects.toMatchObject({
      code: MetNorwayProviderErrorCode.SCHEMA,
      retryable: false,
    });
  });

  it('classifies a timed-out fetch separately from a transport error', async () => {
    jest.useFakeTimers();
    const fetchFn = jest.fn<Promise<Response>, [string | URL, RequestInit?]>();
    fetchFn.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const client = new MetNorwayHttpClient(fetchFn, clock);
    const pending = client.getJson({
      provider: MetNorwayProvider.LOCATIONFORECAST,
      url: REQUEST_URL,
      allowedOrigin: 'https://api.met.no',
      allowedPath: '/weatherapi/locationforecast/2.0/compact',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'AquaSaaS/1.0 support@example.test',
      },
    });
    const assertion = expect(pending).rejects.toMatchObject({
      code: MetNorwayProviderErrorCode.TIMEOUT,
      retryable: true,
    });

    await jest.advanceTimersByTimeAsync(30_000);
    await assertion;
    jest.useRealTimers();
  });

  it('keeps the timeout active through a stalled response body and cancels it', async () => {
    jest.useFakeTimers();
    const cancel = jest.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
    const pending = requestWith(response);
    const assertion = expect(pending).rejects.toMatchObject({
      code: MetNorwayProviderErrorCode.TIMEOUT,
      retryable: true,
    });

    await jest.advanceTimersByTimeAsync(MET_NORWAY_REQUEST_TIMEOUT_MS);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('rejects a URL whose origin differs from the fixed allowlist', async () => {
    const client = new MetNorwayHttpClient(jest.fn(), clock);
    await expect(
      client.getJson({
        provider: MetNorwayProvider.LOCATIONFORECAST,
        url: new URL('https://attacker.invalid/compact'),
        allowedOrigin: 'https://api.met.no',
        allowedPath: '/weatherapi/locationforecast/2.0/compact',
        headers: {},
      }),
    ).rejects.toBeInstanceOf(MetNorwayProviderError);
  });
});
