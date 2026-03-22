/**
 * REST Test Client
 *
 * Typed wrapper around Playwright's APIRequestContext for REST operations.
 * Used for health checks, non-GraphQL endpoints, and CSRF token retrieval.
 */

import type { APIRequestContext } from '@playwright/test';

const GATEWAY_URL = process.env['GATEWAY_URL'] || 'http://localhost:4000';

/**
 * REST response shape
 */
export interface RestResponse<T = Record<string, unknown>> {
  status: number;
  statusText: string;
  body: T;
  headers: Record<string, string>;
}

/**
 * Options for REST requests
 */
export interface RestRequestOptions {
  token?: string;
  tenantId?: string;
  extraHeaders?: Record<string, string>;
}

/**
 * REST Test Client for e2e testing
 */
export class RestTestClient {
  constructor(private readonly request: APIRequestContext) {}

  /**
   * Execute a GET request
   */
  async get<T = Record<string, unknown>>(
    path: string,
    options?: RestRequestOptions,
  ): Promise<RestResponse<T>> {
    const headers = this.buildHeaders(options);

    const response = await this.request.get(`${GATEWAY_URL}${path}`, {
      headers,
    });

    return this.parseResponse<T>(response);
  }

  /**
   * Execute a POST request
   */
  async post<T = Record<string, unknown>>(
    path: string,
    data?: Record<string, unknown>,
    options?: RestRequestOptions,
  ): Promise<RestResponse<T>> {
    const headers = this.buildHeaders(options);

    const response = await this.request.post(`${GATEWAY_URL}${path}`, {
      headers,
      data,
    });

    return this.parseResponse<T>(response);
  }

  /**
   * Build request headers
   */
  private buildHeaders(options?: RestRequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (options?.token) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }

    if (options?.tenantId) {
      headers['X-Tenant-Id'] = options.tenantId;
    }

    if (options?.extraHeaders) {
      Object.assign(headers, options.extraHeaders);
    }

    return headers;
  }

  /**
   * Parse response into typed RestResponse
   */
  private async parseResponse<T>(
    response: Awaited<ReturnType<APIRequestContext['get']>>,
  ): Promise<RestResponse<T>> {
    const responseHeaders: Record<string, string> = {};
    const allHeaders = response.headers();
    for (const [key, value] of Object.entries(allHeaders)) {
      responseHeaders[key] = value;
    }

    let body: T;
    try {
      body = await response.json() as T;
    } catch {
      body = (await response.text()) as unknown as T;
    }

    return {
      status: response.status(),
      statusText: response.statusText(),
      body,
      headers: responseHeaders,
    };
  }
}
