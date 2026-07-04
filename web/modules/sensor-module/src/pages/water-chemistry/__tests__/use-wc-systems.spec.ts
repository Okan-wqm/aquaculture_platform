import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useWcSystems } from '../useWcSystems';

describe('useWcSystems', () => {
  beforeEach(() => localStorage.clear());

  it('seeds one system tab (loop-a) with a non-empty flow', () => {
    const { result } = renderHook(() => useWcSystems());
    expect(result.current.systems).toHaveLength(1);
    expect(result.current.systems[0].kind).toBe('system');
    expect(result.current.systems[0].flow.length).toBeGreaterThan(0);
  });

  it('adds then removes a system tab', () => {
    const { result } = renderHook(() => useWcSystems());
    let id = '';
    act(() => {
      id = result.current.addSystem('loop-b');
    });
    expect(result.current.systems).toHaveLength(2);
    act(() => {
      result.current.removeSystem(id);
    });
    expect(result.current.systems).toHaveLength(1);
  });

  it('opts a member out via a flow patch (updateSystem)', () => {
    const { result } = renderHook(() => useWcSystems());
    const sys = result.current.systems[0];
    const first = sys.flow[0];
    act(() => {
      result.current.updateSystem(sys.id, {
        flow: sys.flow.map((s) => (s.id === first.id ? { ...s, enabled: false } : s)),
      });
    });
    expect(result.current.systems[0].flow[0].enabled).toBe(false);
  });
});
