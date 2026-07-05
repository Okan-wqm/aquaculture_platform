/**
 * useEffectiveReportSite spec (FARM-HIGH-128).
 *
 * Locks the site-resolution precedence (explicit prop > operator selection >
 * first configured mapping) that feeds the fail-closed identity resolver, so a
 * bare-mounted tab defaults to a REAL mapped site instead of lokalitetsnummer 0.
 */
import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../hooks/useRegulatory', () => ({
  useRegulatorySettings: () => ({
    data: {
      siteLocalityMappings: [
        { siteId: 'site-1', lokalitetsnummer: 12345 },
        { siteId: 'site-2', lokalitetsnummer: 67890 },
      ],
    },
  }),
}));

import { useEffectiveReportSite } from '../useEffectiveReportSite';

describe('useEffectiveReportSite', () => {
  it('defaults to the first configured mapping when nothing is pinned', () => {
    const { result } = renderHook(() => useEffectiveReportSite());
    expect(result.current.effectiveSiteId).toBe('site-1');
    expect(result.current.showSelector).toBe(true); // >1 mapping, no prop
  });

  it('lets an explicit siteId prop win and hides the selector', () => {
    const { result } = renderHook(() => useEffectiveReportSite('site-2'));
    expect(result.current.effectiveSiteId).toBe('site-2');
    expect(result.current.showSelector).toBe(false);
  });

  it('lets the operator selection override the default', () => {
    const { result } = renderHook(() => useEffectiveReportSite());
    act(() => result.current.setSelectedSiteId('site-2'));
    expect(result.current.effectiveSiteId).toBe('site-2');
  });
});
