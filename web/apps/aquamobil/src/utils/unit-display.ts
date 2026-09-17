/**
 * How a UNIT is presented — the shared vocabulary every unit surface needs.
 *
 * WHY THIS FILE EXISTS. Four surfaces render the same pen: the phone's unit list
 * (UnitsPage), the phone's unit detail (TankDetailPage), the tablet board's unit
 * grid and the board's inspector. Before this file, each carried its own copy of
 * "what colour is a QUARANTINE pen" and "what do we call site 2", and the copies
 * had already drifted:
 *
 *   • UnitsPage        CLEANING / FALLOW / INACTIVE → neutral (grey dot)
 *   • TankDetailPage   CLEANING / FALLOW / INACTIVE → warn   (amber dot)
 *   • TankCard         CLEANING / FALLOW absent entirely, so a cleaning pen fell
 *                      through to the INACTIVE row and was LABELLED "Inactive"
 *
 * One pen, three answers, on screens a worker moves between in two taps. Adding
 * a fourth and fifth copy for the board would have made it five. The lookup is
 * therefore declared once, here, and imported — a status can no longer mean one
 * thing on the list and another on the detail.
 *
 * (`TankCard` is not migrated because nothing renders it: App.tsx mentions it in
 * a comment only. It is dead code carrying a fourth copy, which is worth saying
 * out loud rather than quietly editing.)
 */
import type { Tank } from '@/types';

/** The three semantic tones a unit's status can wear. There is no fourth. */
export type UnitStatusTone = 'ok' | 'warn' | 'crit';

export interface UnitStatusMeta {
  /** The word beside the dot. Non-optional: a dot alone is colour-alone. */
  label: string;
  tone: UnitStatusTone;
}

/**
 * Every member of the backend `TankStatus` enum, exhaustively.
 *
 * `Record<Tank['status'], …>` is what makes it exhaustive: adding a ninth status
 * to the union in src/types is a compile error here until it is given a label
 * and a tone. That is the same defect class as ORPHAN-HIGH-583 — a status the
 * frontend did not know reached the render tree and crashed the unit detail on
 * `STATUS_META[tank.status].tone` — closed one layer higher.
 */
const UNIT_STATUS_META: Record<Tank['status'], UnitStatusMeta> = {
  ACTIVE: { label: 'Active', tone: 'ok' },
  PREPARING: { label: 'Preparing', tone: 'warn' },
  CLEANING: { label: 'Cleaning', tone: 'warn' },
  MAINTENANCE: { label: 'Maintenance', tone: 'crit' },
  HARVESTING: { label: 'Harvesting', tone: 'warn' },
  FALLOW: { label: 'Fallow', tone: 'warn' },
  QUARANTINE: { label: 'Quarantine', tone: 'crit' },
  INACTIVE: { label: 'Inactive', tone: 'warn' },
};

/**
 * The label and tone for a unit's status.
 *
 * NO DEFENSIVE FALLBACK, on purpose. `narrowTankStatus` in src/hooks/useTanks.ts
 * already guarantees that every Tank reaching the render tree carries one of the
 * eight members — it checks the wire value against a runtime set and logs the
 * drift instead of casting. A `?? INACTIVE` here would be dead code pretending
 * to be a safety net, and the real net is one layer up where it belongs.
 */
export function unitStatusMeta(status: Tank['status']): UnitStatusMeta {
  return UNIT_STATUS_META[status];
}

export interface UnitGroup {
  siteId: string;
  /** What the group's heading says. See the note in groupUnitsBySite(). */
  label: string;
  units: Tank[];
}

/**
 * Group units by site, in first-seen order.
 *
 * The label is deliberately positional ("Site 1", "Site 2") rather than a name:
 * sites arrive as opaque ids on the inventory snapshot and this client has no
 * site-name query, so a name here would be invented. A single-site tenant gets
 * the plain heading "Units" instead of a "Site 1" that implies a second one
 * exists somewhere.
 */
export function groupUnitsBySite(units: Tank[]): UnitGroup[] {
  const bySite = new Map<string, Tank[]>();
  for (const unit of units) {
    const key = unit.siteId ?? 'unassigned';
    const bucket = bySite.get(key);
    if (bucket) bucket.push(unit);
    else bySite.set(key, [unit]);
  }
  return [...bySite.entries()].map(([siteId, grouped], index) => ({
    siteId,
    label: bySite.size === 1 ? 'Units' : `Site ${index + 1}`,
    units: grouped,
  }));
}

/**
 * What a metric reads when the backend did not supply it.
 *
 * Rendered INSTEAD of a zero. `capacityUsedPercent` and `density` are nullable
 * on the wire — they are null when a unit has no configured consent capacity,
 * which is a different fact from "this unit is at 0% of its limit". Printing the
 * second when the first is true is the same mistake as rendering a failed fetch
 * as "Capacity OK", one field down: a number the farm never stated, presented in
 * the farm's voice.
 */
export const NO_VALUE = '—';

/** A nullable metric at a fixed precision, or NO_VALUE. Never a fabricated 0. */
export function fixedOrNone(value: number | null | undefined, digits: number): string {
  return value == null ? NO_VALUE : value.toFixed(digits);
}

/**
 * Fish counts, abbreviated. A pen holds tens of thousands and the tile it sits
 * in is 140px wide on the board's grid, so "18.2K" is what fits and what a
 * worker reads at a glance; the exact count lives on the unit detail.
 */
export function compactCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return count.toLocaleString();
}
