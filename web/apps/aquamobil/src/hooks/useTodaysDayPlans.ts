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
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { useAuth } from './useAuth';

import { GET_FEEDING_DAY_PLANS } from '@/graphql/operations';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { logger } from '@/utils/logger';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

export type MealStatus = 'SCHEDULED' | 'FED' | 'PARTIALLY_FED' | 'SKIPPED' | 'MISSED' | 'CANCELLED';

export interface DayPlanMeal {
  id: string;
  mealIndex: number;
  scheduledAt: string;
  percentOfDaily: number;
  plannedKg: number;
  status: MealStatus;
  actualKg: number;
  varianceKg: number | null;
  variancePercent: number | null;
  feedId: string;
  fedAt?: string | null;
  feedingMethod?: string | null;
  notes?: string | null;
}

export interface FeedingDayPlanSlice {
  id: string;
  unitId: string;
  unitName: string;
  unitCode: string;
  planDate: string;
  status: string;
  plannedTotalKg: number;
  unplannedActualKg: number;
  mealsPlanned: number;
  avgWeightG: number;
  fishCount: number;
  biomassKg: number;
  waterTempC: number | null;
  temperatureSource: string;
  usingDefaultTemperature: boolean;
  feedId: string;
  feedCode: string;
  feedName: string;
  effectiveRatePercent: number;
  expectedFcr: number;
  meals: DayPlanMeal[];
}

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
  /** Ağ yanıtı yok, ekran çevrimdışı cache'ten besleniyor. */
  isOfflineCached: boolean;
  planDate: string;
}

export function useTodaysDayPlans(): TodaysDayPlansResult {
  const { accessToken, tenantId, isAuthenticated } = useAuth();

  const planDate = useMemo(() => localPlanDate(), []);
  const cacheKey = `${DAY_PLANS_CACHE_PREFIX}${planDate}`;

  const [cachedSeed, setCachedSeed] = useState<FeedingDayPlanSlice[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    if (!tenantId) return;
    getCachedData<FeedingDayPlanSlice[]>(tenantId, cacheKey)
      .then((cached) => {
        if (!cancelled && cached) {
          setCachedSeed(cached);
        }
      })
      .catch((error: unknown) => {
        logger.error('[useTodaysDayPlans] failed to load cached day-plan seed', error);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, cacheKey]);

  const { data, isLoading, isSuccess } = useQuery<FeedingDayPlanSlice[]>({
    queryKey: createTenantQueryKey(tenantId, 'feedingDayPlans', tenantId, planDate),
    queryFn: async () => {
      if (!accessToken || !tenantId) {
        throw new Error('Not authenticated');
      }
      const result = await graphqlRequest<{ feedingDayPlans: FeedingDayPlanSlice[] }>(
        GET_FEEDING_DAY_PLANS,
        { planDate },
      );
      const plans = result.feedingDayPlans ?? [];
      // Çevrimdışı yazım TEK queryFn'de — hangi ekranın önce mount ettiği
      // artık cache'in yazılıp yazılmayacağını belirlemiyor.
      await cacheData(tenantId, cacheKey, plans, DAY_PLANS_CACHE_TTL_MS);
      return plans;
    },
    enabled: isAuthenticated && !!accessToken && !!tenantId,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 60,
    refetchOnWindowFocus: true,
  });

  const plans = isSuccess ? (data ?? []) : (cachedSeed ?? []);
  const isOfflineCached = !isSuccess && (cachedSeed?.length ?? 0) > 0;

  return { plans, isLoading, isOfflineCached, planDate };
}
