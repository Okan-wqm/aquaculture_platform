/**
 * Type-safe REST test client for E2E tests.
 *
 * Used for REST endpoints (health checks, webhooks, file uploads, etc.)
 * that are not served through the GraphQL gateway.
 */

/** Parsed JSON response with status metadata */
export interface RestResponse<T = Record<string, unknown>> {
  status: number;
  statusText: string;
  headers: Headers | Record<string, string>;
  data: T;
}

/** Options for REST requests */
export interface RestRequestOptions {
  /** Additional HTTP headers */
  headers?: Record<string, string>;
  /** Request timeout in ms (default: 10000) */
  timeout?: number;
  /** Query parameters */
  params?: Record<string, string>;
}

/**
 * Error thrown when a REST response has a non-2xx status code.
 */
export class RestTestError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  public readonly body: unknown;

  constructor(status: number, statusText: string, body: unknown) {
    super(`REST error ${status} ${statusText}: ${JSON.stringify(body)}`);
    this.name = 'RestTestError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

/**
 * Type-safe REST test client.
 *
 * Usage:
 *   const client = new RestTestClient(baseUrl, token);
 *   const health = await client.get<HealthResponse>('/health');
 */
export class RestTestClient {
  private readonly playwrightRequest?: PlaywrightAPIRequestContext;
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly tenantId?: string;

  constructor(request: unknown);
  constructor(baseUrl: string, token?: string, tenantId?: string);
  constructor(baseUrlOrRequest: unknown, token?: string, tenantId?: string) {
    if (typeof baseUrlOrRequest === 'string') {
      this.baseUrl = baseUrlOrRequest;
      this.token = token;
      this.tenantId = tenantId;
    } else {
      this.playwrightRequest = baseUrlOrRequest as PlaywrightAPIRequestContext;
      this.baseUrl =
        process.env['BASE_URL'] ?? process.env['GATEWAY_URL'] ?? 'http://localhost:3000';
      this.token = token;
      this.tenantId = tenantId;
    }
  }

  /**
   * Send a GET request.
   * @throws RestTestError if status is not 2xx
   */
  async get<T = Record<string, unknown>>(
    path: string,
    options?: RestRequestOptions,
  ): Promise<RestResponse<T>> {
    return this.request<T>('GET', path, undefined, options);
  }

  /**
   * Send a POST request.
   * @throws RestTestError if status is not 2xx
   */
  async post<T = Record<string, unknown>>(
    path: string,
    body?: unknown,
    options?: RestRequestOptions,
  ): Promise<RestResponse<T>> {
    return this.request<T>('POST', path, body, options);
  }

  /**
   * Send a PUT request.
   * @throws RestTestError if status is not 2xx
   */
  async put<T = Record<string, unknown>>(
    path: string,
    body?: unknown,
    options?: RestRequestOptions,
  ): Promise<RestResponse<T>> {
    return this.request<T>('PUT', path, body, options);
  }

  /**
   * Send a PATCH request.
   * @throws RestTestError if status is not 2xx
   */
  async patch<T = Record<string, unknown>>(
    path: string,
    body?: unknown,
    options?: RestRequestOptions,
  ): Promise<RestResponse<T>> {
    return this.request<T>('PATCH', path, body, options);
  }

  /**
   * Send a DELETE request.
   * @throws RestTestError if status is not 2xx
   */
  async delete<T = Record<string, unknown>>(
    path: string,
    options?: RestRequestOptions,
  ): Promise<RestResponse<T>> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  /**
   * Send a raw request and return the fetch Response.
   * Does NOT throw on non-2xx — use for testing error responses.
   */
  async rawRequest(
    method: string,
    path: string,
    body?: unknown,
    options?: RestRequestOptions,
  ): Promise<Response> {
    const url = this.buildUrl(path, options?.params);
    const headers = this.buildHeaders(options);

    if (this.playwrightRequest) {
      const response = await this.playwrightRequest.fetch(url, {
        method,
        data: body,
        headers,
        timeout: options?.timeout ?? 10_000,
      });
      return playwrightResponseToFetchResponse(response);
    }

    const controller = new AbortController();
    const timeoutMs = options?.timeout ?? 10_000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private buildHeaders(options?: RestRequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options?.headers,
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    if (this.tenantId) {
      headers['x-tenant-id'] = this.tenantId;
    }

    return headers;
  }

  /**
   * Create a new client instance with a different token.
   */
  withToken(newToken: string): RestTestClient {
    return new RestTestClient(this.baseUrl, newToken, this.tenantId);
  }

  /**
   * Create a new client instance with a different tenant.
   */
  withTenant(newTenantId: string): RestTestClient {
    return new RestTestClient(this.baseUrl, this.token, newTenantId);
  }

  /**
   * Create a new client instance without authentication.
   */
  withoutAuth(): RestTestClient {
    return new RestTestClient(this.baseUrl, undefined, this.tenantId);
  }

  // ── Private ─────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RestRequestOptions,
  ): Promise<RestResponse<T>> {
    const response = await this.rawRequest(method, path, body, options);

    let data: T;
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      data = (await response.json()) as T;
    } else {
      // For non-JSON responses, return the text as unknown then cast
      data = (await response.text()) as unknown as T;
    }

    if (!response.ok) {
      throw new RestTestError(response.status, response.statusText, data);
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data,
    };
  }

  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(path, this.baseUrl);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    return url.toString();
  }
}

interface PlaywrightAPIRequestContext {
  fetch(
    url: string,
    options?: {
      method?: string;
      data?: unknown;
      headers?: Record<string, string>;
      timeout?: number;
    },
  ): Promise<PlaywrightAPIResponse>;
}

interface PlaywrightAPIResponse {
  body(): Promise<Buffer>;
  status(): number;
  statusText(): string;
  headers(): Record<string, string>;
}

async function playwrightResponseToFetchResponse(
  response: PlaywrightAPIResponse,
): Promise<Response> {
  const body = new Uint8Array(await response.body());

  return new Response(body, {
    status: response.status(),
    statusText: response.statusText(),
    headers: response.headers(),
  });
}
