/**
 * useStEditor persistence (SENSOR-HIGH-049 / UI-001 / WF-006).
 *
 * save() was a local-only stub (`// TODO: persist to backend`): the dirty
 * marker cleared, but navigating away destroyed every ST program. In persist
 * mode the hook now hydrates from the backend AutomationProgram store and
 * save() writes through create/updateAutomationProgram. A DEPLOYED program is
 * immutable — save FORKS a new draft instead of overwriting what runs on the
 * device.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gql = vi.hoisted(() => ({
  fetch: vi.fn<(query: string, vars?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('../../config/api', () => ({
  graphqlFetch: gql.fetch,
}));

// The WS language service auto-connects on mount; stub it out entirely.
vi.mock('../useStLanguageService', () => ({
  useStLanguageService: () => ({
    isConnected: false,
    connectionStatus: 'disconnected',
    analyze: vi.fn(),
    validate: vi.fn(),
    complete: vi.fn(),
    format: vi.fn(),
    hover: vi.fn(),
    outline: vi.fn(),
  }),
}));

import { useStEditor } from '../useStEditor';

function mockStList(items: Array<Record<string, unknown>>): void {
  gql.fetch.mockImplementation(async (query: string) => {
    if (query.includes('StPrograms')) {
      return { automationPrograms: { items } };
    }
    if (query.includes('CreateAutomationProgram')) {
      return { createAutomationProgram: { id: 'backend-new-1' } };
    }
    if (query.includes('UpdateAutomationProgram')) {
      return { updateAutomationProgram: { id: 'backend-1' } };
    }
    throw new Error(`unexpected query: ${query.slice(0, 60)}`);
  });
}

describe('useStEditor persistence (SENSOR-HIGH-049)', () => {
  beforeEach(() => {
    gql.fetch.mockReset();
  });

  it('hydrates the program list from the backend in persist mode', async () => {
    mockStList([
      {
        id: 'backend-1',
        programCode: 'AERATION_A1',
        programName: 'Aeration Control',
        status: 'draft',
        structuredTextCode: 'PROGRAM Aeration\nEND_PROGRAM',
        updatedAt: '2026-07-10T00:00:00Z',
      },
    ]);

    const { result } = renderHook(() => useStEditor({ persist: true }));

    await waitFor(() => expect(result.current.isHydrating).toBe(false));
    expect(result.current.programs).toHaveLength(1);
    expect(result.current.programs[0]).toMatchObject({
      backendId: 'backend-1',
      name: 'Aeration Control',
      status: 'draft',
      source: 'PROGRAM Aeration\nEND_PROGRAM',
    });
    // Hydration is a load, not an edit.
    expect(result.current.isDirty).toBe(false);
  });

  it('save() on a never-persisted program CREATES it and stores the backend id', async () => {
    mockStList([]); // empty registry → local default 'Main' survives

    const { result } = renderHook(() => useStEditor({ persist: true }));
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    act(() => result.current.updateSource('PROGRAM Main\n(* edited *)\nEND_PROGRAM'));
    expect(result.current.isDirty).toBe(true);

    act(() => result.current.save());
    await waitFor(() => expect(result.current.isSaving).toBe(false));

    const createCall = gql.fetch.mock.calls.find(([q]) => q.includes('CreateAutomationProgram'));
    expect(createCall).toBeTruthy();
    const input = (createCall![1] as { input: Record<string, unknown> }).input;
    expect(input.programType).toBe('ST');
    expect(input.programName).toBe('Main');
    expect(input.structuredTextCode).toContain('(* edited *)');
    expect(String(input.programCode)).toMatch(/^MAIN_[A-Z0-9]+$/);
    expect(String(input.programCode).length).toBeLessThanOrEqual(30);

    expect(result.current.programs[0]?.backendId).toBe('backend-new-1');
    expect(result.current.isDirty).toBe(false);
    expect(result.current.saveError).toBeNull();
  });

  it('save() on a persisted DRAFT program UPDATES it in place', async () => {
    mockStList([
      {
        id: 'backend-1',
        programCode: 'AERATION_A1',
        programName: 'Aeration Control',
        status: 'draft',
        structuredTextCode: 'PROGRAM A\nEND_PROGRAM',
        updatedAt: '2026-07-10T00:00:00Z',
      },
    ]);

    const { result } = renderHook(() => useStEditor({ persist: true }));
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    act(() => result.current.updateSource('PROGRAM A\n(* v2 *)\nEND_PROGRAM'));
    act(() => result.current.save());
    await waitFor(() => expect(result.current.isSaving).toBe(false));

    const updateCall = gql.fetch.mock.calls.find(([q]) => q.includes('UpdateAutomationProgram'));
    expect(updateCall).toBeTruthy();
    expect(updateCall![1]).toMatchObject({
      id: 'backend-1',
      input: { structuredTextCode: 'PROGRAM A\n(* v2 *)\nEND_PROGRAM' },
    });
    expect(gql.fetch.mock.calls.some(([q]) => q.includes('CreateAutomationProgram'))).toBe(false);
    expect(result.current.isDirty).toBe(false);
  });

  it('save() on a DEPLOYED program FORKS a new draft instead of overwriting', async () => {
    mockStList([
      {
        id: 'backend-1',
        programCode: 'AERATION_A1',
        programName: 'Aeration Control',
        status: 'deployed',
        structuredTextCode: 'PROGRAM A\nEND_PROGRAM',
        updatedAt: '2026-07-10T00:00:00Z',
      },
    ]);

    const { result } = renderHook(() => useStEditor({ persist: true }));
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    act(() => result.current.updateSource('PROGRAM A\n(* hotfix *)\nEND_PROGRAM'));
    act(() => result.current.save());
    await waitFor(() => expect(result.current.isSaving).toBe(false));

    // The deployed program is never updated in place.
    expect(gql.fetch.mock.calls.some(([q]) => q.includes('UpdateAutomationProgram'))).toBe(false);
    const createCall = gql.fetch.mock.calls.find(([q]) => q.includes('CreateAutomationProgram'));
    expect(createCall).toBeTruthy();

    // The local program now tracks the NEW draft.
    expect(result.current.programs[0]).toMatchObject({
      backendId: 'backend-new-1',
      status: 'draft',
    });
  });

  it('a failed save keeps the program dirty and surfaces the error', async () => {
    mockStList([]);
    const { result } = renderHook(() => useStEditor({ persist: true }));
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    gql.fetch.mockRejectedValue(new Error('network down'));
    act(() => result.current.updateSource('PROGRAM Main\n(* x *)\nEND_PROGRAM'));
    act(() => result.current.save());
    await waitFor(() => expect(result.current.isSaving).toBe(false));

    expect(result.current.saveError).toContain('network down');
    expect(result.current.isDirty).toBe(true); // dirty only clears on a CONFIRMED write
  });

  it('embedded (non-persist) mode keeps local-only dirty tracking and never calls the backend', async () => {
    const { result } = renderHook(() => useStEditor({ persist: false }));

    act(() => result.current.updateSource('PROGRAM Main\n(* local *)\nEND_PROGRAM'));
    expect(result.current.isDirty).toBe(true);
    act(() => result.current.save());

    expect(result.current.isDirty).toBe(false);
    expect(gql.fetch).not.toHaveBeenCalled();
  });
});
