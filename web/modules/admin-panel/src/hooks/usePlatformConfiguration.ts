/**
 * usePlatformConfiguration — read + write platform settings against
 * config-service through the gateway's federated GraphQL (ORPHAN-HIGH-373).
 *
 * WHY GraphQL here: the legacy admin-api settings stores are retired (their
 * write endpoints return 410 Gone and the backing table was dropped);
 * config-service's effectiveConfiguration queries + setConfiguration mutation
 * are the platform SSoT for system configuration. Transport follows the
 * admin-panel's sanctioned precedent — useAdminQuery (TanStack Query over the
 * shared-ui graphqlClient) keyed by the adminKeys factory, with mutations
 * invalidating the settings cache slice (see hooks/useAdminQuery.ts and
 * hooks/useAdminMutation.ts).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { graphqlClient } from '@aquaculture/shared-ui';

import {
  PLATFORM_CONFIGURATIONS_QUERY,
  SET_PLATFORM_CONFIGURATION_MUTATION,
} from '../graphql/platform-configuration-operations';
import {
  PLATFORM_CONFIGURATION_SERVICE,
  mapPlatformSettings,
} from '../services/api/platform-configuration';
import type {
  EffectiveConfigurationRow,
  PlatformConfigurationWrite,
  PlatformSettingsSnapshot,
} from '../services/api/platform-configuration';
import { adminKeys } from './adminQueryKeys';
import { useAdminQuery } from './useAdminQuery';

interface PlatformConfigurationsResponse {
  effectiveConfigurationsByService: EffectiveConfigurationRow[];
}

interface SetConfigurationResponse {
  setConfiguration: EffectiveConfigurationRow;
}

/** Recorded in configuration_history for every save from this page. */
const SAVE_REASON = 'admin-panel system settings save';

/**
 * Fetch all platform-scope settings and map them into the page's tab models.
 */
export function usePlatformSettings(): {
  settings: PlatformSettingsSnapshot | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const query = useAdminQuery<PlatformConfigurationsResponse>(
    adminKeys.system.settings(),
    PLATFORM_CONFIGURATIONS_QUERY,
    { service: PLATFORM_CONFIGURATION_SERVICE },
    { staleTime: 30_000 },
  );

  return {
    settings: query.data
      ? mapPlatformSettings(query.data.effectiveConfigurationsByService)
      : undefined,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

/**
 * Save a batch of settings (one tab's writes) via setConfiguration.
 *
 * WHY one mutation wrapping N upserts instead of N useAdminMutation calls:
 * setConfiguration is a single-key mutation, so a tab save is a sequence of
 * upserts — batching them in one mutationFn keeps a single pending state for
 * the Save button and invalidates the settings cache exactly once, after the
 * whole batch landed (sequential on purpose: deterministic history order and
 * no write-pool contention).
 */
export function useSavePlatformSettings(): UseMutationResult<
  void,
  Error,
  PlatformConfigurationWrite[]
> {
  const queryClient = useQueryClient();

  return useMutation<void, Error, PlatformConfigurationWrite[]>({
    mutationFn: async (writes: PlatformConfigurationWrite[]): Promise<void> => {
      for (const write of writes) {
        await graphqlClient.request<SetConfigurationResponse>(SET_PLATFORM_CONFIGURATION_MUTATION, {
          service: PLATFORM_CONFIGURATION_SERVICE,
          key: write.key,
          value: write.value,
          isSecret: write.isSecret ?? false,
          reason: SAVE_REASON,
        });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminKeys.system.settings() });
    },
  });
}
