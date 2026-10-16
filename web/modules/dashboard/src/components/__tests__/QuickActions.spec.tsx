/**
 * QuickActions — Industry console fit (README §6, §7.7, §7.8).
 *
 * The shortcut tiles used to be filled circles, each in its own hue — one of
 * them the `accent-*` scale, the design system's High alarm tier, which the
 * console scope paints amber, so a shortcut read as an alarm (README §7.8
 * keeps amber for alarm and risk). In Industry a box is a square line drawing
 * and the workspace accent is the one brand colour: every tile draws the same
 * hairline square with a primary glyph.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useAuthContext: () => ({ user: { role: 'TENANT_ADMIN' } }),
}));

import QuickActions from '../QuickActions';

function renderActions(): HTMLElement[] {
  render(
    <MemoryRouter>
      <QuickActions />
    </MemoryRouter>,
  );
  return screen.getAllByTestId('quick-action-icon');
}

describe('QuickActions — Industry tiles', () => {
  it('renders one icon tile per visible action', () => {
    expect(renderActions()).toHaveLength(6);
  });

  it('draws every icon tile square, in the workspace accent, never the alarm accent', () => {
    for (const tile of renderActions()) {
      expect(tile).not.toHaveClass('rounded-full');
      expect(tile.className).not.toMatch(/\baccent-\d/);
      expect(tile).toHaveClass('text-primary-700');
    }
  });
});
