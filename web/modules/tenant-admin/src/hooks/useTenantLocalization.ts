/**
 * useTenantLocalization — tenant saat dilimi + dil ayarı (W5).
 *
 * Saat dilimi bir görünüm tercihi DEĞİLDİR: farm modülünün yemleme cron'ları
 * (plan üretimi, sabah süpürmesi, gün özeti, FCR ve stok kapsama süpürmeleri)
 * tenant'ın YEREL gününde koşar ve gün sınırını bu ayardan alır. Bu yüzden
 * ekran "yakında" bir stub olarak kalamazdı — motorun zamanlaması operatörün
 * göremediği bir sabite bağlıydı.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createTenantInvalidationKey,
  createTenantQueryKey,
  getTenantId,
} from '@aquaculture/shared-ui';

import { MY_TENANT_LOCALIZATION_QUERY, UPDATE_TENANT_LOCALIZATION_MUTATION } from '../graphql';
import { graphqlRequest } from '../services/tenant-api.service';

export interface TenantLocalization {
  timezone: string;
  locale: string | null;
}

export const localizationKeys = {
  all: () => createTenantInvalidationKey(getTenantId(), 'tenant-localization'),
  current: () => createTenantQueryKey(getTenantId(), 'tenant-localization', 'current'),
};

export function useTenantLocalization() {
  return useQuery({
    queryKey: localizationKeys.current(),
    queryFn: async (): Promise<TenantLocalization> => {
      const data = await graphqlRequest<{ myTenantLocalization: TenantLocalization }>(
        MY_TENANT_LOCALIZATION_QUERY,
      );
      return data.myTenantLocalization;
    },
  });
}

export function useUpdateTenantLocalization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { timezone: string; locale?: string | null }) => {
      const data = await graphqlRequest<{ updateTenantLocalization: TenantLocalization }>(
        UPDATE_TENANT_LOCALIZATION_MUTATION,
        { input: { timezone: input.timezone, locale: input.locale ?? null } },
      );
      return data.updateTenantLocalization;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(localizationKeys.current(), data);
      void queryClient.invalidateQueries({ queryKey: localizationKeys.all() });
    },
  });
}
