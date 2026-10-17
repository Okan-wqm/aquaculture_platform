/**
 * FacilityStructureTab — the tree's single tab stop survives a refetch.
 *
 * The roving tab stop follows the last focused row; when that row stops being
 * drawn (deleted elsewhere, or its container's equipment is reloading) the tab
 * stop must move to a row that is on screen, or Tab would skip the tree.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { renderStructure } from './renderStructure';
import { resetState, state } from './structureFixtures';

vi.mock('@aquaculture/shared-ui', async () => {
  const { createSharedUiMock } = await import('../../../../test-utils/sharedUiMock');
  const fixtures = await import('./structureFixtures');
  return { ...(await createSharedUiMock()), useCanMutate: () => fixtures.state.canRead };
});
vi.mock('../../../../hooks/useSites', async () => (await import('./structureFixtures')).sitesHooks);
vi.mock(
  '../../../../hooks/useDepartments',
  async () => (await import('./structureFixtures')).departmentsHooks,
);
vi.mock(
  '../../../../hooks/useSystems',
  async () => (await import('./structureFixtures')).systemsHooks,
);
vi.mock(
  '../../../../hooks/useEquipment',
  async () => (await import('./structureFixtures')).equipmentHooks,
);
vi.mock(
  '../../../../hooks/useProcessFlows',
  async () => (await import('./structureFixtures')).processFlowsHooks,
);

beforeEach(() => {
  resetState();
});

function tabStops(): HTMLElement[] {
  return within(screen.getByRole('tree'))
    .getAllByRole('treeitem')
    .filter((row) => row.tabIndex === 0);
}

describe('FacilityStructureTab — roving tab stop', () => {
  it('moves the tab stop to the selected row when the focused system is deleted', async () => {
    const user = userEvent.setup();
    const view = renderStructure();
    await user.click(screen.getByRole('treeitem', { name: /A-BUY/ }));
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('treeitem', { name: /RAS-1/ })).toHaveFocus();

    state.hasSystem = false;
    act(() => view.refetch());

    expect(screen.queryByRole('treeitem', { name: /RAS-1/ })).not.toBeInTheDocument();
    const stops = tabStops();
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveAccessibleName(/A-BUY/);
  });

  it('moves the tab stop off an equipment row while its container reloads', async () => {
    const user = userEvent.setup();
    const view = renderStructure();
    await user.click(screen.getByRole('treeitem', { name: /A-BUY/ }));
    await user.click(screen.getByRole('treeitem', { name: /RAS-1/ }));
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('treeitem', { name: /P-101/ })).toHaveFocus();

    state.equipmentLoading = true;
    act(() => view.refetch());

    expect(screen.queryByRole('treeitem', { name: /P-101/ })).not.toBeInTheDocument();
    const stops = tabStops();
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveAccessibleName(/RAS-1/);
  });
});
