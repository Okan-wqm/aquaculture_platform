/**
 * GraphQL Client Helper for E2E Integration Tests
 *
 * Sends GraphQL queries/mutations to the gateway (localhost:4000/graphql)
 * and returns typed responses. Handles authentication via Bearer tokens.
 */

const GATEWAY_URL = process.env['GATEWAY_URL'] || 'http://localhost:4000/graphql';

export interface GraphQLResponse<T = Record<string, unknown>> {
  data: T | null;
  errors?: Array<{
    message: string;
    extensions?: {
      code?: string;
      originalError?: {
        statusCode?: number;
        message?: string;
      };
    };
    path?: string[];
  }>;
}

export interface GraphQLRequestOptions {
  token?: string;
  tenantId?: string;
  cookies?: string;
}

/**
 * Execute a GraphQL query/mutation against the gateway.
 */
export async function graphqlRequest<T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown> = {},
  options: GraphQLRequestOptions = {},
): Promise<GraphQLResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  if (options.tenantId) {
    headers['x-tenant-id'] = options.tenantId;
  }

  if (options.cookies) {
    headers['Cookie'] = options.cookies;
  }

  const response = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  const json = (await response.json()) as GraphQLResponse<T>;
  return json;
}

/**
 * Execute a GraphQL mutation and assert no errors.
 */
export async function graphqlMutation<T = Record<string, unknown>>(
  mutation: string,
  variables: Record<string, unknown> = {},
  options: GraphQLRequestOptions = {},
): Promise<T> {
  const result = await graphqlRequest<T>(mutation, variables, options);
  if (result.errors && result.errors.length > 0) {
    const errorMessages = result.errors.map((e) => e.message).join('; ');
    throw new Error(`GraphQL mutation failed: ${errorMessages}`);
  }
  if (!result.data) {
    throw new Error('GraphQL mutation returned null data');
  }
  return result.data;
}

/**
 * Execute a GraphQL query and assert no errors.
 */
export async function graphqlQuery<T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown> = {},
  options: GraphQLRequestOptions = {},
): Promise<T> {
  const result = await graphqlRequest<T>(query, variables, options);
  if (result.errors && result.errors.length > 0) {
    const errorMessages = result.errors.map((e) => e.message).join('; ');
    throw new Error(`GraphQL query failed: ${errorMessages}`);
  }
  if (!result.data) {
    throw new Error('GraphQL query returned null data');
  }
  return result.data;
}

/**
 * Check if a GraphQL response contains an error with a specific code or message pattern.
 */
export function hasGraphQLError(
  response: GraphQLResponse,
  pattern: string | RegExp,
): boolean {
  if (!response.errors) return false;
  return response.errors.some((error) => {
    if (typeof pattern === 'string') {
      return (
        error.message.includes(pattern) ||
        error.extensions?.code === pattern ||
        error.extensions?.originalError?.message?.includes(pattern) === true
      );
    }
    return (
      pattern.test(error.message) ||
      (error.extensions?.originalError?.message
        ? pattern.test(error.extensions.originalError.message)
        : false)
    );
  });
}

/**
 * Extract the HTTP status code from a GraphQL error response.
 */
export function getGraphQLErrorStatus(response: GraphQLResponse): number | undefined {
  if (!response.errors || response.errors.length === 0) return undefined;
  const firstError = response.errors[0];
  return firstError?.extensions?.originalError?.statusCode;
}
