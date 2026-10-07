import type { TimeRangeSpec } from '@aquaculture/shared-contracts';
import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { useTimeRangeSearchParams } from '../useTimeRangeSearchParams';

const DEFAULT: TimeRangeSpec = { kind: 'relative', preset: '24h' };

function renderAt(url: string) {
  return renderHook(() => ({ range: useTimeRangeSearchParams(DEFAULT), location: useLocation() }), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
    ),
  });
}

describe('useTimeRangeSearchParams', () => {
  it('shows the default when the link carries no range', () => {
    const { result } = renderAt('/sensor/readings');
    expect(result.current.range).toMatchObject({ spec: DEFAULT, error: null });
  });

  it('shows the range the link carries', () => {
    const { result } = renderAt(
      '/sensor/readings?from=2026-09-16T00:00:00%2B03:00&to=2026-09-20T00:00:00%2B03:00',
    );
    expect(result.current.range.spec).toEqual({
      kind: 'absolute',
      startMs: Date.parse('2026-09-15T21:00:00Z'),
      endMs: Date.parse('2026-09-19T21:00:00Z'),
    });
  });

  it('reports a malformed range and shows the default meanwhile', () => {
    const { result } = renderAt('/sensor/readings?range=forever');
    expect(result.current.range).toMatchObject({ spec: DEFAULT, error: 'invalid' });
  });

  it('writes a new range over the old one and keeps the other parameters', () => {
    const { result } = renderAt('/sensor/readings?range=7d&sensor=s-1');
    act(() =>
      result.current.range.setSpec({
        kind: 'absolute',
        startMs: Date.parse('2026-09-16T00:00:00Z'),
        endMs: Date.parse('2026-09-17T00:00:00Z'),
      }),
    );
    const params = new URLSearchParams(result.current.location.search);
    expect([...params.keys()].sort()).toEqual(['from', 'sensor', 'to']);
    expect(params.get('sensor')).toBe('s-1');
    expect(params.get('from')).toBe('2026-09-16T00:00:00.000Z');
    act(() => result.current.range.setSpec({ kind: 'relative', preset: '30d' }));
    expect(new URLSearchParams(result.current.location.search).toString()).toBe(
      'sensor=s-1&range=30d',
    );
  });

  it('adds no history entry when the range already in the URL is set again', () => {
    const { result } = renderAt('/sensor/readings?range=7d');
    const before = result.current.location.key;
    act(() => result.current.range.setSpec({ kind: 'relative', preset: '7d' }));
    expect(result.current.location.key).toBe(before);
  });
});
