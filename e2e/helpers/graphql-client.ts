/**
 * Type-safe GraphQL test client for E2E tests.
 *
 * Sends queries/mutations to the Gateway API (Apollo Federation v2)
 * with proper authentication headers and tenant context.
 */

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
  /** Additional HTTP headers */
  headers?: Record<string, string>;
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
 * Usage:
 *   const client = new GraphQLTestClient(baseUrl, token, tenantId);
 *   const result = await client.query<{ users: User[] }>(`{ users { id name } }`);
 */
export class GraphQLTestClient {
  private readonly graphqlUrl: string;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly tenantId?: string,
  ) {
    // Gateway exposes GraphQL at /graphql
    this.graphqlUrl = `${baseUrl}/graphql`;
  }

  /**
   * Execute a GraphQL query. Throws GraphQLTestError if the response contains errors.
   *
   * @param query   - GraphQL query string
   * @param variables - Query variables
   * @param options - Additional request options
   * @returns The `data` field from the response, typed as T
   */
  async query<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
    options?: GraphQLRequestOptions,
  ): Promise<T> {
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
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
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
   * Create a new client instance with a different token.
   * Useful for testing as different users.
   */
  withToken(newToken: string): GraphQLTestClient {
    return new GraphQLTestClient(this.baseUrl, newToken, this.tenantId);
  }

  /**
   * Create a new client instance with a different tenant.
   * Useful for testing tenant isolation.
   */
  withTenant(newTenantId: string): GraphQLTestClient {
    return new GraphQLTestClient(this.baseUrl, this.token, newTenantId);
  }

  /**
   * Create a new client instance without any auth token.
   * Useful for testing unauthenticated access.
   */
  withoutAuth(): UnauthenticatedGraphQLTestClient {
    return new UnauthenticatedGraphQLTestClient(this.baseUrl, this.tenantId);
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
