import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const authHarness = vi.hoisted(() => ({
  isAuthenticated: false,
  isLoading: false,
  user: null as null | { id: string },
  lifecycle: 'EMPTY' as 'EMPTY' | 'READY',
  accessToken: null as string | null,
}));

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    ...actual,
    getAccessToken: (): string | null => authHarness.accessToken,
    tokenLifecycle: {
      ...actual.tokenLifecycle,
      getState: (): 'EMPTY' | 'READY' => authHarness.lifecycle,
    },
    useAuthContext: () => ({
      isAuthenticated: authHarness.isAuthenticated,
      isLoading: authHarness.isLoading,
      user: authHarness.user,
    }),
  };
});

import AuthLayout from '../AuthLayout';

const renderLayout = (): ReturnType<typeof render> =>
  render(
    <MemoryRouter
      initialEntries={['/login']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route element={<AuthLayout />}>
          <Route path="/login" element={<div>Real auth route</div>} />
        </Route>
        <Route path="/" element={<div>Authenticated application</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe('AuthLayout', () => {
  beforeEach(() => {
    authHarness.isAuthenticated = false;
    authHarness.isLoading = false;
    authHarness.user = null;
    authHarness.lifecycle = 'EMPTY';
    authHarness.accessToken = null;
  });

  it('shows an announced loading state while the real auth context restores', () => {
    authHarness.isLoading = true;
    renderLayout();

    expect(screen.getByRole('status', { name: 'Loading authentication' })).toBeTruthy();
    expect(screen.queryByText('Real auth route')).toBeNull();
  });

  it('renders the industrial chrome around the real unauthenticated route', () => {
    renderLayout();

    expect(screen.getByRole('region', { name: 'Suderra authentication' })).toBeTruthy();
    expect(screen.getByText('Real auth route')).toBeTruthy();
    expect(screen.getAllByText('Authorized access only')).toHaveLength(1);
  });

  it('redirects only when React auth state, lifecycle, user, and token all agree', async () => {
    authHarness.isAuthenticated = true;
    authHarness.user = { id: 'user-1' };
    authHarness.lifecycle = 'READY';
    authHarness.accessToken = 'access-token';
    renderLayout();

    expect(await screen.findByText('Authenticated application')).toBeTruthy();
    expect(screen.queryByText('Real auth route')).toBeNull();
  });

  it('keeps the auth route visible when an authenticated flag has no live token', () => {
    authHarness.isAuthenticated = true;
    authHarness.user = { id: 'user-1' };
    authHarness.lifecycle = 'READY';
    renderLayout();

    expect(screen.getByText('Real auth route')).toBeTruthy();
    expect(screen.queryByText('Authenticated application')).toBeNull();
  });
});
