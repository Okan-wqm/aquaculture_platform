import type { NutrientProfile } from '../types/modes.types';

/**
 * Seed data for nutrient profiles — used only for "Import Default Data" feature.
 * NOT used as hardcoded reference. Users manage their own profiles via the
 * NutrientProfileManager in Setup > Nutrient Profiles.
 */
// BUG-HYD-008: idCounter and makeId were dead code (never called). Removed to eliminate
// mutable module-level state that reset on hot-reload and misled future maintainers.

export const DEFAULT_NUTRIENT_PROFILES: Omit<NutrientProfile, 'id'>[] = [
  // ── Tomato ── Starter ──────────────────────────────────────────────
  {
    species: 'tomato', cultivationStage: 'starter', season: 'cold_winter',
    ec: 1.5, ph: 5.8,
    kRatio: 0.44, caRatio: 0.36, mgRatio: 0.20,
    nkRatio: 1.80, nh4Ratio: 0.05,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 0.75,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },
  {
    species: 'tomato', cultivationStage: 'starter', season: 'spring_fall',
    ec: 1.6, ph: 5.8,
    kRatio: 0.44, caRatio: 0.36, mgRatio: 0.20,
    nkRatio: 1.80, nh4Ratio: 0.05,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 0.75,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },
  {
    species: 'tomato', cultivationStage: 'starter', season: 'hot_summer',
    ec: 1.4, ph: 5.8,
    kRatio: 0.44, caRatio: 0.36, mgRatio: 0.20,
    nkRatio: 1.80, nh4Ratio: 0.05,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 0.75,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },

  // ── Tomato ── Vegetative ───────────────────────────────────────────
  {
    species: 'tomato', cultivationStage: 'vegetative', season: 'cold_winter',
    ec: 2.3, ph: 5.5,
    kRatio: 0.42, caRatio: 0.38, mgRatio: 0.20,
    nkRatio: 1.50, nh4Ratio: 0.04,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 1.0,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },
  {
    species: 'tomato', cultivationStage: 'vegetative', season: 'spring_fall',
    ec: 2.5, ph: 5.5,
    kRatio: 0.42, caRatio: 0.38, mgRatio: 0.20,
    nkRatio: 1.50, nh4Ratio: 0.04,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 1.0,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },
  {
    species: 'tomato', cultivationStage: 'vegetative', season: 'hot_summer',
    ec: 2.1, ph: 5.5,
    kRatio: 0.42, caRatio: 0.38, mgRatio: 0.20,
    nkRatio: 1.50, nh4Ratio: 0.04,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 1.0,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },

  // ── Tomato ── Flowering ────────────────────────────────────────────
  {
    species: 'tomato', cultivationStage: 'flowering', season: 'cold_winter',
    ec: 2.5, ph: 5.5,
    kRatio: 0.45, caRatio: 0.35, mgRatio: 0.20,
    nkRatio: 1.30, nh4Ratio: 0.04,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 1.0,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },
  {
    species: 'tomato', cultivationStage: 'flowering', season: 'spring_fall',
    ec: 2.7, ph: 5.5,
    kRatio: 0.45, caRatio: 0.35, mgRatio: 0.20,
    nkRatio: 1.30, nh4Ratio: 0.04,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 1.0,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },
  {
    species: 'tomato', cultivationStage: 'flowering', season: 'hot_summer',
    ec: 2.3, ph: 5.5,
    kRatio: 0.45, caRatio: 0.35, mgRatio: 0.20,
    nkRatio: 1.30, nh4Ratio: 0.04,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 1.0,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },

  // ── Tomato ── Fruiting 1 ──────────────────────────────────────────
  {
    species: 'tomato', cultivationStage: 'fruiting1', season: 'cold_winter',
    ec: 2.6, ph: 5.5,
    kRatio: 0.48, caRatio: 0.32, mgRatio: 0.20,
    nkRatio: 1.20, nh4Ratio: 0.04,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 1.0,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },
  {
    species: 'tomato', cultivationStage: 'fruiting1', season: 'spring_fall',
    ec: 2.8, ph: 5.5,
    kRatio: 0.48, caRatio: 0.32, mgRatio: 0.20,
    nkRatio: 1.20, nh4Ratio: 0.04,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 1.0,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },
  {
    species: 'tomato', cultivationStage: 'fruiting1', season: 'hot_summer',
    ec: 2.4, ph: 5.5,
    kRatio: 0.48, caRatio: 0.32, mgRatio: 0.20,
    nkRatio: 1.20, nh4Ratio: 0.04,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 1.0,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },

  // ── Tomato ── Fruiting 2 ──────────────────────────────────────────
  {
    species: 'tomato', cultivationStage: 'fruiting2', season: 'cold_winter',
    ec: 2.8, ph: 5.5,
    kRatio: 0.50, caRatio: 0.30, mgRatio: 0.20,
    nkRatio: 1.10, nh4Ratio: 0.03,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 1.0,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },
  {
    species: 'tomato', cultivationStage: 'fruiting2', season: 'spring_fall',
    ec: 3.0, ph: 5.5,
    kRatio: 0.50, caRatio: 0.30, mgRatio: 0.20,
    nkRatio: 1.10, nh4Ratio: 0.03,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 1.0,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },
  {
    species: 'tomato', cultivationStage: 'fruiting2', season: 'hot_summer',
    ec: 2.6, ph: 5.5,
    kRatio: 0.50, caRatio: 0.30, mgRatio: 0.20,
    nkRatio: 1.10, nh4Ratio: 0.03,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 1.0,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },

  // ── Cucumber ── Vegetative ─────────────────────────────────────────
  {
    species: 'cucumber', cultivationStage: 'vegetative', season: 'spring_fall',
    ec: 2.5, ph: 5.5,
    kRatio: 0.46, caRatio: 0.36, mgRatio: 0.18,
    nkRatio: 1.40, nh4Ratio: 0.04,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 0.75,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },

  // ── Cucumber ── Fruiting 1 ─────────────────────────────────────────
  {
    species: 'cucumber', cultivationStage: 'fruiting1', season: 'spring_fall',
    ec: 2.7, ph: 5.8,
    kRatio: 0.50, caRatio: 0.32, mgRatio: 0.18,
    nkRatio: 1.20, nh4Ratio: 0.04,
    p: 1.50, cl: 0.5, si: 0.5, minSO4: 0.75,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },

  // ── Pepper ── Fruiting 1 ───────────────────────────────────────────
  {
    species: 'pepper', cultivationStage: 'fruiting1', season: 'spring_fall',
    ec: 2.3, ph: 5.8,
    kRatio: 0.44, caRatio: 0.36, mgRatio: 0.20,
    nkRatio: 1.30, nh4Ratio: 0.04,
    p: 1.25, cl: 0.5, si: 0.5, minSO4: 0.75,
    fe: 25, mn: 10, zn: 5, cu: 0.75, b: 30, mo: 0.5,
  },
];

/** Add IDs to default profiles for importing */
export function getDefaultProfilesWithIds(): NutrientProfile[] {
  return DEFAULT_NUTRIENT_PROFILES.map((p, i) => ({
    ...p,
    id: `default-${i + 1}`,
  }));
}
