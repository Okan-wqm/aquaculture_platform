/**
 * interpolateTemperature specs — the production plan's scenario curve rule:
 * piecewise-linear between dated points, clamped before the first / after the
 * last point (the user's "artan artar, azalan azalır, sabit sabit kalır").
 */
import { interpolateTemperature } from '../query-handlers/get-tank-growth-projection.handler';

const points = [
  { date: '2026-10-01', celsius: 13 },
  { date: '2026-11-01', celsius: 15 },
  { date: '2026-11-15', celsius: 14 },
  { date: '2026-12-01', celsius: 11.5 },
];

describe('interpolateTemperature', () => {
  it('rises linearly between two rising points', () => {
    // 16 Oct is halfway between 1 Oct (13°) and 1 Nov (15°): 31-day span, day 15/31
    const v = interpolateTemperature(points, '2026-10-17') ?? 0;
    expect(v).toBeGreaterThan(13.8);
    expect(v).toBeLessThan(14.2);
  });

  it('falls linearly between two falling points', () => {
    const v = interpolateTemperature(points, '2026-11-23') ?? 0;
    expect(v).toBeGreaterThan(12.5);
    expect(v).toBeLessThan(13);
  });

  it('stays flat between equal points', () => {
    const flat = [
      { date: '2026-10-01', celsius: 14 },
      { date: '2026-11-01', celsius: 14 },
    ];
    expect(interpolateTemperature(flat, '2026-10-20')).toBe(14);
  });

  it('clamps to the first point before the curve and the last after it', () => {
    expect(interpolateTemperature(points, '2026-09-01')).toBe(13);
    expect(interpolateTemperature(points, '2027-01-01')).toBe(11.5);
  });

  it('returns the exact point value on point dates', () => {
    expect(interpolateTemperature(points, '2026-11-01')).toBe(15);
    expect(interpolateTemperature(points, '2026-12-01')).toBe(11.5);
  });

  it('returns null for an empty scenario', () => {
    expect(interpolateTemperature([], '2026-10-01')).toBeNull();
  });
});
