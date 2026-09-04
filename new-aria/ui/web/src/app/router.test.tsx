import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { setToken } from '../api/token-store.ts';
import { appRoutes } from './router.tsx';

// The shell reads two endpoints: /health for version and actions, /overview for
// the runtime profile shown in the sidebar health strip.
function stubFetch(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === '/api/v1/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'new-aria-ui',
          version: '0.1.0',
          toolsDirPresent: true,
          actionsEnabled: false,
          generatedAt: '2026-09-03T00:00:00Z',
        }),
        { status: 200 },
      );
    }
    if (url === '/api/v1/overview') {
      return new Response(
        JSON.stringify({
          generatedAt: '2026-09-03T00:00:00Z',
          toolsDir: '/srv/aria/tools',
          workspaceRoot: null,
          profile: { current: 'standard', schedulerCeiling: null, setBy: null, setAt: null },
          killSwitch: { engaged: false },
          breakers: [],
          budget: { tripped: false, detail: null },
          lastCycle: null,
          counts: {
            cycles: 0,
            rawFindings: 0,
            beliefs: 0,
            pressures: 0,
            humanRequiredOpen: 0,
            agentRequests: 0,
            governanceRows: 0,
          },
          gateway: null,
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  });
}

describe('router auth guard', () => {
  beforeEach(() => {
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirects to the sign-in screen when no token is stored', async () => {
    const router = createMemoryRouter(appRoutes, { initialEntries: ['/cycles'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(screen.getByRole('heading', { level: 1, name: 'Operator console' })).toBeDefined();
    expect(screen.getByLabelText('Operator token')).toBeDefined();
    const state: unknown = router.state.location.state;
    expect(state).toEqual({ from: '/cycles' });
  });

  it('renders the protected shell and marks the current route in the sidebar', async () => {
    setToken('present');
    const router = createMemoryRouter(appRoutes, { initialEntries: ['/cycles'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeDefined());
    expect(router.state.location.pathname).toBe('/cycles');
    expect(screen.getByRole('link', { name: 'Cycles' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows the runtime profile and actions state in the shell health strip', async () => {
    setToken('present');
    const router = createMemoryRouter(appRoutes, { initialEntries: ['/cycles'] });
    render(<RouterProvider router={router} />);
    // The kernel's own word is rendered verbatim; only its colour is interpretation.
    await waitFor(() => expect(screen.getByText('standard')).toBeDefined());
    expect(screen.getByText('disabled')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
  });

  it('sends an already-authenticated operator away from the sign-in screen', async () => {
    setToken('present');
    const router = createMemoryRouter(appRoutes, { initialEntries: ['/login'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});
