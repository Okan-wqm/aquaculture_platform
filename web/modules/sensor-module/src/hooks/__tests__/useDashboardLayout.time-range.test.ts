import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_WIDGET_TIME_RANGE, parseWidgetTimeRange } from '../../components/dashboard/types';
import { useDashboardLayout } from '../useDashboardLayout';

// The module's one GraphQL transport (config/api.ts) is the collaborator.
const transport = vi.hoisted(() => ({
  graphqlFetch: vi.fn<(query: string, variables?: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock('../../config/api', () => ({ graphqlFetch: transport.graphqlFetch }));

const STORED_LAYOUT = {
  id: 'layout-1',
  name: 'Overview',
  isDefault: true,
  widgets: [
    { id: 'kept', type: 'line-chart', title: 'DO', timeRange: '7d', refreshInterval: 10000 },
    { id: 'unknown', type: 'heatmap', title: 'Temp', timeRange: '12h', refreshInterval: 10000 },
    { id: 'missing', type: 'gauge', title: 'pH', refreshInterval: 10000 },
  ],
};

/**
 * A layout's widgets column is JSON that predates the save check
 * (SENSOR-MEDIUM-152): a range no chart resolves must be parsed where the
 * layout enters the page, not reach a chart that throws on it.
 */
describe('dashboard layout widget ranges', () => {
  it('parses a stored range to a preset, or the default when it is none', () => {
    expect(parseWidgetTimeRange('7d')).toBe('7d');
    expect(parseWidgetTimeRange('12h')).toBe(DEFAULT_WIDGET_TIME_RANGE);
    expect(parseWidgetTimeRange(undefined)).toBe(DEFAULT_WIDGET_TIME_RANGE);
  });

  it('gives the page only widget ranges a chart can resolve', async () => {
    transport.graphqlFetch.mockImplementation((query) =>
      Promise.resolve(
        query.includes('myDefaultLayout')
          ? { myDefaultLayout: STORED_LAYOUT }
          : { dashboardLayouts: [STORED_LAYOUT] },
      ),
    );
    const { result } = renderHook(() => useDashboardLayout());
    await waitFor(() => expect(result.current.currentLayout).not.toBeNull());
    await waitFor(() => expect(result.current.layouts).toHaveLength(1));

    const ranges = (widgets: readonly { id: string; timeRange: string }[]): string[] =>
      widgets.map((widget) => `${widget.id}:${widget.timeRange}`);
    const expected = [
      'kept:7d',
      `unknown:${DEFAULT_WIDGET_TIME_RANGE}`,
      `missing:${DEFAULT_WIDGET_TIME_RANGE}`,
    ];
    expect(ranges(result.current.currentLayout?.widgets ?? [])).toEqual(expected);
    expect(ranges(result.current.layouts[0]?.widgets ?? [])).toEqual(expected);
  });
});
