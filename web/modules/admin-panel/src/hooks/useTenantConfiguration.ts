/**
 * Tenant settings transport. The route tenant id is carried as a typed
 * GraphQL variable; config-service remains the only mutation authority.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';

import { SetTenantConfigurationDocument, TenantConfigurationsDocument } from '../generated/graphql';
import {
  TENANT_SETTINGS_SERVICE,
  assertTenantSettingWriteReceipt,
  createTenantSettingsReader,
} from '../services/api/tenant-configuration';
import type {
  TenantSettingsReader,
  TenantSettingWrite,
} from '../services/api/tenant-configuration';
import { decodeEffectiveConfigurationRows } from '../services/api/effective-configuration';
import { executeAdminGraphql } from '../services/admin-graphql-client';
import { adminKeys } from './adminQueryKeys';

const SAVE_REASON = 'admin-panel tenant settings save';

export function useTenantSettings(tenantId: string): {
  settings: TenantSettingsReader | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: adminKeys.tenants.settings(tenantId),
    queryFn: async ({ signal }) => {
      const result = await executeAdminGraphql(
        TenantConfigurationsDocument,
        { service: TENANT_SETTINGS_SERVICE, tenantId },
        { signal },
      );
      return createTenantSettingsReader(
        decodeEffectiveConfigurationRows(result.effectiveConfigurationsByService),
      );
    },
    staleTime: 30_000,
    enabled: tenantId.length > 0,
  });

  return {
    settings: query.data,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

/**
 * Saves a section in vocabulary order. Each write is independently durable and
 * history-versioned by config-service; UI success is emitted only when all
 * receipts return, and the tenant cache projection is invalidated once.
 */
export function useSaveTenantSettings(
  tenantId: string,
): UseMutationResult<void, Error, readonly TenantSettingWrite[]> {
  const queryClient = useQueryClient();

  return useMutation<void, Error, readonly TenantSettingWrite[]>({
    mutationFn: async (writes): Promise<void> => {
      for (const write of writes) {
        const result = await executeAdminGraphql(SetTenantConfigurationDocument, {
          service: TENANT_SETTINGS_SERVICE,
          tenantId,
          key: write.key,
          value: write.value,
          reason: SAVE_REASON,
        });
        assertTenantSettingWriteReceipt(write, result.setConfiguration);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminKeys.tenants.settings(tenantId) });
    },
  });
}
