/**
 * SCADA editor stores — tenant-switch / logout reset (SENSOR-HIGH-041).
 *
 * The SCADA design store, the process (P&ID) store, and the editor-mode store
 * are single-active, tenant-owned singletons. If they are not reset when the
 * session's tenant changes (A -> B) or on logout, tenant A's in-progress design
 * lingers in the same browser and can surface in — or be saved into — tenant B's
 * session. These tests pin the reset wiring registered at module load.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture every callback the store modules register at import time, so the test
// can fire a logout / tenant switch and assert the stores reset.
const cbs = vi.hoisted(() => ({
  logout: new Set<() => void>(),
  tenantChange: new Set<(oldTenantId: string) => void>(),
}));
vi.mock('@aquaculture/shared-ui', () => ({
  registerLogoutCleanup: (fn: () => void) => {
    cbs.logout.add(fn);
    return () => cbs.logout.delete(fn);
  },
  onTenantChange: (fn: (oldTenantId: string) => void) => {
    cbs.tenantChange.add(fn);
    return () => cbs.tenantChange.delete(fn);
  },
}));

import { useScadaPackageStore } from '../scada';
import { useProcessStore } from '../processStore';
import { useEditorModeStore } from '../editorModeStore';

function fireLogout(): void {
  for (const cb of cbs.logout) cb();
}
function fireTenantChange(oldTenantId: string): void {
  for (const cb of cbs.tenantChange) cb(oldTenantId);
}

/** Mutate all three stores away from their initial state. */
function dirtyAllStores(): void {
  useScadaPackageStore.getState().setPackageName('Tenant-A secret design');
  useScadaPackageStore.setState({ processId: 'proc-A', isDirty: true });

  useProcessStore.getState().setProcessName('Tenant-A process');
  useProcessStore.setState({ processId: 'proc-A', isDirty: true });

  useEditorModeStore.getState().setMode('hmi');
}

describe('SCADA editor stores tenant/logout reset (SENSOR-HIGH-041)', () => {
  beforeEach(() => {
    useScadaPackageStore.getState().reset();
    useProcessStore.getState().resetStore();
    useEditorModeStore.getState().reset();
  });

  it('registers logout + tenant-change cleanup for all three stores', () => {
    // Each of the three store modules self-registers on both channels.
    expect(cbs.logout.size).toBeGreaterThanOrEqual(3);
    expect(cbs.tenantChange.size).toBeGreaterThanOrEqual(3);
  });

  it('fully resets every store on a tenant switch (A -> B)', () => {
    dirtyAllStores();
    expect(useScadaPackageStore.getState().packageName).toBe('Tenant-A secret design');
    expect(useProcessStore.getState().processName).toBe('Tenant-A process');
    expect(useEditorModeStore.getState().mode).toBe('hmi');

    fireTenantChange('tenant-A');

    expect(useScadaPackageStore.getState().packageName).toBe('');
    expect(useScadaPackageStore.getState().processId).toBeNull();
    expect(useScadaPackageStore.getState().isDirty).toBe(false);
    expect(useProcessStore.getState().processName).toBe('');
    expect(useProcessStore.getState().processId).toBeNull();
    expect(useProcessStore.getState().isDirty).toBe(false);
    expect(useEditorModeStore.getState().mode).toBe('pid');
  });

  it('fully resets every store on logout', () => {
    dirtyAllStores();

    fireLogout();

    expect(useScadaPackageStore.getState().packageName).toBe('');
    expect(useScadaPackageStore.getState().processId).toBeNull();
    expect(useProcessStore.getState().processName).toBe('');
    expect(useProcessStore.getState().processId).toBeNull();
    expect(useEditorModeStore.getState().mode).toBe('pid');
  });
});
