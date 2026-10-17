/**
 * /sensor/commands admits module managers and up (CommandLogRoute).
 *
 * The drive trail and the deployment history the command log shows are served
 * only to TENANT_ADMIN / MODULE_MANAGER, so a module user is sent to
 * /unauthorized instead of a page whose records would all fail to load. The
 * real RequireRole runs; only the session it reads is controlled, and the
 * page itself is a stub (its reads are CommandLogPage.spec's subject).
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { CommandLogRoute } from '../CommandLogRoute';

const { session } = vi.hoisted(() => ({ session: { role: 'MODULE_USER' } }));

// The role order RequireRole's hasRoleOrHigher follows (AuthContext ROLE_HIERARCHY).
const RANK: Readonly<Record<string, number>> = {
  MODULE_USER: 0,
  MODULE_MANAGER: 1,
  TENANT_ADMIN: 2,
  SUPER_ADMIN: 3,
};

vi.mock('../../../../../../shared-ui/src/contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useAuthContext: () => ({
      user: { role: session.role },
      isAuthenticated: true,
      isLoading: false,
      isSuperAdmin: () => session.role === 'SUPER_ADMIN',
      hasRoleOrHigher: (role: string) => (RANK[session.role] ?? -1) >= (RANK[role] ?? 99),
      hasModuleAccess: () => true,
    }),
  };
});

vi.mock('../CommandLogPage', () => ({
  CommandLogPage: () => <h1>Command log</h1>,
}));

function renderAs(role: string): void {
  session.role = role;
  render(
    <MemoryRouter initialEntries={['/sensor/commands']}>
      <Routes>
        <Route path="/sensor/commands" element={<CommandLogRoute />} />
        <Route path="/unauthorized" element={<p>Unauthorized</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CommandLogRoute', () => {
  it('sends a module user to /unauthorized', () => {
    renderAs('MODULE_USER');
    expect(screen.getByText('Unauthorized')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Command log' })).toBeNull();
  });

  it.each(['MODULE_MANAGER', 'TENANT_ADMIN'])('serves the page to a %s', (role) => {
    renderAs(role);
    expect(screen.getByRole('heading', { name: 'Command log' })).toBeInTheDocument();
  });
});
