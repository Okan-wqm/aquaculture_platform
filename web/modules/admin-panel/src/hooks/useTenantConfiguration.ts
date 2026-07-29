/**
 * useTenantConfiguration — read + write ONE tenant's settings against
 * config-service through the gateway's federated GraphQL.
 *
 * Mirrors hooks/usePlatformConfiguration.ts exactly, with one difference that
 * is the entire point: every operation names the target `tenantId`. Without
 * that argument config-service resolved scope from the caller's own JWT, and
 * SUPER_ADMIN — the platform's only tenantless principal — always landed on the
 * SYSTEM rows, so per-tenant configuration was unreachable and admin-api kept a
 * parallel store that was later dropped on a promise nothing could keep.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { graphqlClient } from '@aquaculture/shared-ui';

import {
  SET_TENANT_CONFIGURATION_MUTATION,
  TENANT_CONFIGURATIONS_QUERY,
} from '../graphql/tenant-configuration-operations';
import {
  TENANT_SETTINGS_SERVICE,
  createTenantSettingsReader,
} from '../services/api/tenant-configuration';
import type { TenantSettingWrite, TenantSettingsReader } from '../services/api/tenant-configuration';
import type { EffectiveConfigurationRow } from '../services/api/effective-configuration';
import { adminKeys } from './adminQueryKeys';
import { useAdminQuery } from './useAdminQuery';

interface TenantConfigurationsResponse {
  effectiveConfigurationsByService: EffectiveConfigurationRow[];
}

interface SetConfigurationResponse {
  setConfiguration: { key: string; value: unknown; version: number };
}

/** Recorded in configuration_history for every save from this page. */
const SAVE_REASON = 'admin-panel tenant settings save';

/**
 * Fetch one tenant's effective settings and expose them through the typed
 * vocabulary reader.
 */
export function useTenantSettings(tenantId: string): {
  settings: TenantSettingsReader | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const query = useAdminQuery<TenantConfigurationsResponse>(
    adminKeys.tenants.settings(tenantId),
    TENANT_CONFIGURATIONS_QUERY,
    { service: TENANT_SETTINGS_SERVICE, tenantId },
    { staleTime: 30_000, enabled: tenantId.length > 0 },
  );

  return {
    settings: query.data
      ? createTenantSettingsReader(query.data.effectiveConfigurationsByService)
      : undefined,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

/**
 * Save one tab's writes.
 *
 * `setConfiguration` is a single-key mutation, so a tab save is a sequence of
 * upserts. Batching them in one mutationFn keeps a single pending state for the
 * Save button and invalidates this tenant's cache slice exactly once, after the
 * whole batch landed — sequential on purpose, for deterministic history order.
 */
export function useSaveTenantSettings(
  tenantId: string,
): UseMutationResult<void, Error, readonly TenantSettingWrite[]> {
  const queryClient = useQueryClient();

  return useMutation<void, Error, readonly TenantSettingWrite[]>({
    mutationFn: async (writes: readonly TenantSettingWrite[]): Promise<void> => {
      for (const write of writes) {
        await graphqlClient.request<SetConfigurationResponse>(SET_TENANT_CONFIGURATION_MUTATION, {
          service: TENANT_SETTINGS_SERVICE,
          tenantId,
          key: write.key,
          value: write.value,
          reason: SAVE_REASON,
        });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminKeys.tenants.settings(tenantId) });
    },
  });
}
