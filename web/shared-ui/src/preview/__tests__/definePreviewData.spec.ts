/**
 * definePreviewData — the handle carries no readable value (FE-MEDIUM-337).
 *
 * The preview path is tier 1 only if nothing but MockPreview can reach a
 * preview value: the handle definePreviewData returns has no field, no symbol
 * and no serialised form that holds the value, so a page cannot print it
 * without the notice MockPreview draws around it. This spec proves the
 * runtime half. The type half (no readable member, not a React child, the
 * render prop typed by the value) is `PreviewDataOpacity` at the foot of
 * previewData.ts, where tsc checks it — an `expectTypeOf` here would run as a
 * no-op, since vitest does not type-check and tsconfig.json excludes specs.
 */
import { describe, expect, it } from 'vitest';

import { definePreviewData } from '../previewData';

const SOURCE = {
  finding: 'FARM-MEDIUM-439',
  reasonKey: 'preview.sampleData',
  needs: 'farm-service budget entity + budgetVsActual query',
} as const;

describe('definePreviewData', () => {
  it('returns a frozen handle with no own key, symbol or JSON form that holds the value', () => {
    const value = { budget: 125_000, spent: 98_400 };
    const handle = definePreviewData(SOURCE, value);

    expect(Reflect.ownKeys(handle)).toEqual([]);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(JSON.stringify(handle)).toBe('{}');
    // Nothing on the prototype chain answers with the value either.
    const reachable: unknown[] = [];
    for (let proto: object | null = handle; proto; proto = Object.getPrototypeOf(proto)) {
      for (const key of Reflect.ownKeys(proto)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(proto, key);
        if (descriptor && 'value' in descriptor) reachable.push(descriptor.value);
      }
    }
    expect(reachable).not.toContain(value);
  });

  it('gives every call its own handle, even for the same value', () => {
    const value = [1, 2, 3];
    expect(definePreviewData(SOURCE, value)).not.toBe(definePreviewData(SOURCE, value));
  });
});
