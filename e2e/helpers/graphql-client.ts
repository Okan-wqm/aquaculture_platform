/**
 * GraphQL Test Client
 *
 * Typed wrapper around Playwright's APIRequestContext for GraphQL operations.
 * Provides type-safe query/mutation execution with proper error handling.
 */

import type { APIRequestContext } from '@playwright/test';

const GATEWAY_URL = process.env['GATEWAY_URL'] || 'http://localhost:4000';
const GRAPHQL_ENDPOINT = `${GATEWAY_URL}/graphql`;

/**
 * GraphQL response shape
 */
export interface GraphQLResponse<T = Record<string, unknown>> {
  data?: T;
  errors?: GraphQLError[];
}

/**
 * GraphQL error shape
 */
export interface GraphQLError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: string[];
  extensions?: {
    code?: string;
    [key: string]: unknown;
  };
}

/**
 * Options for GraphQL requests
 */
export interface GraphQLRequestOptions {
  token?: string;
  tenantId?: string;
  csrfToken?: string;
  extraHeaders?: Record<string, string>;
}

/**
 * Full HTTP response from a GraphQL request
 */
export interface GraphQLHttpResponse<T = Record<string, unknown>> {
  status: number;
  statusText: string;
  body: GraphQLResponse<T>;
  headers: Record<string, string>;
}

/**
 * GraphQL Test Client for e2e security testing
 */
export class GraphQLTestClient {
  constructor(private readonly request: APIRequestContext) {}

  /**
   * Execute a GraphQL query
   */
  async query<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
    options?: GraphQLRequestOptions,
  ): Promise<GraphQLHttpResponse<T>> {
    return this.execute<T>(query, variables, options);
  }

  /**
   * Execute a GraphQL mutation
   */
  async mutate<T = Record<string, unknown>>(
    mutation: string,
    variables?: Record<string, unknown>,
    options?: GraphQLRequestOptions,
  ): Promise<GraphQLHttpResponse<T>> {
    return this.execute<T>(mutation, variables, options);
  }

  /**
   * Execute a raw GraphQL operation
   */
  private async execute<T = Record<string, unknown>>(
    operation: string,
    variables?: Record<string, unknown>,
    options?: GraphQLRequestOptions,
  ): Promise<GraphQLHttpResponse<T>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (options?.token) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }

    if (options?.tenantId) {
      headers['X-Tenant-Id'] = options.tenantId;
    }

    if (options?.csrfToken) {
      headers['X-CSRF-Token'] = options.csrfToken;
    }

    if (options?.extraHeaders) {
      Object.assign(headers, options.extraHeaders);
    }

    const response = await this.request.post(GRAPHQL_ENDPOINT, {
      headers,
      data: {
        query: operation,
        variables: variables || {},
      },
    });

    const status = response.status();
    const statusText = response.statusText();
    const responseHeaders: Record<string, string> = {};

    // Collect response headers
    const allHeaders = response.headers();
    for (const [key, value] of Object.entries(allHeaders)) {
      responseHeaders[key] = value;
    }

    let body: GraphQLResponse<T>;
    try {
      body = await response.json() as GraphQLResponse<T>;
    } catch {
      body = {} as GraphQLResponse<T>;
    }

    return {
      status,
      statusText,
      body,
      headers: responseHeaders,
    };
  }

  /**
   * Execute a raw POST request to the GraphQL endpoint
   */
  async rawPost(
    data: string | Record<string, unknown>,
    options?: GraphQLRequestOptions,
  ): Promise<{ status: number; body: string }> {
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

    const response = await this.request.post(GRAPHQL_ENDPOINT, {
      headers,
      data: typeof data === 'string' ? data : JSON.stringify(data),
    });

    return {
      status: response.status(),
      body: await response.text(),
    };
  }
}

/**
 * Gateway URL getter for non-GraphQL requests
 */
export function getGatewayUrl(): string {
  return GATEWAY_URL;
}
