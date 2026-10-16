/**
 * ConsoleShellContext (FE-HIGH-334, design digest §10.1/§11): the console's
 * own state — workspace, rail collapse, palette, role preview. The workspace
 * and the rail choice survive a reload per tenant (tenant-scoped storage,
 * swept on logout); the palette and the preview never persist.
 */
import { act, renderHook } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ViewAsRole } from '../data';
import { ConsoleShellProvider, useConsoleShell } from '../ConsoleShellContext';

const WS_KEY = 'aqua.tss::t1::suderra.console.ws';
const COLLAPSED_KEY = 'aqua.tss::t1::suderra.console.navCollapsed';

function wrapperFor(tenantId: string | null): (props: { children: ReactNode }) => ReactElement {
  return function Wrapper({ children }: { children: ReactNode }): ReactElement {
    return <ConsoleShellProvider tenantId={tenantId}>{children}</ConsoleShellProvider>;
  };
}

const ROLE: ViewAsRole = {
  id: 'r-1',
  name: 'Operator',
  description: null,
  color: 'green',
  level: 30,
  isSystem: true,
  resourcePermissions: ['users:view'],
};

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('ConsoleShellContext — persisted per tenant', () => {
  it('starts with no choice: the workspace follows the route, the rail the window', () => {
    const { result } = renderHook(() => useConsoleShell(), { wrapper: wrapperFor('t1') });
    expect(result.current.ws).toBeNull();
    expect(result.current.navCollapsed).toBeNull();
  });

  it('stores the workspace and the rail choice under the tenant-scoped console keys', () => {
    const { result } = renderHook(() => useConsoleShell(), { wrapper: wrapperFor('t1') });
    act(() => result.current.setWs('gh'));
    act(() => result.current.setNavCollapsed(true));
    expect(result.current.ws).toBe('gh');
    expect(result.current.navCollapsed).toBe(true);
    expect(localStorage.getItem(WS_KEY)).toBe('"gh"');
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('true');
  });

  it("restores the tenant's stored choice, and only that tenant's", () => {
    localStorage.setItem(WS_KEY, '"ctl"');
    localStorage.setItem(COLLAPSED_KEY, 'false');
    const own = renderHook(() => useConsoleShell(), { wrapper: wrapperFor('t1') });
    expect(own.result.current.ws).toBe('ctl');
    expect(own.result.current.navCollapsed).toBe(false);
    const other = renderHook(() => useConsoleShell(), { wrapper: wrapperFor('t2') });
    expect(other.result.current.ws).toBeNull();
    expect(other.result.current.navCollapsed).toBeNull();
  });

  it('ignores a stored value the console never writes', () => {
    localStorage.setItem(WS_KEY, '"mars"');
    localStorage.setItem(COLLAPSED_KEY, '"yes"');
    const { result } = renderHook(() => useConsoleShell(), { wrapper: wrapperFor('t1') });
    expect(result.current.ws).toBeNull();
    expect(result.current.navCollapsed).toBeNull();
  });

  it('keeps choices in memory only while no tenant is resolved', () => {
    const { result } = renderHook(() => useConsoleShell(), { wrapper: wrapperFor(null) });
    act(() => result.current.setWs('org'));
    expect(result.current.ws).toBe('org');
    expect(localStorage.length).toBe(0);
  });
});

describe('ConsoleShellContext — session state', () => {
  it('opens the palette on an empty query and clears the query on close', () => {
    const { result } = renderHook(() => useConsoleShell(), { wrapper: wrapperFor('t1') });
    act(() => result.current.setPaletteOpen(true));
    expect(result.current.paletteOpen).toBe(true);
    act(() => result.current.setPaletteQuery('tank'));
    expect(result.current.paletteQuery).toBe('tank');
    act(() => result.current.setPaletteOpen(false));
    expect(result.current.paletteOpen).toBe(false);
    expect(result.current.paletteQuery).toBe('');
    act(() => result.current.togglePalette());
    expect(result.current.paletteOpen).toBe(true);
  });

  it('holds the role preview for the session without writing it anywhere', () => {
    const { result } = renderHook(() => useConsoleShell(), { wrapper: wrapperFor('t1') });
    expect(result.current.viewAsRole).toBeNull();
    act(() => result.current.setViewAsRole(ROLE));
    expect(result.current.viewAsRole).toBe(ROLE);
    expect(localStorage.length).toBe(0);
    act(() => result.current.setViewAsRole(null));
    expect(result.current.viewAsRole).toBeNull();
  });

  it("keeps a workspace chosen during a role preview apart from the admin's own", () => {
    localStorage.setItem(WS_KEY, '"aqua"');
    const { result } = renderHook(() => useConsoleShell(), { wrapper: wrapperFor('t1') });
    act(() => result.current.setViewAsRole(ROLE));
    // The preview starts where the admin is.
    expect(result.current.ws).toBe('aqua');
    act(() => result.current.setWs('gh'));
    expect(result.current.ws).toBe('gh');
    // Stored is still the admin's own: their next visit opens it, not the preview's.
    expect(localStorage.getItem(WS_KEY)).toBe('"aqua"');
    act(() => result.current.setViewAsRole(null));
    expect(result.current.ws).toBe('aqua');
    expect(localStorage.getItem(WS_KEY)).toBe('"aqua"');
  });

  it('decides from the state, not a stale callback: a preview and a choice in one tick', () => {
    localStorage.setItem(WS_KEY, '"aqua"');
    const { result } = renderHook(() => useConsoleShell(), { wrapper: wrapperFor('t1') });
    const { setViewAsRole, setWs } = result.current;
    act(() => {
      setViewAsRole(ROLE);
      setWs('ctl');
    });
    expect(result.current.ws).toBe('ctl');
    expect(localStorage.getItem(WS_KEY)).toBe('"aqua"');
  });

  it('is only readable inside the console', () => {
    expect(() => renderHook(() => useConsoleShell())).toThrow(/ConsoleShellProvider/);
  });
});
