/**
 * Type-safe GraphQL test client for E2E tests.
 *
 * Sends queries/mutations to the Gateway API (Apollo Federation v2)
 * with proper authentication headers and tenant context.
 */

/** Default gateway URL for E2E tests */
const DEFAULT_GATEWAY_URL =
  process.env['GATEWAY_URL'] || process.env['BASE_URL'] || 'http://localhost:3000';

/** A single GraphQL error entry */
export interface GraphQLError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

/** Full GraphQL response envelope */
export interface GraphQLResponse<T = Record<string, unknown>> {
  data?: T;
  errors?: GraphQLError[];
}

export interface GraphQLHttpResponse<T = Record<string, unknown>> {
  body: GraphQLResponse<T>;
  status: number;
  headers: Record<string, string>;
}

export interface RawHttpResponse {
  body: string;
  status: number;
  headers: Record<string, string>;
}

export interface GraphQLExecuteOptions extends GraphQLRequestOptions {
  query: string;
  variables?: Record<string, unknown>;
}

/** Options for GraphQL requests */
export interface GraphQLRequestOptions {
  /** Bearer token to use for this request */
  token?: string;
  /** Tenant ID header to send */
  tenantId?: string;
  /** Additional HTTP headers */
  headers?: Record<string, string>;
  /** Extra headers (alias for security test compatibility) */
  extraHeaders?: Record<string, string>;
  /** Request timeout in ms (default: 10000) */
  timeout?: number;
}

/**
 * Error thrown when a GraphQL response contains errors.
 */
export class GraphQLTestError extends Error {
  public readonly errors: GraphQLError[];
  public readonly data: unknown;

  constructor(errors: GraphQLError[], data: unknown) {
    const messages = errors.map((e) => e.message).join('; ');
    super(`GraphQL errors: ${messages}`);
    this.name = 'GraphQLTestError';
    this.errors = errors;
    this.data = data;
  }
}

/**
 * Type-safe GraphQL test client.
 *
 * Supports two construction modes:
 *
 * 1. Jest/Vitest (no-arg):
 *    const client = new GraphQLTestClient();
 *    client.setToken(token);
 *
 * 2. Playwright (with request fixture):
 *    const client = new GraphQLTestClient(request);
 *
 * 3. Explicit URL + token:
 *    const client = new GraphQLTestClient(baseUrl, token, tenantId);
 */
export class GraphQLTestClient {
  private graphqlUrl: string;
  private currentToken: string;
  private currentTenantId: string | undefined;

  /**
   * Playwright request fixture type (duck-typed to avoid @playwright/test dependency).
   */
  private playwrightRequest: PlaywrightAPIRequestContext | undefined;

  constructor();
  constructor(request: unknown);
  constructor(baseUrl: string, token: string, tenantId?: string);
  constructor(
    baseUrlOrRequest?: string | unknown,
    token?: string,
    tenantId?: string,
  ) {
    if (baseUrlOrRequest === undefined) {
      // Zero-arg: Jest/Vitest mode — use default gateway URL
      this.graphqlUrl = `${DEFAULT_GATEWAY_URL}/graphql`;
      this.currentToken = '';
      this.currentTenantId = undefined;
    } else if (typeof baseUrlOrRequest === 'string') {
      // Explicit baseUrl + token
      this.graphqlUrl = `${baseUrlOrRequest}/graphql`;
      this.currentToken = token ?? '';
      this.currentTenantId = tenantId;
    } else {
      // Playwright request context
      this.playwrightRequest = baseUrlOrRequest as PlaywrightAPIRequestContext;
      this.graphqlUrl = `${DEFAULT_GATEWAY_URL}/graphql`;
      this.currentToken = '';
      this.currentTenantId = undefined;
    }
  }

  // ── Token Management ─────────────────────────────────────

  /**
   * Set the bearer token for subsequent requests.
   */
  setToken(token: string): void {
    this.currentToken = token;
  }

  /**
   * Clear the bearer token.
   */
  clearToken(): void {
    this.currentToken = '';
  }

  // ── Query / Mutate ───────────────────────────────────────

