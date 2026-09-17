/**
 * AppShell is the app's only viewport branch, so the cases that matter are the
 * ones a wall tablet actually produces: it is rotated, and a phone is sometimes
 * turned on its side. Both must land on the right shell WITHOUT a reload, and
 * neither may strand the app on a route its shell cannot draw.
 *
 * The two layouts are mocked: what is under test is the choice, not the chrome.
 */
import { render, screen, act, cleanup } from '@testing-library/react';
import { type ReactElement, type ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '../AppShell';

vi.mock('../MobileLayout', () => ({
  MobileLayout: ({ children }: { children: ReactNode }): ReactElement => (
    <div data-testid="handheld-shell">{children}</div>
  ),
}));

vi.mock('../TabletLayout', () => ({
  BOARD_PATH: '/board',
  TabletLayout: ({ children }: { children: ReactNode }): ReactElement => (
    <div data-testid="board-shell">{children}</div>
  ),
}));

/** A controllable stand-in for a viewport, since jsdom ships no matchMedia. */
const viewport = {
  matches: false,
  listeners: new Set<() => void>(),
};

function setViewportMatches(matches: boolean): void {
  act(() => {
    viewport.matches = matches;
    // A resize and a rotation both surface as one `change` event, which is why
    // the hook needs no separate orientation listener.
    for (const listener of viewport.listeners) listener();
  });
}

function PathProbe(): ReactElement {
  const { pathname } = useLocation();
  return <span data-testid="path">{pathname}</span>;
}

function renderShell(initialPath: string): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AppShell>
        <span data-testid="content">content</span>
      </AppShell>
      <PathProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  viewport.matches = false;
  viewport.listeners.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return viewport.matches;
    },
    addEventListener: (_type: string, listener: () => void) => viewport.listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) =>
      viewport.listeners.delete(listener),
  }));
});

afterEach(() => {
  // `globals: false` in vitest.config.ts means testing-library's automatic
  // cleanup hook is never registered — without this every render stacks in the
  // same document and getByTestId finds two shells.
  cleanup();
  vi.unstubAllGlobals();
});

describe('AppShell — the one viewport switch', () => {
  it('gives a phone the handheld shell', () => {
    renderShell('/units');
    expect(screen.getByTestId('handheld-shell')).toBeDefined();
    expect(screen.queryByTestId('board-shell')).toBeNull();
    expect(screen.getByTestId('content')).toBeDefined();
  });

  it('gives a board-sized viewport the board shell', () => {
    viewport.matches = true;
    renderShell('/units');
    expect(screen.getByTestId('board-shell')).toBeDefined();
    expect(screen.queryByTestId('handheld-shell')).toBeNull();
  });

  it('swaps shells on a live rotation, without a remount of the tree above it', () => {
    renderShell('/units');
    expect(screen.getByTestId('handheld-shell')).toBeDefined();

    // The wall tablet is turned.
    setViewportMatches(true);
    expect(screen.getByTestId('board-shell')).toBeDefined();
    expect(screen.queryByTestId('handheld-shell')).toBeNull();

    // …and turned back.
    setViewportMatches(false);
    expect(screen.getByTestId('handheld-shell')).toBeDefined();
  });

  it('opens the board when a board-sized viewport lands on the app root', () => {
    viewport.matches = true;
    renderShell('/');
    expect(screen.getByTestId('path').textContent).toBe('/board');
  });

  it('sends a phone off the board route instead of drawing three columns on it', () => {
    renderShell('/board');
    expect(screen.getByTestId('path').textContent).toBe('/');
  });

  it('moves the route with the viewport when a tablet on the board is rotated to portrait', () => {
    viewport.matches = true;
    renderShell('/');
    expect(screen.getByTestId('path').textContent).toBe('/board');

    // Portrait: below the threshold the board cannot render, so the route
    // follows the shell back to Today rather than leaving a dead screen.
    setViewportMatches(false);
    expect(screen.getByTestId('path').textContent).toBe('/');
    expect(screen.getByTestId('handheld-shell')).toBeDefined();

    // Back to landscape — the round trip returns to the board.
    setViewportMatches(true);
    expect(screen.getByTestId('path').textContent).toBe('/board');
  });
});
