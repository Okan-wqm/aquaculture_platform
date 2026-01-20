/**
 * GraphQL Client Hook for HR Module
 * Provides configured GraphQL client with authentication and tenant context
 */

import { useMemo } from 'react';
import { GraphQLClient } from 'graphql-request';
import { useAuth } from '@shared-ui/hooks';

const GRAPHQL_ENDPOINT = import.meta.env.VITE_HR_SERVICE_URL || '/api/hr/graphql';

/**
 * Hook to get a configured GraphQL client
 */
export function useGraphQLClient(): GraphQLClient {
  const { token } = useAuth();

  const client = useMemo(() => {
    return new GraphQLClient(GRAPHQL_ENDPOINT, {
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
      },
    });
  }, [token]);

  return client;
}

/**
 * Generic GraphQL request function with error handling
 */
export async function graphqlRequest<TData, TVariables>(
  client: GraphQLClient,
  document: string,
  variables?: TVariables
): Promise<TData> {
  try {
    return await client.request<TData>(document, variables as Record<string, unknown>);
  } catch (error) {
    // Extract meaningful error message from GraphQL errors
    if (error instanceof Error) {
      const graphqlError = error as { response?: { errors?: { message: string }[] } };
      if (graphqlError.response?.errors?.[0]?.message) {
        throw new Error(graphqlError.response.errors[0].message);
      }
    }
    throw error;
  }
}