  /**
   * Execute a GraphQL query.
   *
   * In Jest/Vitest mode (no Playwright request): returns the `data` field
   * from the response typed as T, and throws GraphQLTestError on errors.
   *
   * In Playwright mode: returns { body: GraphQLResponse<T>, status: number }
   * without throwing, so security tests can inspect error responses.
   */
  async query<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
    options?: GraphQLRequestOptions,
  ): Promise<T & GraphQLHttpResponse<T>> {
    if (this.playwrightRequest) {
      return this.playwrightRawQuery<T>(query, variables, options) as Promise<T & GraphQLHttpResponse<T>>;
    }
    const response = await this.rawRequest(query, variables, options);
    const body = (await response.json()) as GraphQLResponse<T>;

    if (body.errors && body.errors.length > 0) {
      throw new GraphQLTestError(body.errors, body.data);
    }

    if (body.data === undefined) {
      throw new Error('GraphQL response missing data field');
    }

    return body.data as T & GraphQLHttpResponse<T>;
  }

  /**
   * Execute a GraphQL mutation. Same behavior as query() — alias for readability.
   */
  async mutate<T = Record<string, unknown>>(
    mutation: string,
    variables?: Record<string, unknown>,
    options?: GraphQLRequestOptions,
  ): Promise<T & GraphQLHttpResponse<T>> {
    return this.query<T>(mutation, variables, options);
  }

  /**
   * Execute a GraphQL query and return the full response envelope.
   * Does NOT throw on GraphQL errors — use for testing error responses.
   */
  async queryRaw<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
    options?: GraphQLRequestOptions,
  ): Promise<GraphQLResponse<T>> {
    if (this.playwrightRequest) {
      const result = await this.playwrightRawQuery<T>(query, variables, options);
      return result.body;
    }
    const response = await this.rawRequest(query, variables, options);
    return (await response.json()) as GraphQLResponse<T>;
  }

  /**
   * Execute a GraphQL operation and require a successful data payload.
   * Compatibility surface for farm module E2E specs; unlike queryRaw it fails
   * fast on GraphQL errors so CRUD flows cannot accidentally continue.
   */
  async executeSuccess<T = Record<string, unknown>>(
    options: GraphQLExecuteOptions,
  ): Promise<T> {
    return this.query<T>(options.query, options.variables, options);
  }

  /**
   * Execute a GraphQL operation without throwing on GraphQL errors.
   */
  async execute<T = Record<string, unknown>>(
    options: GraphQLExecuteOptions,
  ): Promise<GraphQLResponse<T>> {
    return this.queryRaw<T>(options.query, options.variables, options);
  }

  /**
   * Send an arbitrary JSON body to the GraphQL HTTP endpoint.
   * Used by gateway security specs for batching and malformed-body checks.
   */
  async rawPost(
    body: string,
    options?: GraphQLRequestOptions,
  ): Promise<RawHttpResponse> {
    if (this.playwrightRequest) {
      return this.playwrightRawPost(body, options);
    }

    const response = await fetch(this.graphqlUrl, {
      method: 'POST',
      headers: this.buildHeaders(options),
      body,
    });
    return {
      body: await response.text(),
      status: response.status,
      headers: headersToRecord(response.headers),
    };
  }

  /**
   * Execute a raw HTTP request to the GraphQL endpoint.
   * Returns the raw fetch Response for status code / header assertions.
   */
  async rawRequest(
    query: string,
    variables?: Record<string, unknown>,
    options?: GraphQLRequestOptions,
  ): Promise<Response> {
    const token = options?.token ?? this.currentToken;
    const tenantId = options?.tenantId ?? this.currentTenantId;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options?.headers,
      ...options?.extraHeaders,
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (tenantId) {
      headers['x-tenant-id'] = tenantId;
    }

    const controller = new AbortController();
    const timeoutMs = options?.timeout ?? 10_000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(this.graphqlUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Create a new client instance with a different token.
   * Useful for testing as different users.
   */
  withToken(newToken: string): GraphQLTestClient {
    const baseUrl = this.graphqlUrl.replace('/graphql', '');
    return new GraphQLTestClient(baseUrl, newToken, this.currentTenantId);
  }

  /**
   * Create a new client instance with a different tenant.
   * Useful for testing tenant isolation.
   */
  withTenant(newTenantId: string): GraphQLTestClient {
    const baseUrl = this.graphqlUrl.replace('/graphql', '');
    return new GraphQLTestClient(baseUrl, this.currentToken, newTenantId);
  }

  /**
   * Create a new client instance without any auth token.
   * Useful for testing unauthenticated access.
   */
  withoutAuth(): UnauthenticatedGraphQLTestClient {
    const baseUrl = this.graphqlUrl.replace('/graphql', '');
    return new UnauthenticatedGraphQLTestClient(baseUrl, this.currentTenantId);
  }

  static forFarmService(): GraphQLTestClient {
    const baseUrl = process.env['FARM_SERVICE_GRAPHQL_URL']
      ?? process.env['FARM_SERVICE_URL']
      ?? process.env['GATEWAY_URL']
      ?? process.env['BASE_URL']
      ?? 'http://localhost:3000';
    return new GraphQLTestClient(baseUrl.replace(/\/graphql$/, ''), '');
  }

  // ── Playwright-specific helpers ──────────────────────────

  private async playwrightRawQuery<T>(
    query: string,
    variables?: Record<string, unknown>,
    options?: GraphQLRequestOptions,
  ): Promise<GraphQLHttpResponse<T>> {
    if (!this.playwrightRequest) {
      throw new Error('Playwright request context not available');
    }

    const headers = this.buildHeaders(options);

    const response = await this.playwrightRequest.post(this.graphqlUrl, {
      data: { query, variables },
      headers,
      timeout: options?.timeout ?? 10_000,
    });

    const body = (await response.json()) as GraphQLResponse<T>;
    return { body, status: response.status(), headers: response.headers() };
  }

  private async playwrightRawPost(
    body: string,
    options?: GraphQLRequestOptions,
  ): Promise<RawHttpResponse> {
    if (!this.playwrightRequest) {
      throw new Error('Playwright request context not available');
    }

    const response = await this.playwrightRequest.post(this.graphqlUrl, {
      data: body,
      headers: this.buildHeaders(options),
      timeout: options?.timeout ?? 10_000,
    });

    return {
      body: await response.text(),
      status: response.status(),
      headers: response.headers(),
    };
  }

  private buildHeaders(options?: GraphQLRequestOptions): Record<string, string> {
    const token = options?.token ?? this.currentToken;
    const tenantId = options?.tenantId ?? this.currentTenantId;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options?.headers,
      ...options?.extraHeaders,
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (tenantId) {
      headers['x-tenant-id'] = tenantId;
    }

    return headers;
  }
}

/**
 * GraphQL client without authentication.
 * Used for testing endpoints that should reject unauthenticated requests.
 */
export class UnauthenticatedGraphQLTestClient {
  private readonly graphqlUrl: string;

  constructor(
    private readonly baseUrl: string,
    private readonly tenantId?: string,
  ) {
    this.graphqlUrl = `${baseUrl}/graphql`;
  }

  /**
   * Execute a raw HTTP request without auth headers.
   */
  async rawRequest(
    query: string,
    variables?: Record<string, unknown>,
    options?: GraphQLRequestOptions,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options?.headers,
    };

    if (this.tenantId) {
      headers['x-tenant-id'] = this.tenantId;
    }

    const controller = new AbortController();
    const timeoutMs = options?.timeout ?? 10_000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(this.graphqlUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Execute query and return full response envelope (no auth).
   */
  async queryRaw<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
    options?: GraphQLRequestOptions,
  ): Promise<GraphQLResponse<T>> {
    const response = await this.rawRequest(query, variables, options);
    return (await response.json()) as GraphQLResponse<T>;
  }
}

// ============================================================================
// Playwright API request context duck type
// ============================================================================

/**
 * Minimal interface matching Playwright's APIRequestContext.
 * Duck-typed to avoid requiring @playwright/test as a dependency.
 */
interface PlaywrightAPIRequestContext {
  post(
    url: string,
    options?: {
      data?: unknown;
      headers?: Record<string, string>;
      timeout?: number;
    },
  ): Promise<PlaywrightAPIResponse>;
}

interface PlaywrightAPIResponse {
  json(): Promise<unknown>;
  text(): Promise<string>;
  status(): number;
  headers(): Record<string, string>;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

export function hasGraphQLError<T>(
  response: GraphQLResponse<T> | GraphQLHttpResponse<T>,
  pattern: string | RegExp,
): boolean {
  const errors = 'body' in response ? response.body.errors : response.errors;
  if (!errors) return false;
  return errors.some((error) =>
    typeof pattern === 'string'
      ? error.message.includes(pattern)
      : pattern.test(error.message),
  );
}

// ============================================================================
// Standalone function helpers (used by tenant.fixture.ts and integration tests)
// ============================================================================

/**
 * Execute a raw GraphQL request and return the full response envelope.
 * Does NOT throw on errors — caller decides how to handle them.
 */
export async function graphqlRequest<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
  options?: GraphQLRequestOptions,
): Promise<GraphQLResponse<T>> {
  const token = options?.token ?? '';
  const tenantId = options?.tenantId;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options?.headers,
    ...options?.extraHeaders,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (tenantId) {
    headers['x-tenant-id'] = tenantId;
  }

  const url = `${DEFAULT_GATEWAY_URL}/graphql`;
  const controller = new AbortController();
  const timeoutMs = options?.timeout ?? 10_000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    return (await response.json()) as GraphQLResponse<T>;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Execute a GraphQL query. Throws GraphQLTestError on errors.
 */
export async function graphqlQuery<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
  options?: GraphQLRequestOptions,
): Promise<T> {
  const result = await graphqlRequest<T>(query, variables, options);

  if (result.errors && result.errors.length > 0) {
    throw new GraphQLTestError(result.errors, result.data);
  }

  if (result.data === undefined) {
    throw new Error('GraphQL response missing data field');
  }

  return result.data;
}

/**
 * Execute a GraphQL mutation. Throws GraphQLTestError on errors.
 * Alias of graphqlQuery for readability.
 */
export async function graphqlMutation<T = Record<string, unknown>>(
  mutation: string,
  variables?: Record<string, unknown>,
  options?: GraphQLRequestOptions,
): Promise<T> {
  return graphqlQuery<T>(mutation, variables, options);
}
