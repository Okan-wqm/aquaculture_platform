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
  constructor(request: PlaywrightAPIRequestContext);
  constructor(baseUrl: string, token: string, tenantId?: string);
  constructor(
    baseUrlOrRequest?: string | PlaywrightAPIRequestContext,
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
      this.playwrightRequest = baseUrlOrRequest;
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
  ): Promise<T> {
    if (this.playwrightRequest) {
      // Playwright mode: return { body, status } envelope (non-throwing)
      const result = await this.playwrightRawQuery<T>(query, variables, options);
      return result as unknown as T;
    }
    const response = await this.rawRequest(query, variables, options);
    const body = (await response.json()) as GraphQLResponse<T>;

    if (body.errors && body.errors.length > 0) {
      throw new GraphQLTestError(body.errors, body.data);
    }

    if (body.data === undefined) {
      throw new Error('GraphQL response missing data field');
    }

    return body.data;
  }

  /**
   * Execute a GraphQL mutation. Same behavior as query() — alias for readability.
   */
  async mutate<T = Record<string, unknown>>(
    mutation: string,
    variables?: Record<string, unknown>,
    options?: GraphQLRequestOptions,
  ): Promise<T> {
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

  // ── Playwright-specific helpers ──────────────────────────

  private async playwrightRawQuery<T>(
    query: string,
    variables?: Record<string, unknown>,
    options?: GraphQLRequestOptions,
  ): Promise<{ body: GraphQLResponse<T>; status: number }> {
    if (!this.playwrightRequest) {
      throw new Error('Playwright request context not available');
    }

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

    const response = await this.playwrightRequest.post(this.graphqlUrl, {
      data: { query, variables },
      headers,
      timeout: options?.timeout ?? 10_000,
    });

    const body = (await response.json()) as GraphQLResponse<T>;
    return { body, status: response.status() };
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
  ): Promise<{
    json(): Promise<unknown>;
    status(): number;
  }>;
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
