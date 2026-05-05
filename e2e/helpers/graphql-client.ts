/**
 * GraphQL Test Client
 * Provides typed GraphQL request execution for E2E tests.
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
  token: string;
  operationName?: string;
}

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:4000/graphql';
const FARM_SERVICE_URL = process.env.FARM_SERVICE_URL || 'http://localhost:3003/graphql';

export class GraphQLTestClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || GATEWAY_URL;
  }

  /**
   * Create a client pointing directly at the farm-service.
   */
  static forFarmService(): GraphQLTestClient {
    return new GraphQLTestClient(FARM_SERVICE_URL);
  }

  /**
   * Execute a GraphQL query/mutation with authorization.
   */
  async execute<T = Record<string, unknown>>(
    options: GraphQLRequestOptions,
  ): Promise<GraphQLResponse<T>> {
    const { query, variables, token, operationName } = options;

    const body: Record<string, unknown> = { query };
    if (variables) body.variables = variables;
    if (operationName) body.operationName = operationName;

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `GraphQL HTTP error: ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as GraphQLResponse<T>;
    return json;
  }

  /**
   * Execute and expect success (no errors, data present).
   */
  async executeSuccess<T = Record<string, unknown>>(
    options: GraphQLRequestOptions,
  ): Promise<T> {
    const result = await this.execute<T>(options);
    if (result.errors && result.errors.length > 0) {
      throw new Error(
        `GraphQL errors: ${result.errors.map((e) => e.message).join(', ')}`,
      );
    }
    if (!result.data) {
      throw new Error('GraphQL response has no data');
    }
    return result.data;
  }

  /**
   * Execute and expect errors (returns the errors array).
   */
  async executeExpectError(
    options: GraphQLRequestOptions,
  ): Promise<Array<{ message: string; extensions?: Record<string, unknown> }>> {
    const result = await this.execute(options);
    if (!result.errors || result.errors.length === 0) {
      throw new Error(
        `Expected GraphQL errors but got success: ${JSON.stringify(result.data)}`,
      );
    }
    return result.errors;
  }
}
