import { CONFIGURATION_CATALOG_DIGEST } from '@aquaculture/configuration-contracts';
import { graphqlClient } from '@aquaculture/shared-ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';

import {
  APPLY_CONFIGURATION_BATCH_MUTATION,
  CONFIGURATION_SNAPSHOT_QUERY,
} from '../graphql/platform-configuration-operations';
import type {
  ApplyConfigurationBatchInputV1,
  ConfigurationBatchReceiptV1,
  ConfigurationSnapshotV1,
} from '../services/api/platform-configuration';

import { adminKeys } from './adminQueryKeys';
import { useAdminQuery } from './useAdminQuery';

interface ConfigurationSnapshotResponse {
  configurationSnapshot: ConfigurationSnapshotV1;
}

interface ApplyConfigurationBatchResponse {
  applyConfigurationBatch: ConfigurationBatchReceiptV1;
}

export function usePlatformSettings(): {
  snapshot: ConfigurationSnapshotV1 | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const query = useAdminQuery<ConfigurationSnapshotResponse>(
    adminKeys.system.settings(),
    CONFIGURATION_SNAPSHOT_QUERY,
    { scope: { environment: 'ALL' } },
    { staleTime: 30_000 },
  );
  return {
    snapshot: query.data?.configurationSnapshot,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useSavePlatformSettings(): UseMutationResult<
  ConfigurationBatchReceiptV1,
  Error,
  Omit<ApplyConfigurationBatchInputV1, 'operationId' | 'catalogDigest' | 'environment'>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input): Promise<ConfigurationBatchReceiptV1> => {
      const response = await graphqlClient.request<ApplyConfigurationBatchResponse>(
        APPLY_CONFIGURATION_BATCH_MUTATION,
        {
          input: {
            ...input,
            operationId: crypto.randomUUID(),
            catalogDigest: CONFIGURATION_CATALOG_DIGEST,
            environment: 'ALL',
          },
        },
      );
      return response.applyConfigurationBatch;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminKeys.system.settings() });
    },
  });
}
