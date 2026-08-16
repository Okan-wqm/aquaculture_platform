/**
 * usePlatformConfiguration — read + write platform settings against
 * config-service through the gateway's federated GraphQL (ORPHAN-HIGH-373).
 *
 * WHY GraphQL here: the legacy admin-api settings stores are retired (their
 * write endpoints return 410 Gone and the backing table was dropped);
 * config-service's effectiveConfiguration queries + setConfiguration mutation
 * are the platform SSoT for system configuration. Generated TypedDocumentNode
 * contracts bind operation results and variables to the composed schema; the
 * admin GraphQL kernel is the sole transport capability.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';

import {
  PlatformConfigurationsDocument,
  SetPlatformConfigurationDocument,
} from '../generated/graphql';
import {
  PLATFORM_CONFIGURATION_SERVICE,
  decodeEffectiveConfigurationRows,
  mapPlatformSettings,
} from '../services/api/platform-configuration';
import type {
  PlatformConfigurationWrite,
  PlatformSettingsSnapshot,
} from '../services/api/platform-configuration';
import { executeAdminGraphql } from '../services/admin-graphql-client';
import { adminKeys } from './adminQueryKeys';

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
  const query = useQuery({
    queryKey: adminKeys.system.settings(),
    queryFn: ({ signal }) =>
      executeAdminGraphql(
        PlatformConfigurationsDocument,
        { service: PLATFORM_CONFIGURATION_SERVICE },
        { signal },
      ),
    staleTime: 30_000,
  });

  return {
    settings: query.data
      ? mapPlatformSettings(
          decodeEffectiveConfigurationRows(query.data.effectiveConfigurationsByService),
        )
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
 * WHY one mutation wrapping N upserts instead of N independent mutations:
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
        await executeAdminGraphql(SetPlatformConfigurationDocument, {
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
