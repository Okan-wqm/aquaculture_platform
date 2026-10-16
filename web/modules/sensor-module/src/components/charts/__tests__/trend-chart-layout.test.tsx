/**
 * TrendChart's mount contract, pinned after the 2026-10 growth loop:
 *
 * The uPlot mount div was flow-positioned (flex-1) inside a root that carried
 * `h-full`, which in compiled Tailwind order overrides a caller's `h-64`. The
 * box became content-sized, so uPlot's own root (chart + legend) decided the
 * container's height and the ResizeObserver read that sum back in as the next
 * chart height — the chart grew by one legend row per notification and the
 * page stretched downward without end.
 *
 * The mount div is now box-positioned (absolute inset-0) inside a root whose
 * height comes only from the caller. These tests pin that structure: the
 * caller's height class survives, and the element uPlot mounts into can never
 * have a content-driven size.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('uplot/dist/uPlot.min.css', () => ({}));

const mounts: { opts: Record<string, unknown>; container: HTMLElement }[] = [];
/** Constructor/setData call counters — the persistence contract's evidence. */
const calls = { constructed: 0, setData: 0 };

vi.mock('uplot', () => {
  return {
    default: class FakeUPlot {
      constructor(opts: Record<string, unknown>, _data: unknown, container: HTMLElement) {
        calls.constructed += 1;
        mounts.push({ opts, container });
      }
      setData(_data: unknown): void {
        calls.setData += 1;
      }
      setSize(_size: { width: number; height: number }): void {}
      destroy(): void {}
    },
  };
});

import { TrendChart } from '../TrendChart';
import type { ChartLine } from '../../../types/scada-runtime.types';

const LINE: ChartLine = {
  id: 'line-1',
  tagId: 'temperature',
  label: 'Su Sıcaklığı (°C)',
  color: '#146f84',
  yAxis: 1,
  interpolation: 'linear',
};

class FakeResizeObserver {
  observe(_target: Element): void {}
  disconnect(): void {}
  unobserve(_target: Element): void {}
}

describe('TrendChart mount box', () => {
  beforeEach(() => {
    mounts.length = 0;
    calls.constructed = 0;
    calls.setData = 0;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  });

  it('keeps the caller height class: the root never carries h-full of its own', () => {
    const { container } = render(<TrendChart lines={[LINE]} className="h-64" />);

    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('h-64');
    // `h-full` here would override the caller's height in compiled Tailwind
    // order and re-open the content-sized-box growth loop.
    expect(root.className).not.toContain('h-full');
    expect(root.className).toContain('relative');
  });

  it('mounts uPlot into a box-positioned div, never a content-sized one', () => {
    render(<TrendChart lines={[LINE]} className="h-64" />);

    expect(mounts).toHaveLength(1);
    const { container: mountDiv } = mounts[0]!;
    expect(mountDiv.className).toContain('absolute');
    expect(mountDiv.className).toContain('inset-0');
    // The mount div is positioned against its parent, so uPlot's own root
    // cannot feed its rendered height back through layout.
    expect(mountDiv.parentElement?.className).toContain('relative');
  });

  it('keeps the instance when a refresh only changes the data (new array identities, same series)', () => {
    // A data refresh on /sensor/readings produces NEW `lines` and
    // `customData` identities with identical series content. Rebuilding the
    // chart for that made it vanish and re-draw on every poll.
    const point1 = { timestamp: 1_000, value: 22.5 };
    const point2 = { timestamp: 2_000, value: 23.1 };
    const view = render(
      <TrendChart lines={[LINE]} customData={{ temperature: [point1] }} className="h-44" />,
    );

    expect(calls.constructed).toBe(1);

    view.rerender(
      <TrendChart
        lines={[{ ...LINE }]}
        customData={{ temperature: [point1, point2] }}
        className="h-44"
      />,
    );

    // Same instance, fed the new points — nothing was torn down.
    expect(calls.constructed).toBe(1);
    expect(calls.setData).toBeGreaterThanOrEqual(3); // seed + data effect × 2 renders
    expect(mounts).toHaveLength(1);
  });

  it('rebuilds the instance when the series structure changes', () => {
    const view = render(<TrendChart lines={[LINE]} className="h-44" />);
    expect(calls.constructed).toBe(1);

    view.rerender(<TrendChart lines={[{ ...LINE, color: '#0d9488' }]} className="h-44" />);

    expect(calls.constructed).toBe(2);
    expect(mounts).toHaveLength(2);
  });
});
