import { describe, it, expect } from 'vitest';
import {
  buildTransformCSS,
  buildTransformOrigin,
  clampTransform,
  DEFAULT_SVG_TRANSFORM,
} from '../types/scada-transform.types';
import type { SvgTransform } from '../types/scada-transform.types';
import { buildPathD, clampPathPoints } from '../types/scada-path.types';
import type { PathPoint } from '../types/scada-path.types';
import { DASH_PATTERN_MAP } from '../types/scada-svg-properties.types';

/* ------------------------------------------------------------------ */
/*  buildTransformCSS                                                  */
/* ------------------------------------------------------------------ */

describe('buildTransformCSS', () => {
  it('returns empty string for default transform values', () => {
    expect(buildTransformCSS(DEFAULT_SVG_TRANSFORM)).toBe('');
  });

  it('returns correct rotate string', () => {
    const t: SvgTransform = { ...DEFAULT_SVG_TRANSFORM, rotation: 45 };
    expect(buildTransformCSS(t)).toBe('rotate(45deg)');
  });

  it('returns correct combined transform string', () => {
    const t: SvgTransform = {
      rotation: 90,
      scaleX: 2,
      scaleY: 0.5,
      skewX: 10,
      skewY: -15,
      originX: 0.5,
      originY: 0.5,
    };
    expect(buildTransformCSS(t)).toBe(
      'rotate(90deg) scale(2, 0.5) skewX(10deg) skewY(-15deg)',
    );
  });
});

/* ------------------------------------------------------------------ */
/*  buildTransformOrigin                                               */
/* ------------------------------------------------------------------ */

describe('buildTransformOrigin', () => {
  it('returns undefined for center origin (0.5, 0.5)', () => {
    expect(buildTransformOrigin(DEFAULT_SVG_TRANSFORM)).toBeUndefined();
  });

  it('returns correct percentage string for non-center origin', () => {
    const t: SvgTransform = { ...DEFAULT_SVG_TRANSFORM, originX: 0, originY: 1 };
    expect(buildTransformOrigin(t)).toBe('0% 100%');
  });
});

/* ------------------------------------------------------------------ */
/*  clampTransform                                                     */
/* ------------------------------------------------------------------ */

describe('clampTransform', () => {
  it('wraps rotation to [0, 360)', () => {
    expect(clampTransform({ rotation: -90 }).rotation).toBe(270);
    expect(clampTransform({ rotation: 400 }).rotation).toBe(40);
    expect(clampTransform({ rotation: 720 }).rotation).toBe(0);
  });

  it('clamps scaleX and scaleY to [0.1, 10]', () => {
    expect(clampTransform({ scaleX: 0.01 }).scaleX).toBe(0.1);
    expect(clampTransform({ scaleX: 50 }).scaleX).toBe(10);
    expect(clampTransform({ scaleY: -5 }).scaleY).toBe(0.1);
    expect(clampTransform({ scaleY: 100 }).scaleY).toBe(10);
  });

  it('clamps skewX and skewY to [-89, 89]', () => {
    expect(clampTransform({ skewX: -100 }).skewX).toBe(-89);
    expect(clampTransform({ skewX: 100 }).skewX).toBe(89);
    expect(clampTransform({ skewY: -200 }).skewY).toBe(-89);
    expect(clampTransform({ skewY: 200 }).skewY).toBe(89);
  });
});

/* ------------------------------------------------------------------ */
/*  buildPathD                                                         */
/* ------------------------------------------------------------------ */

describe('buildPathD', () => {
  it('generates correct line path', () => {
    const points: PathPoint[] = [
      { x: 0, y: 0, type: 'line' },
      { x: 100, y: 100, type: 'line' },
    ];
    expect(buildPathD(points, false)).toBe('M 0 0 L 100 100');
  });

  it('generates correct quadratic bezier', () => {
    const points: PathPoint[] = [
      { x: 0, y: 0, type: 'quadratic', cp1: { x: 50, y: -30 } },
      { x: 100, y: 0, type: 'line' },
    ];
    expect(buildPathD(points, false)).toBe('M 0 0 Q 50 -30 100 0');
  });

  it('generates correct cubic bezier', () => {
    const points: PathPoint[] = [
      { x: 0, y: 0, type: 'cubic', cp1: { x: 30, y: -50 }, cp2: { x: -30, y: 50 } },
      { x: 100, y: 0, type: 'line' },
    ];
    // c1x = 0+30=30, c1y = 0+(-50)=-50, c2x = 100+(-30)=70, c2y = 0+50=50
    expect(buildPathD(points, false)).toBe('M 0 0 C 30 -50 70 50 100 0');
  });

  it('handles closed paths with Z', () => {
    const points: PathPoint[] = [
      { x: 0, y: 0, type: 'line' },
      { x: 100, y: 0, type: 'line' },
      { x: 50, y: 100, type: 'line' },
    ];
    expect(buildPathD(points, true)).toBe('M 0 0 L 100 0 L 50 100 Z');
  });

  it('returns empty string for fewer than 2 points', () => {
    expect(buildPathD([], false)).toBe('');
    expect(buildPathD([{ x: 0, y: 0, type: 'line' }], false)).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/*  clampPathPoints                                                    */
/* ------------------------------------------------------------------ */

describe('clampPathPoints', () => {
  it('rejects NaN and Infinity values by resetting to 0', () => {
    const points: PathPoint[] = [
      { x: NaN, y: Infinity, type: 'line' },
      { x: -Infinity, y: NaN, type: 'line' },
    ];
    const clamped = clampPathPoints(points, 200, 150);
    expect(clamped[0].x).toBe(0);
    expect(clamped[0].y).toBe(0);
    expect(clamped[1].x).toBe(0);
    expect(clamped[1].y).toBe(0);
  });

  it('clamps coordinates to widget bounds', () => {
    const points: PathPoint[] = [
      { x: -10, y: 300, type: 'line' },
    ];
    const clamped = clampPathPoints(points, 200, 150);
    expect(clamped[0].x).toBe(0);
    expect(clamped[0].y).toBe(150);
  });
});

/* ------------------------------------------------------------------ */
/*  DASH_PATTERN_MAP                                                   */
/* ------------------------------------------------------------------ */

describe('DASH_PATTERN_MAP', () => {
  it('contains all 5 dash pattern entries', () => {
    const keys = Object.keys(DASH_PATTERN_MAP);
    expect(keys).toHaveLength(5);
    expect(keys).toContain('solid');
    expect(keys).toContain('dotted');
    expect(keys).toContain('dashed');
    expect(keys).toContain('dashDot');
    expect(keys).toContain('dashDotDot');
  });
});
