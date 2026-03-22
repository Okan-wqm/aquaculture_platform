/**
 * GraphQL Test Client
 *
 * Sends GraphQL queries and mutations to the gateway API.
 * Handles JWT authentication and response typing.
 */

export interface GraphQLResponse<T = Record<string, unknown>> {
  data: T | null;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
    extensions?: Record<string, unknown>;
  }>;
}

export interface GraphQLRequestOptions {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export class GraphQLTestClient {
  private readonly baseUrl: string;
  private authToken: string | null = null;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env['GATEWAY_URL'] ?? 'http://localhost:4000';
  }

  /**
   * Set the authorization token for subsequent requests
   */
  setToken(token: string): void {
    this.authToken = token;
  }

  /**
   * Clear the authorization token
   */
  clearToken(): void {
    this.authToken = null;
  }

  /**
   * Execute a GraphQL query or mutation
   */
  async execute<T = Record<string, unknown>>(
    options: GraphQLRequestOptions,
  ): Promise<GraphQLResponse<T>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(`${this.baseUrl}/graphql`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: options.query,
        variables: options.variables ?? {},
        operationName: options.operationName,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `GraphQL request failed with status ${response.status}: ${await response.text()}`,
      );
    }

    const json = (await response.json()) as GraphQLResponse<T>;
    return json;
  }

  /**
   * Execute a query and assert no errors
   */
  async query<T = Record<string, unknown>>(
    queryStr: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const result = await this.execute<T>({ query: queryStr, variables });

    if (result.errors && result.errors.length > 0) {
      const errorMessages = result.errors.map((e) => e.message).join('; ');
      throw new Error(`GraphQL query errors: ${errorMessages}`);
    }

    if (!result.data) {
      throw new Error('GraphQL query returned no data');
    }

    return result.data;
  }

  /**
   * Execute a mutation and assert no errors
   */
  async mutate<T = Record<string, unknown>>(
    mutation: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    return this.query<T>(mutation, variables);
  }

  /**
   * Make a REST API call (for endpoints that are not GraphQL)
   */
  async rest<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (body && method !== 'GET') {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.baseUrl}${path}`, fetchOptions);

    let data: T;
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      data = (await response.json()) as T;
    } else {
      data = (await response.text()) as unknown as T;
    }

    return { status: response.status, data };
  }
}
