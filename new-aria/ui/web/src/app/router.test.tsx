import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { getToken, setToken } from '../api/token-store.ts';
import { appRoutes } from './router.tsx';

// The shell reads two endpoints: /health for version and actions, /overview for
// the runtime profile shown in the sidebar health strip.
interface DeferredResponse {
  readonly promise: Promise<Response>;
  readonly resolve: (response: Response) => void;
}

function deferredResponse(): DeferredResponse {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function responseFor(url: string, kernelRead: boolean): Response {
  if (url === '/api/v1/me') return new Response(JSON.stringify({ principal: { id: 'user', displayName: 'User', role: kernelRead ? 'operator' : 'lawyer', cases: kernelRead ? '*' : ['preview-002'] }, permissions: { kernel_read: kernelRead } }), { status: 200 });
  if (url === '/api/v1/legal/cases') return new Response(JSON.stringify({ cases: [], total: 0 }), { status: 200 });
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
    if (!kernelRead) return new Response(JSON.stringify({ error: 'instance_operator_required' }), { status: 403 });
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
}

function stubFetch(kernelRead = true, requests: string[] = [], deferred: ReadonlyMap<string, DeferredResponse> = new Map()): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requests.push(url);
    const pending = deferred.get(url);
    return pending === undefined ? responseFor(url, kernelRead) : pending.promise;
  });
}

/** Keep the real login/client/header path; only the server response is controlled. */
function stubLoginFetch(candidate: string, kernelRead: boolean, requests: string[], validation: DeferredResponse): void {
  let candidatePending = true;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requests.push(url);
    if (url === '/api/v1/health') return responseFor(url, kernelRead);
    if (init === undefined || new Headers(init.headers).get('authorization') !== `Bearer ${candidate}`) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }
    if (url === '/api/v1/me' && candidatePending) {
      candidatePending = false;
      return validation.promise;
    }
    return responseFor(url, kernelRead);
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

  it.each([['operator', true], ['scoped lawyer', false]] as const)('signs in a %s only after /me accepts the candidate credential', async (_role, kernelRead) => {
    const requests: string[] = [];
    const validation = deferredResponse();
    const candidate = 'login-fixture-candidate';
    stubLoginFetch(candidate, kernelRead, requests, validation);
    const router = createMemoryRouter(appRoutes, { initialEntries: ['/legal/cases'] });
    render(<RouterProvider router={router} />);
    fireEvent.change(await screen.findByLabelText('Operator token'), { target: { value: candidate } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(requests).toContain('/api/v1/me'));
    expect(getToken()).toBeNull();
    expect(router.state.location.pathname).toBe('/login');
    await act(async () => { validation.resolve(responseFor('/api/v1/me', kernelRead)); });

    await waitFor(() => expect(router.state.location.pathname).toBe('/legal/cases'));
    expect(getToken()).toBe(candidate);
    expect(screen.getByRole('link', { name: 'Cases' })).toBeDefined();
    if (!kernelRead) {
      expect(screen.queryByRole('heading', { name: 'Core' })).toBeNull();
      expect(requests).not.toContain('/api/v1/overview');
    }
  });

  it.each([401, 503])('keeps the candidate out of storage when /me answers %s', async (status) => {
    const requests: string[] = [];
    const validation = deferredResponse();
    const candidate = 'rejected-login-fixture';
    stubLoginFetch(candidate, false, requests, validation);
    const router = createMemoryRouter(appRoutes, { initialEntries: ['/legal/cases'] });
    render(<RouterProvider router={router} />);
    fireEvent.change(await screen.findByLabelText('Operator token'), { target: { value: candidate } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(requests).toContain('/api/v1/me'));
    await act(async () => {
      validation.resolve(new Response(JSON.stringify({ error: status === 401 ? 'unauthorized' : 'identity_unavailable' }), { status }));
    });

    expect(screen.getByRole('alert').textContent).toContain(String(status));
    expect(router.state.location.pathname).toBe('/login');
    expect(getToken()).toBeNull();
    expect(requests).not.toContain('/api/v1/legal/cases');
  });

  it.each(['/', '/governance', '/actions', '/beliefs'])('keeps legal principals on the legal surface from %s', async (path) => {
    const requests: string[] = [];
    stubFetch(false, requests);
    setToken('present');
    const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(router.state.location.pathname).toBe('/legal/cases'));
    expect(screen.queryByRole('link', { name: 'Governance' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Overview' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Cases' })).toBeDefined();
    expect(screen.queryByText('standard')).toBeNull();
    expect(requests.filter((url) => !['/api/v1/me', '/api/v1/health', '/api/v1/legal/cases'].includes(url))).toEqual([]);
  });

  it('renders the protected shell and marks the current route in the sidebar', async () => {
    setToken('present');
    const router = createMemoryRouter(appRoutes, { initialEntries: ['/cycles'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Cycles' })).toBeDefined());
    expect(router.state.location.pathname).toBe('/cycles');
    expect(screen.getByRole('link', { name: 'Cycles' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows the runtime profile and actions state in the shell health strip', async () => {
    const requests: string[] = [];
    const health = deferredResponse();
    const me = deferredResponse();
    const overview = deferredResponse();
    stubFetch(true, requests, new Map([
      ['/api/v1/health', health],
      ['/api/v1/me', me],
      ['/api/v1/overview', overview],
    ]));
    setToken('present');
    const router = createMemoryRouter(appRoutes, { initialEntries: ['/cycles'] });
    render(<RouterProvider router={router} />);

    expect(requests).not.toContain('/api/v1/overview');

    await act(async () => {
      health.resolve(responseFor('/api/v1/health', true));
      me.resolve(responseFor('/api/v1/me', true));
    });
    expect(requests).toContain('/api/v1/overview');
    await act(async () => {
      overview.resolve(responseFor('/api/v1/overview', true));
    });

    // The kernel's own word is rendered verbatim; only its colour is interpretation.
    expect(screen.getByText('standard')).toBeDefined();
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
