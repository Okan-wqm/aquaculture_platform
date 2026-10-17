/**
 * The workspace menu's per-module alarm counts (ALERT-MEDIUM-010).
 *
 * alert-engine serves no alarm summary by module, so the counts are a
 * labelled preview: they only ever render beside the MOCK chip naming the
 * missing source and the finding. Company aggregates no module's alarms and
 * gets no column. The slot follows the annunciator's gate — the alarm list in
 * the nav on screen (the previewed role's while an admin views as one) — and
 * the viewer's alarm access, so the menu never offers counts for an alarm
 * feature the rest of the console hides.
 */
import { render, renderHook, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConsoleDataAccess } from '../../data/useConsoleDataAccess';
import { buildConsoleNav, findNavPage, type ConsoleNavInput } from '../../nav';
import { ALL_CAPABILITIES, navInput } from '../../nav/__tests__/viewers.fixture';
import { viewAsNavInput } from '../../shell/viewAs';
import { renderWorkspaceAlarms, useWorkspaceAlarmsSlot } from '../WorkspaceAlarms';

/** Whether the nav built from `input` lists the alarm list — ConsoleShell's annunciator gate. */
function alarmListShown(input: ConsoleNavInput): boolean {
  return findNavPage(buildConsoleNav(input), 'alarms') !== undefined;
}

const access = vi.hoisted(() => ({
  current: { alarms: true } as Pick<ConsoleDataAccess, 'alarms'>,
}));

vi.mock('../../data/useConsoleDataAccess', () => ({
  useConsoleDataAccess: (): Pick<ConsoleDataAccess, 'alarms'> => access.current,
}));

beforeEach(() => {
  access.current = { alarms: true };
});

describe('renderWorkspaceAlarms', () => {
  it.each(['aqua', 'gh', 'ctl'] as const)(
    'renders %s’s counts beside the MOCK chip that names ALERT-MEDIUM-010',
    (workspace) => {
      const { container } = render(<>{renderWorkspaceAlarms(workspace)}</>);

      const cell = container.querySelector('[data-preview-finding="ALERT-MEDIUM-010"]');
      expect(cell).not.toBeNull();
      const chip = screen.getByRole('button', { name: 'MOCK' });
      const describedBy = chip.getAttribute('aria-describedby');
      expect(describedBy).not.toBeNull();
      const description = document.getElementById(describedBy ?? '')?.textContent ?? '';
      expect(description).toContain('alarm summary by module');
      expect(description).toContain('ALERT-MEDIUM-010');
      expect(description).toContain('sample data');
      // Every count drawn sits inside the labelled preview.
      for (const pair of container.querySelectorAll('[data-priority]')) {
        expect(cell?.contains(pair)).toBe(true);
      }
    },
  );

  it('draws at least one priority pair for the sample', () => {
    const { container } = render(<>{renderWorkspaceAlarms('aqua')}</>);
    expect(container.querySelectorAll('[data-priority]').length).toBeGreaterThan(0);
    expect(within(container).getAllByText(/\(P\d\) alarms?$/).length).toBeGreaterThan(0);
  });

  it('gives Company no alarm column', () => {
    expect(renderWorkspaceAlarms('org')).toBeNull();
  });
});

describe('useWorkspaceAlarmsSlot', () => {
  it('hands the menu the slot when the alarm list is on screen and the viewer can read alarms', () => {
    const { result } = renderHook(() => useWorkspaceAlarmsSlot(true));
    expect(result.current).toBe(renderWorkspaceAlarms);
  });

  it('hands the menu no slot when the viewer cannot read alarms', () => {
    access.current = { alarms: false };
    const { result } = renderHook(() => useWorkspaceAlarmsSlot(true));
    expect(result.current).toBeUndefined();
  });

  it('hands a farm-only tenant admin no slot: no alarm list, no annunciator, no counts', () => {
    // A tenant admin may read alarm data whatever the modules…
    access.current = { alarms: true };
    const farmOnlyAdmin = navInput({
      role: 'TENANT_ADMIN',
      modules: ['farm'],
      permissions: ALL_CAPABILITIES,
    });
    // …but without the sensor module the nav has no alarm list to open.
    expect(alarmListShown(farmOnlyAdmin)).toBe(false);

    const { result } = renderHook(() => useWorkspaceAlarmsSlot(alarmListShown(farmOnlyAdmin)));
    expect(result.current).toBeUndefined();
  });

  it('follows the nav on screen, not the real viewer, while an admin views as a role', () => {
    // The real viewer reads alarms; the previewed role's nav decides.
    access.current = { alarms: true };
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
    expect(result.current).toBe(renderWorkspaceAlarms);

    // A previewed nav without the alarm list (the annunciator hidden) drops it.
    rerender({ shown: false });
    expect(result.current).toBeUndefined();
  });
});
