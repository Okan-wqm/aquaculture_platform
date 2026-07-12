/**
 * processStore — WF-004 dirty tracking.
 *
 * Loading a saved process must never count as editing: hydration is ONE store
 * transaction (loadProcess) that ends CLEAN, and a brand-new session starts
 * CLEAN (startNewProcess). The user-edit signal is markDirty — idempotent by
 * state identity so the canvas's per-drag-frame edit stream cannot re-render
 * subscribers on every mousemove.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@aquaculture/shared-ui', () => ({
  registerLogoutCleanup: () => () => undefined,
  onTenantChange: () => () => undefined,
}));

import { useProcessStore } from '../processStore';

describe('processStore — WF-004 dirty tracking', () => {
  beforeEach(() => {
    useProcessStore.getState().resetStore();
  });

  it('loadProcess hydrates in one transaction and ends CLEAN', () => {
    useProcessStore.getState().markDirty();

    useProcessStore.getState().loadProcess({
      id: 'p1',
      name: 'RAS Loop',
      description: 'main loop',
      status: 'active',
      nodes: [
        { id: 'n1', type: 'equipment', position: { x: 0, y: 0 }, data: { equipmentId: 'eq-1' } },
        { id: 'n2', type: 'sensor', position: { x: 10, y: 10 }, data: { sensorId: 'sen-1' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    });

    const s = useProcessStore.getState();
    expect(s.isDirty).toBe(false); // loading is not editing
    expect(s.processId).toBe('p1');
    expect(s.processName).toBe('RAS Loop');
    expect(s.processStatus).toBe('active');
    expect(s.processVersion).toBe('1.0.0'); // defaulted when absent
    // Node maps rebuilt from the hydrated nodes (BUG-003 parity).
    expect(s.equipmentNodeMap['eq-1']).toBe('n1');
    expect(s.sensorNodeMap['sen-1']).toBe('n2');
    // Persisted edges without typed data get the default connectionType.
    expect(s.edges[0]!.data?.connectionType).toBeTruthy();
  });

  it('markDirty flips the flag and is idempotent by state identity', () => {
    expect(useProcessStore.getState().isDirty).toBe(false);

    useProcessStore.getState().markDirty();
    const dirtyState = useProcessStore.getState();
    expect(dirtyState.isDirty).toBe(true);

    // Re-marking an already-dirty store must NOT produce a new state object
    // (zustand skips notification on identity) — drag streams stay cheap.
    useProcessStore.getState().markDirty();
    expect(useProcessStore.getState()).toBe(dirtyState);
  });

  it('startNewProcess begins a CLEAN session with the given name', () => {
    useProcessStore.getState().setProcessId('old-id');
    useProcessStore.getState().markDirty();

    useProcessStore.getState().startNewProcess('New Project');

    const s = useProcessStore.getState();
    expect(s.processName).toBe('New Project');
    expect(s.processId).toBeNull();
    expect(s.isDirty).toBe(false); // naming a fresh session is not an edit
    expect(s.nodes).toEqual([]);
    expect(s.edges).toEqual([]);
  });

  it('setProcessName remains a USER-edit signal (dirties the store)', () => {
    useProcessStore.getState().startNewProcess('New Project');
    useProcessStore.getState().setProcessName('Renamed by user');
    expect(useProcessStore.getState().isDirty).toBe(true);
  });
});
