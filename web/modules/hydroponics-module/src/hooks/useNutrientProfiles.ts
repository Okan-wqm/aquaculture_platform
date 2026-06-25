import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useAuth, graphqlClient, tenantScopedStorageKey } from '@aquaculture/shared-ui';
import type { NutrientProfile } from '../types/modes.types';
import {
  CONFIGURATIONS_QUERY,
  CREATE_CONFIGURATION_MUTATION,
  UPDATE_CONFIGURATION_MUTATION,
} from '../graphql/hydroponics.operations';
import type { HydroponicsConfig } from './useHydroponicsConfig';
// PERF-HYD-007: Do NOT statically import getDefaultProfilesWithIds here.
// The dynamic import below in importDefaults() ensures the full DEFAULT_NUTRIENT_PROFILES
// dataset is tree-shaken from the initial bundle and only loaded on demand.

const STORAGE_KEY_PREFIX = 'nutrient_profiles';
const CONFIG_NAME = 'nutrient-profiles';

// Returns null when no tenant is resolved so callers skip localStorage entirely
// rather than reading/writing a shared 'default' bucket that bleeds nutrient
// profiles (potentially PII-adjacent agronomic config) across tenants.
function getStorageKey(tenantId: string | null | undefined): string | null {
  return tenantScopedStorageKey(STORAGE_KEY_PREFIX, tenantId);
}

// SEC-HYD-001: Runtime schema guard — reject any profile that does not conform to
// the expected shape with numeric fields within agronomically plausible bounds.
function isValidProfile(p: unknown): p is NutrientProfile {
  if (typeof p !== 'object' || p === null) return false;
  const profile = p as Record<string, unknown>;
  return (
    typeof profile.id === 'string' && profile.id.length > 0 &&
    typeof profile.species === 'string' && profile.species.length > 0 &&
    typeof profile.cultivationStage === 'string' && profile.cultivationStage.length > 0 &&
    typeof profile.season === 'string' && profile.season.length > 0 &&
    typeof profile.ec === 'number' && isFinite(profile.ec) && profile.ec >= 0 && profile.ec <= 20 &&
    typeof profile.ph === 'number' && isFinite(profile.ph) && profile.ph >= 0 && profile.ph <= 14 &&
    typeof profile.kRatio === 'number' && isFinite(profile.kRatio) && profile.kRatio >= 0 && profile.kRatio <= 1 &&
    typeof profile.caRatio === 'number' && isFinite(profile.caRatio) && profile.caRatio >= 0 && profile.caRatio <= 1 &&
    typeof profile.mgRatio === 'number' && isFinite(profile.mgRatio) && profile.mgRatio >= 0 && profile.mgRatio <= 1 &&
    typeof profile.nkRatio === 'number' && isFinite(profile.nkRatio) && profile.nkRatio >= 0 && profile.nkRatio <= 10 &&
    typeof profile.nh4Ratio === 'number' && isFinite(profile.nh4Ratio) && profile.nh4Ratio >= 0 && profile.nh4Ratio <= 1 &&
    typeof profile.p === 'number' && isFinite(profile.p) && profile.p >= 0 && profile.p <= 50 &&
    typeof profile.cl === 'number' && isFinite(profile.cl) && profile.cl >= 0 && profile.cl <= 50 &&
    typeof profile.si === 'number' && isFinite(profile.si) && profile.si >= 0 && profile.si <= 50 &&
    typeof profile.minSO4 === 'number' && isFinite(profile.minSO4) && profile.minSO4 >= 0 && profile.minSO4 <= 50 &&
    typeof profile.fe === 'number' && isFinite(profile.fe) && profile.fe >= 0 && profile.fe <= 1000 &&
    typeof profile.mn === 'number' && isFinite(profile.mn) && profile.mn >= 0 && profile.mn <= 1000 &&
    typeof profile.zn === 'number' && isFinite(profile.zn) && profile.zn >= 0 && profile.zn <= 1000 &&
    typeof profile.cu === 'number' && isFinite(profile.cu) && profile.cu >= 0 && profile.cu <= 100 &&
    typeof profile.b === 'number' && isFinite(profile.b) && profile.b >= 0 && profile.b <= 1000 &&
    typeof profile.mo === 'number' && isFinite(profile.mo) && profile.mo >= 0 && profile.mo <= 100
  );
}

function loadProfilesFromStorage(storageKey: string | null): NutrientProfile[] {
  if (!storageKey) return [];
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // SEC-HYD-001: Only accept records that pass the schema guard
    return parsed.filter(isValidProfile);
  } catch {
    return [];
  }
}

function persistProfilesToStorage(storageKey: string | null, profiles: NutrientProfile[]): void {
  if (!storageKey) return;
  localStorage.setItem(storageKey, JSON.stringify(profiles));
}

/**
 * Extract profiles array from a backend config's JSONB settings.
 * The config stores profiles under settings.profiles.
 */
function extractProfilesFromConfig(config: HydroponicsConfig): NutrientProfile[] {
  const settings = config.settings as Record<string, unknown>;
  const profiles = settings?.profiles;
  if (!Array.isArray(profiles)) return [];
  return profiles.filter(isValidProfile);
}

