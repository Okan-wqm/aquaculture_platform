import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_WIDGET_TIME_RANGE, parseWidgetTimeRange } from '../../components/dashboard/types';
import { useDashboardLayout } from '../useDashboardLayout';

vi.mock('@aquaculture/shared-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aquaculture/shared-ui')>()),
  getAccessToken: () => 'token',
  getTenantId: () => 'tenant-1',
}));

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

function respond(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A layout's widgets column is JSON that predates the save check
 * (SENSOR-MEDIUM-152): a range no chart resolves must be parsed where the
 * layout enters the page, not reach a chart that throws on it.
 */
describe('dashboard layout widget ranges', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a stored range to a preset, or the default when it is none', () => {
    expect(parseWidgetTimeRange('7d')).toBe('7d');
    expect(parseWidgetTimeRange('12h')).toBe(DEFAULT_WIDGET_TIME_RANGE);
    expect(parseWidgetTimeRange(undefined)).toBe(DEFAULT_WIDGET_TIME_RANGE);
  });

  it('gives the page only widget ranges a chart can resolve', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) =>
        String(init.body).includes('myDefaultLayout')
          ? respond({ myDefaultLayout: STORED_LAYOUT })
          : respond({ dashboardLayouts: [STORED_LAYOUT] }),
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
