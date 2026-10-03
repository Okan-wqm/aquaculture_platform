/**
 * The farm summary is the arithmetic two screens now share, so it is the one
 * place a rounding choice or a "which figure counts" decision can be pinned
 * once instead of being re-argued on each surface.
 *
 * Three of these encode real defects this codebase has already paid for:
 * averaging averages, reading the primary batch instead of the container, and
 * treating a null consent capacity as zero.
 */
import { describe, expect, it } from 'vitest';

import type { Tank } from '@/types';
import { farmSummary, WATCH_AT } from '@/utils/farm-summary';

function tank(
  id: string,
  over: {
    fish?: number;
    biomassKg?: number;
    batchId?: string | null;
    capacityUsedPercent?: number | null;
    isOverCapacity?: boolean;
    density?: number | null;
  } = {},
): Tank {
  const batchId = over.batchId === undefined ? `batch-${id}` : over.batchId;
  return {
    id,
    name: `Pen ${id}`,
    code: id,
    volume: 1000,
    status: 'ACTIVE',
    siteId: 'site-a',
    currentQuantity: over.fish ?? 0,
    currentBiomass: over.biomassKg ?? 0,
    maxBiomass: 40_000,
    batchMetrics:
      batchId === null
        ? null
        : {
            batchId,
            // `=== undefined`, not `??`: an explicit null is the case under
            // test (no configured consent capacity) and must survive the helper.
            capacityUsedPercent:
              over.capacityUsedPercent === undefined ? 0 : over.capacityUsedPercent,
            isOverCapacity: over.isOverCapacity ?? false,
            density: over.density === undefined ? 10 : over.density,
          },
  } as Tank;
}

describe('farmSummary', () => {
  it('weights the average by biomass rather than averaging per-pen means', () => {
    // A 100 000-fish pen at 1 kg and a 5 000-fish pen at 5 kg.
    // Mean of means would say 3000 g. The farm's actual average is
    // 125 000 kg / 105 000 fish ≈ 1190 g, and that is the number a manager is
    // asking for when they ask what a fish weighs.
    const summary = farmSummary([
      tank('big', { fish: 100_000, biomassKg: 100_000 }),
      tank('small', { fish: 5_000, biomassKg: 25_000 }),
    ]);

    expect(Math.round(summary.avgWeightG)).toBe(1190);
    expect(summary.fish).toBe(105_000);
    expect(summary.biomassKg).toBe(125_000);
  });

  it('counts the CONTAINER totals, not the primary batch (ORPHAN-HIGH-585)', () => {
    // currentQuantity/currentBiomass are unit totals across every batch in the
    // pen. Reading the primary batch's own figures instead is what made the
    // farm aggregates too low.
    const mixed = tank('mixed', { fish: 30_000, biomassKg: 60_000 });
    expect(farmSummary([mixed]).fish).toBe(30_000);
  });

  it('ignores units with no batch in every farm figure', () => {
    const summary = farmSummary([
      tank('stocked', { fish: 1_000, biomassKg: 2_000 }),
      tank('fallow', { batchId: null, fish: 999, biomassKg: 999 }),
    ]);

    expect(summary.stockedCount).toBe(1);
    expect(summary.totalCount).toBe(2);
    expect(summary.fish).toBe(1_000);
  });

  it('does not divide by zero when nothing is stocked', () => {
    const summary = farmSummary([tank('fallow', { batchId: null })]);
    expect(summary.avgWeightG).toBe(0);
    expect(Number.isFinite(summary.avgWeightG)).toBe(true);
  });

  it('takes over-consent from the farm service, not from the advisory line', () => {
    // 60% used is BELOW the advisory watch line, but the service flags it —
    // isOverCapacity fires on biomass and status axes too. A local threshold
    // here once made Reports and Today disagree about the same pen.
    const summary = farmSummary([
      tank('u1', { capacityUsedPercent: 60, isOverCapacity: true }),
      tank('u2', { capacityUsedPercent: 95, isOverCapacity: false }),
    ]);

    expect(summary.atLimit).toBe(1);
    expect(summary.atWatch).toBe(1);
  });

  it('puts a unit exactly on the watch line inside the band', () => {
    expect(farmSummary([tank('u1', { capacityUsedPercent: WATCH_AT })]).atWatch).toBe(1);
    expect(farmSummary([tank('u1', { capacityUsedPercent: WATCH_AT - 1 })]).atWatch).toBe(0);
  });

  it('ranks the densest first and keeps a null-capacity unit last, not at zero', () => {
    // A null capacity means the unit has NO configured consent — a different
    // fact from "0% used". It sorts last rather than being dropped, and the
    // screens render it as an em dash rather than a fabricated 0%.
    const summary = farmSummary([
      tank('mid', { capacityUsedPercent: 50 }),
      tank('none', { capacityUsedPercent: null }),
      tank('high', { capacityUsedPercent: 90 }),
    ]);

    expect(summary.densest.map((unit) => unit.id)).toEqual(['high', 'mid', 'none']);
    expect(summary.densest[2]?.batchMetrics?.capacityUsedPercent).toBeNull();
  });

  it('lists at most five units under closest-to-consent', () => {
    const units = Array.from({ length: 9 }, (_, i) =>
      tank(`u${i}`, { capacityUsedPercent: i * 10 }),
    );
    expect(farmSummary(units).densest).toHaveLength(5);
  });

  it('does not mutate the array it was given', () => {
    const units = [tank('a', { capacityUsedPercent: 10 }), tank('b', { capacityUsedPercent: 90 })];
    farmSummary(units);
    expect(units.map((unit) => unit.id)).toEqual(['a', 'b']);
  });
});
