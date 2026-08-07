// ============================================================================
// useVfdDrives — the read hooks for the VFD surface (ORPHAN-MEDIUM-575)
// ============================================================================
//
// Every hook here returns the raw `UseQueryResult`, which is what keeps the
// query-error-surface invariant satisfied BY CONSTRUCTION rather than by
// remembering to pass `isError` along: the caller destructures the error arm off
// the query object, or wraps it with `toLoadable` and cannot reach `data`
// without deciding what a failure means (src/utils/loadable.ts).
//
// NOTHING HERE IS CACHED FOR OFFLINE USE, and that is the one deliberate
// difference from `useTanks` and `useLatestReadings`, both of which serve a
// last-known snapshot from the encrypted tenant cache when the network is gone.
// Those describe fish and water — a biomass figure from an hour ago, stamped
// with its age, is still worth having. A drive's run state is a claim about
// whether a shaft is turning RIGHT NOW. Serving "Running" from cache to a worker
// standing next to a silent auger, or "Stopped" next to a turning one, would be
// worse than saying nothing. So a failed fetch here surfaces as an error and the
// screens render "unavailable" — never a state.

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useAuth } from './useAuth';

import type {
  MobileFeederSetupQuery,
  MobileUnitDrivesQuery,
  MobileVfdDriveQuery,
  MobileVfdFleetQuery,
  MobileVfdFleetSummaryQuery,
} from '@/generated/graphql';
import {
  MOBILE_FEEDER_SETUP,
  MOBILE_UNIT_DRIVES,
  MOBILE_VFD_DRIVE,
  MOBILE_VFD_FLEET,
  MOBILE_VFD_FLEET_SUMMARY,
} from '@/graphql/vfd-operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

/**
 * How often a mounted drive surface re-asks.
 *
 * Faster than the 45s water-readings poll because a run state changes on a
 * button press rather than on a tide, and a screen showing a drive somebody just
 * started should catch up within a glance. Slower than a second, because the
 * server reads these through the edge gateway and this app runs on a phone with
 * a battery.
 */
export const DRIVE_POLL_INTERVAL_MS = 20_000;

/** How many drives one page of the fleet index holds. The server caps `limit` at 100. */
export const DRIVE_PAGE_SIZE = 50;

/**
 * The drive index: fleet counts plus the first page of drives.
 *
 * NOT polled. This screen answers "which drives exist", which is a
 * configuration question, and its `VfdDeviceOutput` rows carry no run state to
 * keep fresh (see src/graphql/vfd-operations.ts for why that shape is narrower).
 */
export function useVfdFleet(): UseQueryResult<MobileVfdFleetQuery, Error> {
  const { tenantId, isAuthenticated } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'vfd-fleet'),
    enabled: isAuthenticated && Boolean(tenantId),
    queryFn: () =>
      graphqlRequest(MOBILE_VFD_FLEET, {
        pagination: { page: 1, limit: DRIVE_PAGE_SIZE, sortBy: 'name', sortOrder: 'ASC' },
      }),
  });
}

/** Fleet counts alone — for surfaces that show the totals beside something else. */
export function useVfdFleetSummary(): UseQueryResult<MobileVfdFleetSummaryQuery, Error> {
  const { tenantId, isAuthenticated } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'vfd-fleet-summary'),
    enabled: isAuthenticated && Boolean(tenantId),
    queryFn: () => graphqlRequest(MOBILE_VFD_FLEET_SUMMARY),
  });
}

/** One drive in full, polled while its screen is open. */
export function useVfdDrive(
  vfdDeviceId: string | undefined,
): UseQueryResult<MobileVfdDriveQuery, Error> {
  const { tenantId, isAuthenticated } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'vfd-drive', vfdDeviceId ?? 'none'),
    enabled: isAuthenticated && Boolean(tenantId) && Boolean(vfdDeviceId),
    refetchInterval: DRIVE_POLL_INTERVAL_MS,
    queryFn: () => graphqlRequest(MOBILE_VFD_DRIVE, { id: vfdDeviceId ?? '' }),
  });
}

/**
 * The drives serving one unit, polled while their surface is open.
 *
 * ONE unit, deliberately. There is no query that returns the full drive shape
 * for many units at once — `vfdDevices` can filter by unit but resolves to the
 * projection that carries no binding and no reading — so a fleet-wide "every
 * unit's drives" view would mean one round trip per unit. This app already
 * refuses that pattern once (useLatestReadings batches its sensors into a single
 * `latestReadingsBatch` call rather than N), and a cabin board firing thirty
 * requests on every poll is the same mistake with a longer interval.
 */
export function useUnitDrives(
  tankId: string | null | undefined,
): UseQueryResult<MobileUnitDrivesQuery, Error> {
  const { tenantId, isAuthenticated } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'vfd-unit-drives', tankId ?? 'none'),
    enabled: isAuthenticated && Boolean(tenantId) && Boolean(tankId),
    refetchInterval: DRIVE_POLL_INTERVAL_MS,
    queryFn: () => graphqlRequest(MOBILE_UNIT_DRIVES, { tankId: tankId ?? '' }),
  });
}

/**
 * A feeder's capability plus its calibrations, from farm-service.
 *
 * Asked only for equipment the drive binding has attested as a feeder — see
 * `isFeederDrive` in src/utils/vfd-drive.ts. Not polled: a calibration changes
 * when somebody weighs a dose, not while a screen is open.
 */
export function useFeederSetup(
  equipmentId: string | null | undefined,
): UseQueryResult<MobileFeederSetupQuery, Error> {
  const { tenantId, isAuthenticated } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feeder-setup', equipmentId ?? 'none'),
    enabled: isAuthenticated && Boolean(tenantId) && Boolean(equipmentId),
    queryFn: () => graphqlRequest(MOBILE_FEEDER_SETUP, { equipmentId: equipmentId ?? '' }),
  });
}
