import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { FeedingMethodGraphqlNameV1 } from '@aquaculture/feeding-contracts/feeding-record-vocabulary';

import { useAuth } from './useAuth';

import { GET_FEEDING_DAY_PLANS } from '@/graphql/operations';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { logger } from '@/utils/logger';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

export type MealStatus =
  | 'SCHEDULED'
  | 'FED'
  | 'PARTIALLY_FED'
  | 'SKIPPED'
  | 'MISSED'
  | 'CANCELLED';

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
  feedingMethod?: FeedingMethodGraphqlNameV1 | null;
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
const DAY_PLANS_CACHE_TTL_MS = 1000 * 60 * 60 * 12;

/** Canonical local calendar coordinate used by the day-plan API and cache. */
export function localPlanDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

export interface TodaysDayPlansResult {
  plans: FeedingDayPlanSlice[];
  isLoading: boolean;
  isOfflineCached: boolean;
  planDate: string;
}

/**
 * Sole owner of today's feeding-plan query key, network reader, and encrypted
 * offline-cache projection. Multiple screens may consume this hook without
 * registering competing query functions under the same React Query identity.
 */
export function useTodaysDayPlans(): TodaysDayPlansResult {
  const { accessToken, tenantId, isAuthenticated } = useAuth();
  const planDate = useMemo(() => localPlanDate(), []);
  const cacheKey = `${DAY_PLANS_CACHE_PREFIX}${planDate}`;
  const [cachedSeed, setCachedSeed] = useState<FeedingDayPlanSlice[] | undefined>();

  useEffect(() => {
    let active = true;
    if (!tenantId) return undefined;
    void getCachedData<FeedingDayPlanSlice[]>(tenantId, cacheKey)
      .then((cached) => {
        if (active && cached !== null) setCachedSeed(cached);
      })
      .catch((error: unknown) => {
        logger.error('[useTodaysDayPlans] failed to load cached day-plan seed', error);
      });
    return () => {
      active = false;
    };
  }, [tenantId, cacheKey]);

  const { data, isLoading, isSuccess } = useQuery<FeedingDayPlanSlice[]>({
    queryKey: createTenantQueryKey(tenantId, 'feedingDayPlans', tenantId, planDate),
    queryFn: async () => {
      if (!accessToken || !tenantId) throw new Error('Not authenticated');
      const result = await graphqlRequest<{ feedingDayPlans: FeedingDayPlanSlice[] }>(
        GET_FEEDING_DAY_PLANS,
        { planDate },
      );
      const plans = result.feedingDayPlans ?? [];
      await cacheData(tenantId, cacheKey, plans, DAY_PLANS_CACHE_TTL_MS);
      return plans;
    },
    enabled: isAuthenticated && !!accessToken && !!tenantId,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 60,
    refetchOnWindowFocus: true,
  });

  const plans = isSuccess ? (data ?? []) : (cachedSeed ?? []);
  return {
    plans,
    isLoading,
    isOfflineCached: !isSuccess && (cachedSeed?.length ?? 0) > 0,
    planDate,
  };
}
