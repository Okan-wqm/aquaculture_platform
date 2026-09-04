import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { setToken } from '../api/token-store.ts';
import { appRoutes } from './router.tsx';

function stubFetch(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === '/api/v1/health') {
      return new Response(
        JSON.stringify({ status: 'ok', service: 'new-aria-ui', version: '0.1.0', toolsDirPresent: true, actionsEnabled: false, generatedAt: '2026-09-03T00:00:00Z' }),
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

  it('redirects to /login when no token is stored', async () => {
    const router = createMemoryRouter(appRoutes, { initialEntries: ['/cycles'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(screen.getByRole('heading', { level: 1, name: 'ARIA Operatör Konsolu' })).toBeDefined();
    expect(screen.getByLabelText('Operatör tokenı')).toBeDefined();
    const state: unknown = router.state.location.state;
    expect(state).toEqual({ from: '/cycles' });
  });

  it('renders the protected layout when a token is present', async () => {
    setToken('present');
    const router = createMemoryRouter(appRoutes, { initialEntries: ['/cycles'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Ana gezinme' })).toBeDefined());
    expect(router.state.location.pathname).toBe('/cycles');
    expect(screen.getByRole('heading', { level: 1, name: 'Döngüler' })).toBeDefined();
  });

  it('sends an already-authenticated operator away from /login', async () => {
    setToken('present');
    const router = createMemoryRouter(appRoutes, { initialEntries: ['/login'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});
