/**
 * useTodaysDayPlans — bugünün gün planlarının TEK okuyucusu (W8 —
 * FARM-LOW-281).
 *
 * ## Neden tek hook
 *
 * `RecordFeedingPage` ve `useDailyOpsStats` AYNI `feedingDayPlans` sorgusunu,
 * AYNI React Query anahtarıyla, iki ayrı `queryFn` ile çalıştırıyordu. Anahtar
 * paylaşıldığı için yalnız İLK mount eden hook'un `queryFn`'i koşuyor —
 * ikincisi taze cache'i okuyup kendi fonksiyonunu hiç çağırmıyor. Ana sayfa
 * (`useDailyOpsStats`) hemen her zaman önce mount ettiği ve `cacheData`
 * ÇAĞIRMADIĞI için, RecordFeedingPage'in çevrimdışı plan cache'i pratikte
 * HİÇ yazılmıyordu: operatör sahada offline'a düştüğünde plan boş geliyordu —
 * yani cutover'da eklenen çevrimdışı yemleme yeteneği fiilen çalışmıyordu.
 *
 * Anahtarı ve çevrimdışı yazımı TEK yerde tutmak bu sınıfı yapısal olarak
 * kapatır (tier-1): tek `queryFn` var, dolayısıyla "hangi hook önce mount
 * etti" sorusunun cevabı davranışı değiştiremez.
 *
 * Cache kolaylıktır, otorite değildir — sunucu `recordMealFeeding`/
 * `finalizeMeal` komutlarını her hâlükârda yeniden doğrular; bu yüzden TTL
 * kısa tutulur (bariz bayat bir plan işçiyi yanıltmaktansa süresi dolsun).
 *
 * MOB-MEDIUM-031: the cached plans are read through the caller's offline cache
 * scope (tenant + user + moduleAccess) and stand in only when the server cannot
 * be reached. The seed this hook used to read on mount showed cached plans while
 * the query loaded and kept them after it failed — a refusal included — so it is
 * gone: `isOfflineCached` now means the query itself answered from the cache.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAuth } from './useAuth';
import { useOfflineCacheScope } from './useOfflineCacheScope';

import type { FeedingDayPlansQuery } from '@/generated/graphql';
import { GET_FEEDING_DAY_PLANS } from '@/graphql/operations';
import { readThroughOfflineCache, type OfflineRead } from '@/pwa/offline-cache';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

// MOB-HIGH-022: the slice, its meals and the meal status are the generated
// result of the document below — the wire vocabulary is checked by `tsc`, not
// re-declared by hand.
export type FeedingDayPlanSlice = FeedingDayPlansQuery['feedingDayPlans'][number];
export type DayPlanMeal = NonNullable<FeedingDayPlanSlice['meals']>[number];
export type MealStatus = DayPlanMeal['status'];

const DAY_PLANS_CACHE_PREFIX = 'feedingDayPlans_';
const DAY_PLANS_CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12h

/** Yerel takvim günü — sunucunun `planDate` semantiğiyle aynı biçim. */
export function localPlanDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

export interface TodaysDayPlansResult {
  plans: FeedingDayPlanSlice[];
  isLoading: boolean;
  /**
   * Sorgu düştü mü. Hata kolu DIŞARI VERİLİR: yutulursa ekran "bugün plan yok"
   * ile "planı okuyamadım"ı ayırt edemez ve outage otoriter bir iddiaya
   * dönüşür (src/utils/loadable.ts).
   */
  isError: boolean;
  /** Ağ yanıtı yok, ekran çevrimdışı cache'ten besleniyor. */
  isOfflineCached: boolean;
  /** Düşen sorguyu yeniden dener. */
  retry: () => void;
  planDate: string;
}

export function useTodaysDayPlans(): TodaysDayPlansResult {
  const { accessToken, tenantId, isAuthenticated } = useAuth();
  const cacheScope = useOfflineCacheScope();

  const planDate = useMemo(() => localPlanDate(), []);
  const cacheKey = `${DAY_PLANS_CACHE_PREFIX}${planDate}`;

  const { data, isLoading, isError, refetch } = useQuery<OfflineRead<FeedingDayPlanSlice[]>>({
    queryKey: createTenantQueryKey(tenantId, 'feedingDayPlans', tenantId, planDate),
    queryFn: async () => {
      if (!accessToken || !tenantId) {
        throw new Error('Not authenticated');
      }
      // Çevrimdışı yazım TEK queryFn'de — hangi ekranın önce mount ettiği
      // artık cache'in yazılıp yazılmayacağını belirlemiyor.
      return readThroughOfflineCache(
        cacheScope,
        { key: cacheKey, ttlMs: DAY_PLANS_CACHE_TTL_MS },
        async () => {
          const result = await graphqlRequest(GET_FEEDING_DAY_PLANS, { planDate });
          return result.feedingDayPlans;
        },
      );
    },
    enabled: isAuthenticated && !!accessToken && !!tenantId,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 60,
    refetchOnWindowFocus: true,
  });

  const plans = data?.data ?? [];
  const isOfflineCached = data?.servedFromCache === true && plans.length > 0;

  return {
    plans,
    isLoading,
    isError,
    isOfflineCached,
    retry: () => {
      void refetch();
    },
    planDate,
  };
}
