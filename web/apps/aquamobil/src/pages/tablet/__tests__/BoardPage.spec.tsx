/**
 * The board grid is a skeleton the pane agents fill, so what is worth pinning is
 * the contract between them: three labelled regions plus the full-width drives
 * strip beneath them, a selection that lives in the URL (so choosing a unit fills
 * the right column instead of navigating away from the board), and the footer
 * line that tells a worker why this screen has no log or command buttons on it.
 */
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { type ReactElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoardPage } from '../BoardPage';

// The attention column has its own tests and would drag three data hooks into
// this file; the grid's side of the contract is only that it hands the pane a
// callback which selects a unit. The stub stands in for an alarm row.
vi.mock('@/pages/tablet/panes/AttentionPane', () => ({
  AttentionPane: ({ onSelectUnit }: { onSelectUnit?: (unitId: string) => void }): ReactElement => (
    <button type="button" onClick={() => onSelectUnit?.('tank-7')}>
      alarm on tank-7
    </button>
  ),
}));

// Same reasoning for the other two columns. The unit grid and the inspector
// reach the selection through useSelectedUnit() themselves rather than through
// props, so BoardPage's side of THAT contract is only that each pane is mounted
// in the right region — what the panes then do with the URL is pinned in
// src/pages/tablet/panes/__tests__/.
vi.mock('@/pages/tablet/panes/UnitGridPane', () => ({
  UnitGridPane: (): ReactElement => <span data-testid="unit-grid-pane" />,
}));
vi.mock('@/pages/tablet/panes/UnitInspectorPane', () => ({
  UnitInspectorPane: (): ReactElement => <span data-testid="unit-inspector-pane" />,
}));
// The drives strip owns two queries of its own and is pinned in
// src/pages/tablet/panes/__tests__/DrivesPane.spec.tsx. BoardPage's side of the
// contract is only that the strip is mounted at all — which is exactly what was
// lost once before, when a header rewrite silently retired two features.
vi.mock('@/pages/tablet/panes/DrivesPane', () => ({
  DrivesPane: (): ReactElement => <span data-testid="drives-pane" />,
}));

const FOOTER =
  'Tap a unit to inspect it. Log entries and drive commands happen on the handheld, standing at the machine — this board is for watching and planning.';

/** Where the router thinks we are — the proof that selecting is not navigating. */
function LocationProbe(): ReactElement {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function renderBoard(path = '/board'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <BoardPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('BoardPage', () => {
  it('lays out three labelled regions', () => {
    renderBoard();

    for (const label of ['Alarms and tasks', 'Units', 'Selected unit']) {
      expect(screen.getByRole('region', { name: label }), `${label} region missing`).toBeTruthy();
    }
  });

  it('carries the design footer line', () => {
    renderBoard();
    expect(screen.getByText(FOOTER)).toBeTruthy();
  });

  it('mounts each pane in its own region', () => {
    renderBoard();

    const units = screen.getByRole('region', { name: 'Units' });
    expect(within(units).getByTestId('unit-grid-pane')).toBeTruthy();

    const selected = screen.getByRole('region', { name: 'Selected unit' });
    expect(within(selected).getByTestId('unit-inspector-pane')).toBeTruthy();
  });

  it('mounts the drives strip beneath the columns', () => {
    // The design's feeders row. It is asserted here rather than assumed because
    // a strip that quietly stops rendering looks exactly like a site with no
    // drives — and this board is on a wall so somebody notices machinery.
    renderBoard();
    expect(screen.getByTestId('drives-pane')).toBeTruthy();
  });

  it('lets the attention pane select a unit without leaving the board', () => {
    // An alarm names a unit; the board — not the pane — turns that into the
    // selection, and the route stays put so the columns beside it survive.
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'alarm on tank-7' }));

    expect(screen.getByTestId('location').textContent).toBe('/board?unit=tank-7');
  });

  it('keeps a deep-linked selection on the board route', () => {
    // A cabin display that reloads — a service-worker update, a power blip —
    // comes back to the same unit rather than to an empty right column, and
    // does so without a redirect.
    renderBoard('/board?unit=tank-7');

    expect(screen.getByTestId('location').textContent).toBe('/board?unit=tank-7');
  });
});
