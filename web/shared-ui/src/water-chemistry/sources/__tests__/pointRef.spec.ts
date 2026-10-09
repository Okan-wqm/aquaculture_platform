import { describe, expect, it } from 'vitest';

import {
  formatPointRef,
  parsePointRef,
  pointInput,
  pointOfResult,
  pointOfSource,
  samePoint,
} from '../pointRef';

const TANK = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';

describe('point refs', () => {
  it('round-trips the URL form', () => {
    expect(formatPointRef({ kind: 'tank', id: TANK })).toBe(`tank:${TANK}`);
    expect(parsePointRef(`tank:${TANK}`)).toEqual({ kind: 'tank', id: TANK });
  });

  it('refuses a URL value that names no point', () => {
    expect(parsePointRef(null)).toBeNull();
    expect(parsePointRef(TANK)).toBeNull();
    expect(parsePointRef(`pond:${TANK}`)).toBeNull();
    expect(parsePointRef('tank:not-a-uuid')).toBeNull();
  });

  it('names exactly one id in the GraphQL input', () => {
    expect(pointInput({ kind: 'system', id: TANK })).toEqual({ systemId: TANK });
    expect(pointInput({ kind: 'equipment', id: TANK })).toEqual({ equipmentId: TANK });
  });

  it('reads the enum name of a result', () => {
    expect(pointOfResult({ kind: 'SYSTEM', id: TANK })).toEqual({ kind: 'system', id: TANK });
  });

  it("finds a source row's point and compares points", () => {
    const point = pointOfSource({ siteId: null, systemId: null, tankId: TANK, equipmentId: null });
    expect(point).toEqual({ kind: 'tank', id: TANK });
    expect(samePoint(point, { kind: 'tank', id: TANK })).toBe(true);
    expect(samePoint(point, { kind: 'system', id: TANK })).toBe(false);
    expect(samePoint(null, null)).toBe(false);
  });
});
