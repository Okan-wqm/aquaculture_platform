/**
 * The drive surface's routes must stay REACHABLE BY TAP.
 *
 * WHY A SPEC OF ITS OWN, next to the app-wide route-reachability invariant: that
 * gate lists literal paths, and `/drives/:vfdDeviceId` is never written as a
 * literal — every entry point builds it as a template from a drive id. A textual
 * check for the parameterised path would pass vacuously forever, which is worse
 * than no check. So this file names the two components that ARE the drive
 * detail's only doors and asserts each still builds the link.
 *
 * The lesson behind both gates is the same and it cost this app two features:
 * rewriting HomePage for v4 deleted the header the bells lived in, and `/alerts`
 * and `/notifications` kept their routes, their guards and their pages while
 * becoming unreachable. Nothing failed. A drive screen nobody can open is a
 * drive nobody can stop.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { render, screen, cleanup } from '@testing-library/react';
import { type ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UnitsPage } from '@/pages/units/UnitsPage';

const SRC_DIR = resolve(__dirname, '../../..');

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === 'generated') continue;
      walkSources(full, out);
    } else if (/\.(tsx|ts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Every source file except the router, which is where routes are DEFINED. */
const ALL_SOURCE = walkSources(SRC_DIR)
  .filter((file) => !file.endsWith('/App.tsx'))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

const mockUseTanks = vi.fn();
vi.mock('@/hooks/useTanks', () => ({ useTanks: (): unknown => mockUseTanks() }));

// The shared header carries the account avatar, which reads the auth context.
// Standing it in keeps this file about REACHABILITY rather than about auth
// plumbing — the header has its own tests.
vi.mock('@/components/AppHeader', () => ({
  AppHeader: ({ title }: { title: string }): ReactElement => <h1>{title}</h1>,
}));

afterEach(() => {
  cleanup();
  mockUseTanks.mockReset();
});

describe('drive route reachability', () => {
  it('registers both drive routes in the router', () => {
    const app = readFileSync(join(SRC_DIR, 'App.tsx'), 'utf8');
    expect(app).toContain('path="/drives"');
    expect(app).toContain('path="/drives/:vfdDeviceId"');
  });

  it('builds the drive-detail link from the two components that are its only doors', () => {
    // Named explicitly because the path is a template, so a textual search for
    // the route pattern would never notice its last entry point being removed.
    for (const owner of ['components/drive/UnitDrivesCard.tsx', 'pages/drives/DrivesPage.tsx']) {
      const source = readFileSync(join(SRC_DIR, owner), 'utf8');
      expect(
        /\/drives\/\$\{/.test(source),
        `${owner} no longer navigates to a drive. If that is intended, delete the route and the ` +
          'page too — a drive screen nobody can open is a drive nobody can stop.',
      ).toBe(true);
    }
  });

  it('keeps the drive index reachable from somewhere outside the router', () => {
    expect(/\/drives(?:["'`/?]|\$\{)/.test(ALL_SOURCE)).toBe(true);
  });

  it('renders the Units entry point even while the unit list is failing', () => {
    // The drives are a separate query against a separate service, so a
    // farm-inventory outage must not also hide the way to the machinery.
    mockUseTanks.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Network request failed'),
      refetch: vi.fn(),
    });

    render(
      <MemoryRouter>
        <UnitsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Drives')).toBeDefined();
    expect(screen.getByText(/Feeders, pumps and blowers/)).toBeDefined();
    // …and the unit list still says it could not load, rather than "no units".
    expect(screen.getByText('Could not load units')).toBeDefined();
  });

  it('mounts the drives strip on the tablet board', () => {
    // The board's own entry point for the drive surface. BoardPage composes it;
    // if this stops being true the design's feeders row is silently gone again.
    const board = readFileSync(join(SRC_DIR, 'pages/tablet/BoardPage.tsx'), 'utf8');
    expect(board).toContain('<DrivesPane />');
  });
});