export function useNutrientProfiles() {
  const { token, tenantId, isAuthenticated } = useAuth();
  const storageKey = useMemo(() => getStorageKey(tenantId), [tenantId]);
  const [profiles, setProfiles] = useState<NutrientProfile[]>(() => loadProfilesFromStorage(storageKey));
  // Track the backend config ID so updates go to the same row
  const configIdRef = useRef<string | null>(null);
  const initialLoadDone = useRef(false);

  // On mount, attempt to load from backend; fall back to localStorage
  useEffect(() => {
    if (initialLoadDone.current) return;
    if (!isAuthenticated || !token || !tenantId) return;

    initialLoadDone.current = true;

    graphqlClient
      .request<{ hydroponicsConfigurations: HydroponicsConfig[] }>(CONFIGURATIONS_QUERY, {
        type: CONFIG_NAME,
      })
      .then((data) => {
        const configs = data.hydroponicsConfigurations;
        if (configs.length > 0) {
          const remote = configs[0];
          configIdRef.current = remote.id;
          const remoteProfiles = extractProfilesFromConfig(remote);
          if (remoteProfiles.length > 0) {
            setProfiles(remoteProfiles);
            persistProfilesToStorage(storageKey, remoteProfiles);
          }
        }
      })
      .catch(() => {
        // Offline or backend unavailable — localStorage data is already loaded
      });
  }, [isAuthenticated, token, tenantId]);

  // Reload profiles when tenantId changes
  useEffect(() => {
    setProfiles(loadProfilesFromStorage(storageKey));
  }, [storageKey]);

  // Keep localStorage in sync as offline fallback
  useEffect(() => {
    persistProfilesToStorage(storageKey, profiles);
  }, [profiles, storageKey]);

  /**
   * Persist the current profiles array to the backend.
   * Creates a config row on first call, updates on subsequent calls.
   */
  const syncToBackend = useCallback(
    async (nextProfiles: NutrientProfile[]) => {
      if (!isAuthenticated || !token || !tenantId) return;

      const settings = { profiles: nextProfiles };

      try {
        if (configIdRef.current) {
          await graphqlClient.request<{ updateHydroponicsConfiguration: HydroponicsConfig }>(
            UPDATE_CONFIGURATION_MUTATION,
            { input: { id: configIdRef.current, settings } }
          );
        } else {
          const data = await graphqlClient.request<{ createHydroponicsConfiguration: HydroponicsConfig }>(
            CREATE_CONFIGURATION_MUTATION,
            { input: { configName: CONFIG_NAME, settings } }
          );
          configIdRef.current = data.createHydroponicsConfiguration.id;
        }
      } catch {
        // Backend sync failed — data is safe in localStorage
      }
    },
    [isAuthenticated, token, tenantId]
  );

  const getProfile = useCallback(
    (species: string, stage: string, season: string): NutrientProfile | null => {
      return (
        profiles.find(
          (p) => p.species === species && p.cultivationStage === stage && p.season === season
        ) ?? null
      );
    },
    [profiles]
  );

  const saveProfile = useCallback(
    (profile: NutrientProfile) => {
      setProfiles((prev) => {
        // BUG-HYD-003: Match by id first (authoritative key), then fall back to
        // business key for imported profiles that may not yet have an id match.
        let idx = prev.findIndex((p) => p.id === profile.id);
        if (idx < 0) {
          idx = prev.findIndex(
            (p) =>
              p.species === profile.species &&
              p.cultivationStage === profile.cultivationStage &&
              p.season === profile.season
          );
        }
        let next: NutrientProfile[];
        if (idx >= 0) {
          next = [...prev];
          next[idx] = profile;
        } else {
          next = [...prev, profile];
        }
        // Fire-and-forget backend sync
        syncToBackend(next);
        return next;
      });
    },
    [syncToBackend]
  );

  const deleteProfile = useCallback(
    (id: string) => {
      setProfiles((prev) => {
        const next = prev.filter((p) => p.id !== id);
        syncToBackend(next);
        return next;
      });
    },
    [syncToBackend]
  );

  const importDefaults = useCallback(async () => {
    // PERF-HYD-007: Dynamically import the defaults dataset only when the user
    // explicitly requests it, so the full profile data is not bundled into the
    // main chunk and does not load on every page render.
    const { getDefaultProfilesWithIds } = await import('../data/nutrient-defaults');
    const defaults = getDefaultProfilesWithIds();
    setProfiles((prev) => {
      const merged = [...prev];
      for (const d of defaults) {
        // BUG-HYD-003: Match by id first when merging defaults
        let idx = merged.findIndex((p) => p.id === d.id);
        if (idx < 0) {
          idx = merged.findIndex(
            (p) =>
              p.species === d.species &&
              p.cultivationStage === d.cultivationStage &&
              p.season === d.season
          );
        }
        if (idx >= 0) {
          merged[idx] = d;
        } else {
          merged.push(d);
        }
      }
      // Fire-and-forget backend sync
      syncToBackend(merged);
      return merged;
    });
  }, [syncToBackend]);

  return { profiles, getProfile, saveProfile, deleteProfile, importDefaults };
}
