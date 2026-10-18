/**
 * The workspace menu's per-module alarm counts (ALERT-MEDIUM-010).
 *
 * alert-engine records the module an alarm comes from, and the menu draws
 * each module workspace's P1/P2/P3 from those counts — no preview, no MOCK
 * chip. A row draws nothing until the counts are ready (never a zero nobody
 * measured), and Company aggregates no module's alarms. The slot follows the
 * annunciator's gate — the alarm list in the nav on screen (the previewed
 * role's while an admin views as one) — and the viewer's alarm access, so the
 * menu never offers counts for an alarm feature the rest of the console hides.
 */
import { render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceAlarmCounts } from '../../data/useWorkspaceAlarmCounts';
import { buildConsoleNav, findNavPage, type ConsoleNavInput } from '../../nav';
import { ALL_CAPABILITIES, navInput } from '../../nav/__tests__/viewers.fixture';
import { viewAsNavInput } from '../../shell/viewAs';
import { useWorkspaceAlarmsSlot } from '../WorkspaceAlarms';

/** Whether the nav built from `input` lists the alarm list — ConsoleShell's annunciator gate. */
function alarmListShown(input: ConsoleNavInput): boolean {
  return findNavPage(buildConsoleNav(input), 'alarms') !== undefined;
}

const READY: WorkspaceAlarmCounts = {
  status: 'ready',
  byWorkspace: {
    aqua: { p1: 1, p2: 0, p3: 2 },
    gh: { p1: 0, p2: 0, p3: 0 },
    ctl: { p1: 0, p2: 3, p3: 0 },
  },
};

const counts = vi.hoisted(() => ({ current: undefined as WorkspaceAlarmCounts | undefined }));

vi.mock('../../data/useWorkspaceAlarmCounts', () => ({
  useWorkspaceAlarmCounts: (): WorkspaceAlarmCounts | undefined => counts.current,
}));

beforeEach(() => {
  counts.current = READY;
});

function slotOf(shown = true): ReturnType<typeof useWorkspaceAlarmsSlot> {
  return renderHook(() => useWorkspaceAlarmsSlot(shown)).result.current;
}

describe('useWorkspaceAlarmsSlot — the counts', () => {
  it('draws each module workspace’s own counts, with no preview chip', () => {
    const slot = slotOf();
    const { container } = render(
      <>
        <div data-testid="aqua">{slot?.('aqua')}</div>
        <div data-testid="ctl">{slot?.('ctl')}</div>
      </>,
    );

    const aqua = screen.getByTestId('aqua');
    expect([...aqua.querySelectorAll('[data-priority]')].map((pair) => pair.textContent)).toEqual(
      ['1 critical (P1) alarm', '2 medium (P3) alarms'].map((spoken) =>
        expect.stringContaining(spoken),
      ),
    );
    expect(screen.getByTestId('ctl').textContent).toContain('3 high (P2) alarms');
    expect(screen.queryByRole('button', { name: 'MOCK' })).toBeNull();
    expect(container.querySelector('[data-preview-finding]')).toBeNull();
  });

  it('draws nothing for a workspace without active alarms', () => {
    const { container } = render(<>{slotOf()?.('gh')}</>);
    expect(container.querySelectorAll('[data-priority]')).toHaveLength(0);
  });

  it('gives Company no alarm column', () => {
    expect(slotOf()?.('org')).toBeNull();
  });

  it.each(['loading', 'error'] as const)('draws no count while the counts are %s', (status) => {
    counts.current = { status, byWorkspace: null };
    const slot = slotOf();
    expect(slot).toBeDefined();
    expect(slot?.('aqua')).toBeNull();
  });
});

describe('useWorkspaceAlarmsSlot — the gate', () => {
  it('hands the menu no slot when the viewer cannot read alarms', () => {
    counts.current = { status: 'unavailable', byWorkspace: null };
    expect(slotOf(true)).toBeUndefined();
  });

  it('hands a farm-only tenant admin no slot: no alarm list, no annunciator, no counts', () => {
    const farmOnlyAdmin = navInput({
      role: 'TENANT_ADMIN',
      modules: ['farm'],
      permissions: ALL_CAPABILITIES,
    });
    // Without the sensor module the nav has no alarm list to open.
    expect(alarmListShown(farmOnlyAdmin)).toBe(false);
    expect(slotOf(alarmListShown(farmOnlyAdmin))).toBeUndefined();
  });

  it('follows the nav on screen, not the real viewer, while an admin views as a role', () => {
    const realAdmin = navInput({
      role: 'TENANT_ADMIN',
      modules: ['farm', 'sensor'],
      permissions: ALL_CAPABILITIES,
    });
    expect(alarmListShown(realAdmin)).toBe(true);
    const previewed = viewAsNavInput(realAdmin, { resourcePermissions: [] });

    const { result, rerender } = renderHook(
      ({ shown }: { shown: boolean }) => useWorkspaceAlarmsSlot(shown),
      { initialProps: { shown: alarmListShown(previewed) } },
    );
    // The alarm list's only gate is the sensor module, which a preview keeps,
    // so a role view of this tenant still lists it — and gets the column.
    expect(result.current).toBeDefined();

    // A previewed nav without the alarm list (the annunciator hidden) drops it.
    rerender({ shown: false });
    expect(result.current).toBeUndefined();
  });
});
