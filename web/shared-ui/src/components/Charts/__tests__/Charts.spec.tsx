/**
 * Chart primitives on one engine (FE-MEDIUM-084).
 *
 * The hand-rolled SVG charts are gone; every primitive draws through recharts
 * and paints from the theme. These tests pin the contract the consumers rely
 * on: a fixed width renders a recharts surface, an empty series renders the
 * locale's empty face, series colours come from the theme palette, and the
 * bar/line reshaping keeps one row per label.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { chartPalette, colors } from '../../../styles/theme';
import { AreaChart } from '../AreaChart';
import { BarChart, toRows } from '../BarChart';
import { DonutChart } from '../DonutChart';
import { LineChart } from '../LineChart';
import { PieChart } from '../PieChart';
import { SparklineChart } from '../SparklineChart';

const SERIES = [
  { label: 'Mon', value: 12 },
  { label: 'Tue', value: 18 },
  { label: 'Wed', value: 9 },
];

describe('chart primitives draw through recharts', () => {
  it('AreaChart renders a recharts surface at a fixed width and the gradient from the theme', () => {
    const { container } = render(<AreaChart data={SERIES} width={320} height={160} />);

    expect(container.querySelector('svg.recharts-surface')).not.toBeNull();
    expect(container.querySelector('linearGradient stop')?.getAttribute('stop-color')).toBe(
      colors.primary[500],
    );
  });

  it('every primitive shows the empty face for an empty series', () => {
    render(
      <>
        <AreaChart data={[]} width={200} height={100} />
        <BarChart labels={[]} datasets={[]} width={200} height={100} />
        <LineChart labels={[]} datasets={[]} width={200} height={100} />
        <PieChart data={[]} size={100} />
        <SparklineChart data={[]} />
      </>,
    );

    expect(screen.getAllByTestId('chart-no-data')).toHaveLength(5);
    expect(screen.getAllByText('No data available')).toHaveLength(5);
  });

  it('BarChart reshapes labels and datasets into one row per label and legends from the palette', () => {
    const datasets = [
      { label: 'Messages', data: [3, 5] },
      { label: 'Alerts', data: [1, 0], color: colors.error[500] },
    ];
    expect(toRows(['t1', 't2'], datasets)).toEqual([
      { label: 't1', Messages: 3, Alerts: 1 },
      { label: 't2', Messages: 5, Alerts: 0 },
    ]);

    const { container } = render(
      <BarChart labels={['t1', 't2']} datasets={datasets} width={320} height={160} />,
    );

    expect(container.querySelector('svg.recharts-surface')).not.toBeNull();
    const swatches = Array.from(container.querySelectorAll('span[style]')).map(
      (el) => (el as HTMLElement).style.backgroundColor,
    );
    expect(swatches).toEqual([cssColor(chartPalette[0]!), cssColor(colors.error[500])]);
  });

  it('LineChart draws one line per dataset, dashed where asked', () => {
    const { container } = render(
      <LineChart
        labels={['a', 'b', 'c']}
        datasets={[
          { label: 'Actual', data: [1, 2, 3] },
          { label: 'Target', data: [2, 2, 2], dashed: true },
        ]}
        width={320}
        height={160}
        showDots={false}
        animate={false}
      />,
    );

    const curves = container.querySelectorAll('path.recharts-line-curve');
    expect(curves).toHaveLength(2);
    expect(curves[1]?.getAttribute('stroke-dasharray')).toBe('8 4');
  });

  it('PieChart legends each slice with its share of the whole', () => {
    render(
      <PieChart
        data={[
          { label: 'Fed', value: 75 },
          { label: 'Skipped', value: 25 },
        ]}
        size={160}
      />,
    );

    expect(screen.getByText('Fed')).toBeInTheDocument();
    expect(screen.getByText('(75%)')).toBeInTheDocument();
    expect(screen.getByText('(25%)')).toBeInTheDocument();
  });

  it('DonutChart keeps the centre slot over the ring', () => {
    render(
      <DonutChart
        data={[{ label: 'Done', value: 1 }]}
        size={160}
        centerContent={<strong>100%</strong>}
      />,
    );

    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('SparklineChart renders each variant without axes', () => {
    for (const variant of ['area', 'line', 'bar'] as const) {
      const { container, unmount } = render(
        <SparklineChart
          data={[1, 3, 2, 5]}
          variant={variant}
          width={80}
          height={24}
          animate={false}
        />,
      );
      expect(container.querySelector('svg.recharts-surface')).not.toBeNull();
      expect(container.querySelector('.recharts-cartesian-axis')).toBeNull();
      unmount();
    }
  });
});

/** jsdom serialises a hex background as rgb(); compare in that form. */
function cssColor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
