/**
 * AlertsPage honours the console annunciator's `?priority=` (README §7.5).
 *
 * A tile click lands on `/sensor/alerts?priority=p1|p2|p3|unack`; the list
 * opens on the alarms the tile counted — P1/P2/P3 as the "Open" tab over the
 * severity set of that priority, sent to alert-engine as the supergraph's
 * enum names; UNACK as the "Active" (open, unacknowledged) tab over the
 * P1–P3 severities. A tile pressed while the list is open re-filters it; a
 * filter picked by hand rewrites the parameter, or drops it when no tile shows
 * that filter.
 *
 * The router is REAL (MemoryRouter + the route Module.tsx declares) so the
 * query-string contract is what is pinned; only the GraphQL transport is
 * stubbed, and every assertion reads the variables the page actually sent.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  graphqlFetch: vi.fn(async (): Promise<{ alertHistory: unknown[] }> => ({ alertHistory: [] })),
}));

vi.mock('../../../config/api', () => ({ graphqlFetch: transport.graphqlFetch }));

import AlertsPage from '../../AlertsPage';

interface Probe {
  search: () => string;
  navigate: (to: string) => void;
}

function renderAt(path: string): Probe {
  const probe: { search: string; navigate: (to: string) => void } = {
    search: '',
    navigate: () => undefined,
  };
  function LocationProbe(): null {
    const location = useLocation();
    probe.search = location.search;
    probe.navigate = useNavigate();
    return null;
  }
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="alerts"
          element={
            <>
              <AlertsPage />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { search: () => probe.search, navigate: (to) => probe.navigate(to) };
}

/** The variables of the latest alertHistory request. */
function lastVariables(): Record<string, unknown> {
  const calls = transport.graphqlFetch.mock.calls as unknown[][];
  const call = calls[calls.length - 1];
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

function severitySelect(): HTMLSelectElement {
  const select = document.querySelector('select');
  if (!(select instanceof HTMLSelectElement)) throw new Error('no severity select');
  return select;
}

/** The select once the list has settled (the page shows a spinner while a refetch of an empty list runs). */
function findSelect(): Promise<HTMLSelectElement> {
  return waitFor(severitySelect);
}

function statusTab(label: string): HTMLElement {
  return screen.getByRole('button', { name: label });
}

beforeEach(() => {
  transport.graphqlFetch.mockClear();
});

describe('AlertsPage — ?priority= as the initial filter', () => {
  it('opens P1 on the open critical alarms, sending the enum name', async () => {
    renderAt('/alerts?priority=p1');

    await waitFor(() => expect(transport.graphqlFetch).toHaveBeenCalled());
    expect(lastVariables()).toEqual({
      page: 1,
      limit: 20,
      severities: ['CRITICAL'],
      resolved: false,
    });
    await waitFor(() => expect(severitySelect().value).toBe('CRITICAL'));
    expect(statusTab('Open').getAttribute('aria-pressed')).toBe('true');
  });

  it('opens P2 on the open high alarms', async () => {
    renderAt('/alerts?priority=p2');

    await waitFor(() => expect(transport.graphqlFetch).toHaveBeenCalled());
    expect(lastVariables()).toEqual({ page: 1, limit: 20, severities: ['HIGH'], resolved: false });
  });

  it('opens P3 on the open medium + warning group the tile counted', async () => {
    renderAt('/alerts?priority=p3');

    await waitFor(() => expect(transport.graphqlFetch).toHaveBeenCalled());
    const variables = lastVariables();
    expect([...(variables.severities as string[])].sort()).toEqual(['MEDIUM', 'WARNING']);
    expect(variables.resolved).toBe(false);
    expect(variables).not.toHaveProperty('acknowledged');
    await waitFor(() => expect(severitySelect().value).toBe('p3'));
    expect(severitySelect().selectedOptions[0]?.textContent).toBe('Medium + warning (P3)');
  });

  it('opens UNACK on the open unacknowledged alarms of every priority, advisories left out', async () => {
    renderAt('/alerts?priority=unack');

    await waitFor(() => expect(transport.graphqlFetch).toHaveBeenCalled());
    const variables = lastVariables();
    expect(variables).toMatchObject({ page: 1, limit: 20, acknowledged: false, resolved: false });
    expect([...(variables.severities as string[])].sort()).toEqual([
      'CRITICAL',
      'HIGH',
      'MEDIUM',
      'WARNING',
    ]);
    expect(statusTab('Aktif').getAttribute('aria-pressed')).toBe('true');
    expect(severitySelect().value).toBe('alarms');
    expect(severitySelect().selectedOptions[0]?.textContent).toBe('All alarms (P1–P3)');
  });

  it('shows every alarm without a priority, or with one no tile has', async () => {
    renderAt('/alerts?priority=p9');

    await waitFor(() => expect(transport.graphqlFetch).toHaveBeenCalled());
    expect(lastVariables()).toEqual({ page: 1, limit: 20 });
    expect(severitySelect().value).toBe('all');
  });
});

describe('AlertsPage — the URL follows the filter, and the filter the URL', () => {
  it('re-filters when a tile is pressed while the list is open', async () => {
    const probe = renderAt('/alerts?priority=p1');
    await waitFor(() => expect(lastVariables()).toMatchObject({ severities: ['CRITICAL'] }));

    act(() => probe.navigate('/alerts?priority=p2'));
    await waitFor(() =>
      expect(lastVariables()).toEqual({
        page: 1,
        limit: 20,
        severities: ['HIGH'],
        resolved: false,
      }),
    );
    expect((await findSelect()).value).toBe('HIGH');

    // The pressed tile pressed again clears the filter: the shell drops the parameter.
    act(() => probe.navigate('/alerts'));
    await waitFor(() => expect(lastVariables()).toEqual({ page: 1, limit: 20 }));
    expect((await findSelect()).value).toBe('all');
  });

  it('writes the tile of a filter picked by hand, and drops it for a filter no tile shows', async () => {
    const probe = renderAt('/alerts');
    await waitFor(() => expect(transport.graphqlFetch).toHaveBeenCalled());

    // High over every status holds cleared alarms too, which no tile counts.
    fireEvent.change(await findSelect(), { target: { value: 'HIGH' } });
    await waitFor(() =>
      expect(lastVariables()).toEqual({ page: 1, limit: 20, severities: ['HIGH'] }),
    );
    expect(probe.search()).toBe('');

    fireEvent.click(await waitFor(() => statusTab('Open')));
    await waitFor(() => expect(probe.search()).toBe('?priority=p2'));
    await waitFor(() =>
      expect(lastVariables()).toEqual({
        page: 1,
        limit: 20,
        severities: ['HIGH'],
        resolved: false,
      }),
    );

    fireEvent.change(await findSelect(), { target: { value: 'LOW' } });
    await waitFor(() => expect(probe.search()).toBe(''));
    await waitFor(() =>
      expect(lastVariables()).toEqual({ page: 1, limit: 20, severities: ['LOW'], resolved: false }),
    );
    // The hand-picked filter survives its own URL write.
    expect((await findSelect()).value).toBe('LOW');

    fireEvent.change(await findSelect(), { target: { value: 'alarms' } });
    fireEvent.click(await waitFor(() => statusTab('Aktif')));
    await waitFor(() => expect(probe.search()).toBe('?priority=unack'));
    await waitFor(() =>
      expect(lastVariables()).toMatchObject({ acknowledged: false, resolved: false }),
    );
  });

  it('asks alert-engine for the cleared alarms on the resolved tab', async () => {
    renderAt('/alerts');
    await waitFor(() => expect(transport.graphqlFetch).toHaveBeenCalled());

    fireEvent.click(await waitFor(() => statusTab('Çözüldü')));
    await waitFor(() => expect(lastVariables()).toEqual({ page: 1, limit: 20, resolved: true }));
  });

  it('keeps a hand-picked tab when it leaves the tile it landed on', async () => {
    const probe = renderAt('/alerts?priority=p3');
    await waitFor(() => expect(severitySelect().value).toBe('p3'));

    fireEvent.click(statusTab('Onaylandı'));
    await waitFor(() => expect(probe.search()).toBe(''));
    await waitFor(() =>
      expect(lastVariables()).toMatchObject({ acknowledged: true, resolved: false }),
    );
    expect((await findSelect()).value).toBe('p3');
    expect(statusTab('Onaylandı').getAttribute('aria-pressed')).toBe('true');
  });
});
