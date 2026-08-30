import { describe, expect, it } from 'vitest';

import { lazyMap } from '../components/scada-builder/WidgetRenderer';
import { symbolMap } from '../components/scada-builder/equipment-symbols';
import { PALETTE_CATEGORIES } from '../constants/scada-palette-categories';

/**
 * Palette-parity guard (enterprise plan Faz 1, CHART-002/006).
 *
 * PALETTE_CATEGORIES is the single source of truth for the SCADA widget
 * palette (consumed by UnifiedLeftPanel in both the standalone builder and
 * the unified editor). Two drifts previously left widgets unreachable:
 *  - a palette `type` with no WidgetRenderer entry drops an unrenderable
 *    card onto the canvas;
 *  - an equipment `symbolMap` symbol absent from the palette is a shape that
 *    ships in the codebase but can be dragged from nowhere.
 *
 * This guard makes both impossible by construction.
 */

const paletteWidgets = PALETTE_CATEGORIES.flatMap((c) => c.widgets);

const paletteEquipmentSubTypes = new Set(
  paletteWidgets
    .filter((w) => w.type === 'equipment')
    .map((w) => w.defaultConfig?.equipmentSubType as string | undefined)
    .filter((s): s is string => typeof s === 'string'),
);

describe('palette-parity guard', () => {
  it('every palette widget type resolves to a WidgetRenderer', () => {
    const rendererTypes = new Set(Object.keys(lazyMap));
    const unrenderable = [...new Set(paletteWidgets.map((w) => w.type))].filter(
      (t) => !rendererTypes.has(t),
    );
    expect(unrenderable).toEqual([]);
  });

  it('every equipment symbol is reachable from the palette', () => {
    const missing = Object.keys(symbolMap).filter((sub) => !paletteEquipmentSubTypes.has(sub));
    expect(missing).toEqual([]);
  });

  it('every palette equipment subtype has a registered symbol', () => {
    const registered = new Set(Object.keys(symbolMap));
    const dangling = [...paletteEquipmentSubTypes].filter((sub) => !registered.has(sub));
    expect(dangling).toEqual([]);
  });

  it('has no duplicate palette entries', () => {
    const keys = paletteWidgets.map((w) => {
      const sub = w.defaultConfig?.equipmentSubType as string | undefined;
      return sub ? `${w.type}::${sub}` : w.type;
    });
    expect(keys.length).toBe(new Set(keys).size);
  });
});
