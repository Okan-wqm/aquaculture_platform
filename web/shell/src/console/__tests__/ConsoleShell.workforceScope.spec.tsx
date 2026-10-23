/**
 * ConsoleShell provides the workforce scope (module-scoped HR).
 *
 * The routed page sits inside a WorkforceScopeProvider fed by the FOLLOWED
 * workspace's module, so the HR hooks of the federated hr-module learn which
 * module's people the reader is looking at without a prop. The probe below is
 * the routed page: it reads what an HR hook reads (`useWorkforceScope`).
 *
 * Everything the frame draws around the page that needs data or a session is
 * stubbed; the nav, the followed-workspace rule and the provider are the real
 * ones.
 */
import { WorkforceScopeProvider, useWorkforceScope } from '@aquaculture/shared-ui';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleShell } from '../ConsoleShell';

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    ...actual,
    // A tenant admin holding every module: all four workspaces exist.
    useAuthContext: () => ({
      modules: [{ code: 'farm' }, { code: 'hydroponics' }, { code: 'sensor' }, { code: 'hr' }],
      user: { tenantName: 'Test tenant' },
    }),
    useAuth: () => ({ tenantId: 't1', hasPermission: () => true }),
  };
});

vi.mock('../data', () => {
  const pending = { status: 'loading' as const };
  return {
    useAlarmSummary: () => pending,
    useDeviceStatus: () => pending,
    useSiteStatus: () => pending,
  };
});
vi.mock('../palette/ConsolePalette', () => ({ ConsolePalette: (): null => null }));
vi.mock('../shell/ConsoleUserMenu', () => ({ ConsoleUserMenu: (): null => null }));
vi.mock('../shell/ConsoleAnnunciator', () => ({ ConsoleAnnunciator: (): null => null }));
vi.mock('../header/TitleBlockRevision', () => ({ TitleBlockRevision: (): null => null }));
vi.mock('../rail/WorkspaceAlarms', () => ({ useWorkspaceAlarmsSlot: (): undefined => undefined }));
vi.mock('../../utils/routePreload', () => ({ preloadRoute: (): void => {} }));

function ScopeProbe(): ReactElement {
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="scope">{useWorkforceScope() ?? 'none'}</output>
      <button type="button" onClick={() => navigate('/hr/employees')}>
        open the team list
      </button>
    </>
  );
}

function consoleAt(path: string): ReactElement {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          element={<ConsoleShell role="TENANT_ADMIN" headerTools={null} onSignOut={() => {}} />}
        >
          <Route path="*" element={<ScopeProbe />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function scopeOnScreen(): string | null {
  return screen.getByTestId('scope').textContent;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.ws;
});

describe('ConsoleShell — the routed page reads the followed workspace as its scope', () => {
  it.each([
    ['/sites/tanks', 'FARM'],
    ['/hydroponics/solution/water_analysis', 'HYDROPONICS'],
    ['/sensor/devices', 'SENSOR'],
  ])('%s is a module workspace page: scope %s', (path, scope) => {
    render(consoleAt(path));
    expect(scopeOnScreen()).toBe(scope);
  });

  it('gives a Company-only page no scope: every module', () => {
    render(consoleAt('/hr/payroll'));
    expect(scopeOnScreen()).toBe('none');
  });

  it('gives the shared team list the scope of the workspace the reader came from', () => {
    // Company → team list stays in Company (every module); a module workspace → the
    // same page narrows to that module. One page object, scoped by where it is opened.
    const company = render(consoleAt('/hr/payroll'));
    fireEvent.click(screen.getByRole('button', { name: 'open the team list' }));
    expect(scopeOnScreen()).toBe('none');
    company.unmount();

    render(consoleAt('/sensor/devices'));
    fireEvent.click(screen.getByRole('button', { name: 'open the team list' }));
    expect(scopeOnScreen()).toBe('SENSOR');
  });

  it('scopes a cold visit to the shared team list to the first workspace listing it', () => {
    render(consoleAt('/hr/employees'));
    expect(scopeOnScreen()).toBe('FARM');
  });

  it('lets the followed workspace decide, whatever scope a provider above the console holds', () => {
    render(
      <WorkforceScopeProvider moduleCode="SENSOR">
        {consoleAt('/hr/payroll')}
      </WorkforceScopeProvider>,
    );
    expect(scopeOnScreen()).toBe('none');
  });
});
