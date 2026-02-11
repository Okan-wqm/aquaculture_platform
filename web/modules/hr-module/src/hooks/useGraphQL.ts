/**
 * GraphQL Client Hook for HR Module
 * Uses the shared graphqlClient from @aquaculture/shared-ui
 */

import { graphqlClient } from '@aquaculture/shared-ui';
import { print, type DocumentNode } from 'graphql';

/**
 * Hook to get the shared GraphQL client
 */
export function useGraphQLClient() {
  return graphqlClient;
}

/**
 * Generic GraphQL request function
 * Accepts both string queries and DocumentNode (from gql`` tags)
 */
export async function graphqlRequest<TData, TVariables>(
  client: typeof graphqlClient,
  document: string | DocumentNode,
  variables?: TVariables
): Promise<TData> {
  // Convert DocumentNode to string with all fragments included
  const query = typeof document === 'string' ? document : print(document);
  return client.request<TData, Record<string, unknown>>(query, variables as Record<string, unknown>);
}
