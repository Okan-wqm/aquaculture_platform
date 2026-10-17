/**
 * TenantDashboard — the module-status list draws each module's icon.
 *
 * A module record carries its icon as a lucide name (`auth.modules.icon`:
 * "fish", "users", "sprout"). The list guessed a module code from its display
 * name, mapped three guessed codes to emoji and printed every other record's
 * icon name as text, so production /tenant showed "users" beside Human
 * Resources and "sprout" beside Hydroponics Management. Every row now draws
 * its record's icon through the console icon vocabulary, with a neutral glyph
 * for a name outside it.
 */
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { MyModule } from '../../lib/types';

const { moduleRecords } = vi.hoisted(() => {
  const record = (code: string, name: string, icon: string | null): MyModule => ({
    id: `tm-${code}`,
    moduleId: `m-${code}`,
    code,
    name,
    icon,
    isEnabled: true,
  });
  return {
    moduleRecords: [
      record('farm', 'Fish Farm Management', 'fish'),
      record('hr', 'Human Resources', 'users'),
      record('hydroponics', 'Hydroponics Management', 'sprout'),
      record('custom', 'Custom Module', 'not-an-icon'),
      record('bare', 'Bare Module', null),
    ],
  };
});

vi.mock('../../lib/api', () => ({
  getMyModules: async (): Promise<MyModule[]> => moduleRecords,
  getTenantUsers: async (): Promise<never[]> => [],
  getMySubscription: async (): Promise<null> => null,
}));

vi.mock('../../hooks/useTenantData', () => ({
  useTenantStats: () => ({ data: undefined }),
}));

import TenantDashboard from '../TenantDashboard';

function renderDashboard(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TenantDashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The icon tile beside a module row's name. */
async function iconTileOf(moduleName: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 3, name: moduleName });
  const tile = heading.parentElement?.previousElementSibling;
  if (!(tile instanceof HTMLElement)) {
    throw new Error(`no icon tile beside "${moduleName}"`);
  }
  return tile;
}

describe('TenantDashboard module status', () => {
  it('draws a known icon name as its lucide svg, not as text', async () => {
    renderDashboard();

    for (const [moduleName, icon] of [
      ['Human Resources', 'users'],
      ['Hydroponics Management', 'sprout'],
      ['Fish Farm Management', 'fish'],
    ] as const) {
      const tile = await iconTileOf(moduleName);
      expect(tile.querySelector(`svg.lucide-${icon}`)).not.toBeNull();
      expect(tile).toHaveTextContent(/^$/);
    }
    expect(screen.queryByText('users')).not.toBeInTheDocument();
    expect(screen.queryByText('sprout')).not.toBeInTheDocument();
  });

  it('draws the neutral glyph for an unknown icon name or a record with none', async () => {
    renderDashboard();

    for (const moduleName of ['Custom Module', 'Bare Module']) {
      const tile = await iconTileOf(moduleName);
      expect(tile.querySelector('svg.lucide-package')).not.toBeNull();
      expect(tile).toHaveTextContent(/^$/);
    }
    expect(screen.queryByText('not-an-icon')).not.toBeInTheDocument();
  });
});
