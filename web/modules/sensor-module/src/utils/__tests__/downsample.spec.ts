import { describe, it, expect } from 'vitest';
import { lttbDownsample, downsampleChartData, MAX_CHART_POINTS } from '../downsample';

describe('lttbDownsample', () => {
  const makeData = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      x: i,
      y: Math.sin(i * 0.1) * 100,
    }));

  it('returns original data when below threshold', () => {
    const data = makeData(10);
    const result = lttbDownsample(data, 20, (d) => d.x, (d) => d.y);
    expect(result).toHaveLength(10);
  });

  it('returns original data when threshold equals length', () => {
    const data = makeData(100);
    const result = lttbDownsample(data, 100, (d) => d.x, (d) => d.y);
    expect(result).toHaveLength(100);
  });

  it('downsamples to the requested threshold', () => {
    const data = makeData(1000);
    const result = lttbDownsample(data, 50, (d) => d.x, (d) => d.y);
    expect(result).toHaveLength(50);
  });

  it('preserves first and last data points', () => {
    const data = makeData(500);
    const result = lttbDownsample(data, 20, (d) => d.x, (d) => d.y);
    expect(result[0]).toBe(data[0]);
    expect(result[result.length - 1]).toBe(data[data.length - 1]);
  });

  it('does not mutate original array', () => {
    const data = makeData(100);
    const original = [...data];
    lttbDownsample(data, 10, (d) => d.x, (d) => d.y);
    expect(data).toEqual(original);
  });

  it('handles threshold of 2 (only first and last)', () => {
    const data = makeData(100);
    const result = lttbDownsample(data, 2, (d) => d.x, (d) => d.y);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(data[0]);
    expect(result[1]).toBe(data[99]);
  });

  it('handles large dataset (simulating 43200 points)', () => {
    const data = makeData(43200);
    const result = lttbDownsample(data, MAX_CHART_POINTS, (d) => d.x, (d) => d.y);
    expect(result).toHaveLength(MAX_CHART_POINTS);
    expect(result[0]).toBe(data[0]);
    expect(result[result.length - 1]).toBe(data[data.length - 1]);
  });
});

describe('downsampleChartData', () => {
  const makeChartData = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      time: `${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
      timestamp: new Date(2026, 0, 1, 0, 0, 0, 0).getTime() + i * 60000,
      temperature: 20 + Math.sin(i * 0.05) * 5,
    }));

  it('passes through small datasets unchanged', () => {
    const data = makeChartData(100);
    const result = downsampleChartData(data);
    expect(result).toHaveLength(100);
  });

  it('downsamples datasets exceeding MAX_CHART_POINTS', () => {
    const data = makeChartData(2000);
    const result = downsampleChartData(data, 500);
    expect(result).toHaveLength(500);
  });

  it('handles Date objects as timestamps', () => {
    const data = Array.from({ length: 1000 }, (_, i) => ({
      time: `${i}`,
      timestamp: new Date(2026, 0, 1, 0, i),
      value: i * 2,
    }));
    const result = downsampleChartData(data, 100);
    expect(result).toHaveLength(100);
  });

  it('handles ISO string timestamps', () => {
    const data = Array.from({ length: 1000 }, (_, i) => ({
      time: `${i}`,
      timestamp: new Date(2026, 0, 1, 0, i).toISOString(),
      value: i * 2,
    }));
    const result = downsampleChartData(data, 100);
    expect(result).toHaveLength(100);
  });
});
