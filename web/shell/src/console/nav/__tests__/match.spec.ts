/**
 * Location matching primitives (FE-HIGH-335) and the module gate's path rule.
 */
import { describe, expect, it } from 'vitest';

import {
  MATCH_BASE,
  MATCH_EXACT,
  MATCH_NONE,
  MATCH_PATTERN,
  pageMatchScore,
  parseNavLocation,
  patternMatches,
} from '../match';
import { moduleForPath } from '../mounts';
import type { NavPageDef } from '../types';

describe('parseNavLocation', () => {
  it('splits the pathname from the tab query and drops hash and trailing slash', () => {
    expect(parseNavLocation('/sites/finance?tab=budget&from=2026')).toEqual({
      pathname: '/sites/finance',
      tab: 'budget',
    });
    expect(parseNavLocation('/sites/tanks/#top')).toEqual({ pathname: '/sites/tanks', tab: null });
    expect(parseNavLocation('/?x=1')).toEqual({ pathname: '/', tab: null });
  });
});

describe('patternMatches', () => {
  it('matches literals, one-segment parameters and a trailing splat', () => {
    expect(patternMatches('/sensor/devices/:deviceId', '/sensor/devices/d-1')).toBe(true);
    expect(patternMatches('/sensor/devices/:deviceId', '/sensor/devices/edge/d-1')).toBe(false);
    expect(patternMatches('/sites/batch/:batchId/*', '/sites/batch/b-1')).toBe(true);
    expect(patternMatches('/sites/batch/:batchId/*', '/sites/batch/b-1/tanks')).toBe(true);
    expect(patternMatches('/sites/batch/:batchId/*', '/sites/batch')).toBe(false);
  });

  it('treats a parameter in the matched path as matchable only by a parameter or splat', () => {
    expect(patternMatches('/hr/employees/:id', '/hr/employees/:employeeId')).toBe(true);
    expect(patternMatches('/hr/employees/new', '/hr/employees/:employeeId')).toBe(false);
  });
});

describe('pageMatchScore', () => {
  const page: NavPageDef = {
    id: 'tanks',
    labelKey: 'nav.tanksPonds',
    path: '/sites/tanks',
    matchPaths: ['/sites/batch/:batchId/*'],
    tabs: [
      { id: 'cleanerFish', labelKey: 'nav.tab.cleanerFish', path: '/sites/tanks?tab=cleanerFish' },
    ],
  };
  const tabbed: NavPageDef = {
    id: 'budget',
    labelKey: 'nav.page.budget',
    path: '/sites/finance?tab=budget',
  };

  it('ranks exact, base, pattern and none', () => {
    expect(pageMatchScore(page, parseNavLocation('/sites/tanks?tab=cleanerFish'))).toBe(
      MATCH_EXACT,
    );
    expect(pageMatchScore(page, parseNavLocation('/sites/tanks'))).toBe(MATCH_BASE);
    expect(pageMatchScore(page, parseNavLocation('/sites/tanks?tab=other'))).toBe(MATCH_BASE);
    expect(pageMatchScore(page, parseNavLocation('/sites/batch/b-1/overview'))).toBe(MATCH_PATTERN);
    expect(pageMatchScore(page, parseNavLocation('/sites/feeding'))).toBe(MATCH_NONE);
  });

  it('treats the default tab spelled out in the URL as the page itself, without a tab strip', () => {
    const overview: NavPageDef = {
      id: 'finance-overview',
      labelKey: 'nav.overview',
      path: '/sites/finance',
      defaultTab: 'overview',
    };
    expect(pageMatchScore(overview, parseNavLocation('/sites/finance?tab=overview'))).toBe(
      MATCH_EXACT,
    );
    expect(pageMatchScore(overview, parseNavLocation('/sites/finance'))).toBe(MATCH_BASE);
    expect(pageMatchScore(overview, parseNavLocation('/sites/finance?tab=budget'))).toBe(
      MATCH_BASE,
    );
    expect(pageMatchScore(overview, parseNavLocation('/hr/finance?tab=overview'))).toBe(MATCH_NONE);
  });

  it('never lets a `?tab=` entry claim its page without that tab', () => {
    expect(pageMatchScore(tabbed, parseNavLocation('/sites/finance?tab=budget'))).toBe(MATCH_EXACT);
    expect(pageMatchScore(tabbed, parseNavLocation('/sites/finance'))).toBe(MATCH_NONE);
    expect(pageMatchScore(tabbed, parseNavLocation('/sites/finance?tab=expenses'))).toBe(
      MATCH_NONE,
    );
  });
});

describe('moduleForPath', () => {
  it('reads a remote mount’s module for every page under its prefix', () => {
    expect(moduleForPath('/sites/finance?tab=budget')).toBe('farm');
    expect(moduleForPath('/sensor')).toBe('sensor');
    expect(moduleForPath('/hydroponics/setup')).toBe('hydroponics');
    expect(moduleForPath('/hr/today')).toBe('hr');
    expect(moduleForPath('/tenant/users')).toBeUndefined();
    expect(moduleForPath('/sitesx/whatever')).toBeUndefined();
  });

  it('gates each module dashboard by its own path, and leaves trends open', () => {
    expect(moduleForPath('/dashboard')).toBe('farm');
    expect(moduleForPath('/dashboard/control')).toBe('sensor');
    expect(moduleForPath('/dashboard/greenhouse?tab=zones')).toBe('hydroponics');
    expect(moduleForPath('/dashboard/analytics')).toBeUndefined();
    expect(moduleForPath('/dashboardx')).toBeUndefined();
  });
});
