/**
 * TenantModules — each module card draws its record's icon.
 *
 * The cards took their icon from a page-local map of module code to emoji and
 * a 📦 for every other code, a second owner of what the module record's own
 * lucide icon name (`auth.modules.icon`) already says. A card now draws the
 * icon its record names, through the console icon vocabulary, and the neutral
 * glyph while the record is unknown — never an emoji and never the name as
 * text.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    ...actual,
    useAuthContext: () => ({
      modules: [
        { code: 'hr', name: 'Human Resources', defaultRoute: '/hr/dashboard' },
        { code: 'hydroponics', name: 'Hydroponics Management', defaultRoute: '/hydroponics' },
        { code: 'unlisted', name: 'Unlisted Module', defaultRoute: '/unlisted' },
      ],
      isLoading: false,
      refreshAuth: async (): Promise<void> => undefined,
    }),
  };
});

vi.mock('../../hooks/useTenantData', () => ({
  useModuleRefs: () => ({
    data: {
      hr: { id: 'm-hr', icon: 'users' },
      hydroponics: { id: 'm-hydroponics', icon: 'sprout' },
    },
    error: null,
  }),
  useModuleUsageStats: () => ({ data: {}, error: null }),
  useTenantUsers: () => ({
    data: [{ id: 'user-ada', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' }],
    isLoading: false,
  }),
  useAssignModuleManager: () => ({ mutateAsync: async (): Promise<void> => undefined }),
}));

// PKG-06: the card's manager comes from the primary-manager listing (the grant the token reads),
// never from tenant_modules.managerId.
vi.mock('../../hooks/useModuleAccess', () => ({
  useModulePrimaryManagers: () => ({
    data: [{ moduleCode: 'hr', userId: 'user-ada' }],
    error: null,
  }),
}));

import TenantModules from '../TenantModules';

/** The icon tile beside a module card's name. */
function iconTileOf(moduleName: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 3, name: moduleName });
  const tile = heading.parentElement?.previousElementSibling;
  if (!(tile instanceof HTMLElement)) {
    throw new Error(`no icon tile beside "${moduleName}"`);
  }
  return tile;
}

describe('TenantModules module cards', () => {
  it("draws each card's record icon as its lucide svg, with no emoji or name text", () => {
    render(
      <MemoryRouter>
        <TenantModules />
      </MemoryRouter>,
    );

    for (const [moduleName, icon] of [
      ['Human Resources', 'users'],
      ['Hydroponics Management', 'sprout'],
      ['Unlisted Module', 'package'],
    ] as const) {
      const tile = iconTileOf(moduleName);
      expect(tile.querySelector(`svg.lucide-${icon}`)).not.toBeNull();
      expect(tile).toHaveTextContent(/^$/);
    }
  });

  it("shows each owner module's designated manager, and Assign Manager only where it applies", () => {
    render(
      <MemoryRouter>
        <TenantModules />
      </MemoryRouter>,
    );

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@example.test')).toBeInTheDocument();
    // hr shows its manager; hydroponics, an owner module without one, offers Assign Manager; a
    // code the dictionary does not hold as an owner module has no manager to assign.
    expect(screen.getAllByRole('button', { name: /Assign Manager/ })).toHaveLength(1);
  });
});
