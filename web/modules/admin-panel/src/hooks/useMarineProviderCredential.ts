/**
 * useMarineProviderCredential — read the company marine provider credential
 * status and store a new CDSE credential, against config-service through the
 * gateway's federated GraphQL (ADMIN-HIGH-135).
 *
 * Transport follows the admin-panel's sanctioned precedent — useAdminQuery
 * (TanStack Query over the shared-ui graphqlClient) keyed by the adminKeys
 * factory, with the mutation invalidating the status slice it changes (see
 * hooks/useAdminQuery.ts and hooks/useAdminMutation.ts).
 */

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { graphqlClient } from '@aquaculture/shared-ui';

import {
  MARINE_PROVIDER_CREDENTIAL_STATUS_QUERY,
  SET_MARINE_PROVIDER_CDSE_CREDENTIAL_MUTATION,
} from '../graphql/marine-provider-credential-operations';
import { adminKeys } from './adminQueryKeys';
import { useAdminMutation } from './useAdminMutation';
import { useAdminQuery } from './useAdminQuery';

/** Mirrors config-service's `MarineProviderCredentialProvider` GraphQL enum. */
export type MarineProviderCredentialProvider = 'CDSE';

/** Mirrors config-service's `MarineProviderCredentialStatusDto`. */
export interface MarineProviderCredentialStatus {
  provider: MarineProviderCredentialProvider;
  configured: boolean;
  version: number | null;
  /** ISO-8601 as GraphQL DateTime serializes it; null when nothing is stored. */
  updatedAt: string | null;
}

/** Mirrors config-service's `SetMarineProviderCdseCredentialInput`. */
export interface SetMarineProviderCdseCredentialInput {
  clientId: string;
  clientSecret: string;
  instanceId?: string;
  reason?: string;
}

interface StatusResponse {
  marineProviderCredentialStatus: MarineProviderCredentialStatus;
}

interface SetCdseCredentialResponse {
  setMarineProviderCdseCredential: MarineProviderCredentialStatus;
}

export function useMarineProviderCredentialStatus(
  provider: MarineProviderCredentialProvider,
): UseQueryResult<MarineProviderCredentialStatus, Error> {
  return useAdminQuery<MarineProviderCredentialStatus>(
    adminKeys.system.providerCredential(provider),
    async ({ signal }) => {
      const response = await graphqlClient.request<StatusResponse>(
        MARINE_PROVIDER_CREDENTIAL_STATUS_QUERY,
        { provider },
        { signal },
      );
      return response.marineProviderCredentialStatus;
    },
    { staleTime: 30_000 },
  );
}

export function useSetMarineProviderCdseCredential(): UseMutationResult<
  MarineProviderCredentialStatus,
  Error,
  SetMarineProviderCdseCredentialInput
> {
  return useAdminMutation<MarineProviderCredentialStatus, SetMarineProviderCdseCredentialInput>(
    async (
      input: SetMarineProviderCdseCredentialInput,
    ): Promise<MarineProviderCredentialStatus> => {
      const response = await graphqlClient.request<SetCdseCredentialResponse>(
        SET_MARINE_PROVIDER_CDSE_CREDENTIAL_MUTATION,
        { input },
      );
      return response.setMarineProviderCdseCredential;
    },
    { invalidateKeys: [adminKeys.system.providerCredential('CDSE')] },
  );
}
