// MOB-LOW-001 — unknown routes must surface a 404 page, not silently bounce home.
//
// The old catch-all (`<Route path="*" element={<Navigate to="/" replace />} />`)
// swallowed every broken deep link: a typo'd bookmark or a removed route landed
// on the dashboard with no signal that anything was wrong. BUG-16 (the
// /culling/* compat redirects) exists precisely because that silence hid a real
// broken path. The catch-all now renders NotFoundPage: the user sees what
// happened, keeps a one-tap recovery to Home, and broken links become
// observable instead of masked.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, afterEach } from 'vitest';

import { NotFoundPage } from '../NotFoundPage';

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div>HOME-DASHBOARD</div>} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NotFoundPage (MOB-LOW-001)', () => {
  afterEach(cleanup);

  it('renders a 404 status for an unknown path instead of the dashboard', () => {
    renderAt('/no/such/route');

    expect(screen.queryByText('HOME-DASHBOARD')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
    // The broken path is shown so the user (and a screenshot in a bug report)
    // reveals WHICH link was broken.
    expect(screen.getByText('/no/such/route')).toBeTruthy();
  });

  it('recovers to Home via a single large CTA', () => {
    renderAt('/stale/bookmark');

    const cta = screen.getByRole('button', { name: 'Back to Home' });
    // Field ergonomics: the recovery CTA keeps the 44px touch-target floor.
    expect(cta.className).toContain('min-h-[44px]');

    fireEvent.click(cta);
    expect(screen.getByText('HOME-DASHBOARD')).toBeTruthy();
  });

  it('App.tsx catch-all routes to NotFoundPage, not a silent redirect home', () => {
    const appSource = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8');

    expect(appSource).toContain('<Route path="*" element={<NotFoundPage />} />');
    expect(appSource).not.toContain('<Route path="*" element={<Navigate to="/" replace />} />');
  });
});
