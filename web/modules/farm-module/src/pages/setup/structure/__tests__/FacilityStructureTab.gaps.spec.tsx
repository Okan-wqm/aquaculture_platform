/**
 * FacilityStructureTab — responsibility and setup gaps.
 *
 * A gap is raised only from an answer the platform actually holds for the
 * selected node: a department's stored manager (managerName / managerUserId)
 * is read, a still-loading read is never "not assigned", and a capped diagram
 * list cannot prove a node is drawn nowhere. Each gap chip selects its level.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

function gaps(): HTMLElement | null {
  return screen.queryByRole('group', { name: 'Setup gaps' });
}

describe('FacilityStructureTab — department manager', () => {
  it('shows the manager farm-service stores on the department and raises no gap for it', async () => {
    state.managerName = 'Ayse Demir';
    const user = userEvent.setup();
    renderStructure();
    await user.click(screen.getByRole('treeitem', { name: /A-BUY/ }));

    const responsibility = screen.getByRole('region', { name: 'Responsibility' });
    expect(within(responsibility).getByText('Ayse Demir')).toBeInTheDocument();
    expect(within(responsibility).queryByText('Not assigned')).not.toBeInTheDocument();
    const group = gaps();
    expect(group).not.toBeNull();
    expect(within(group as HTMLElement).queryByText('No responsible assigned')).toBeNull();
  });

  it('counts a manager user stored without a name as assigned, not as a gap', async () => {
    state.managerUserId = 'd4f5a6b7-0000-4000-8000-000000000001';
    const user = userEvent.setup();
    renderStructure();
    await user.click(screen.getByRole('treeitem', { name: /A-BUY/ }));

    const responsibility = screen.getByRole('region', { name: 'Responsibility' });
    expect(within(responsibility).getByText('Assigned (no name recorded)')).toBeInTheDocument();
    expect(within(responsibility).queryByText('Not assigned')).not.toBeInTheDocument();
    expect(screen.queryByText('No responsible assigned')).not.toBeInTheDocument();
  });
});

describe('FacilityStructureTab — site responsible while contacts load', () => {
  it('treats the previous site’s kept contacts as loading, never as this site’s responsible', () => {
    state.contactsPlaceholder = true;
    renderStructure();

    const responsibility = screen.getByRole('region', { name: 'Responsibility' });
    expect(within(responsibility).queryByText(/Mert Aydin/)).not.toBeInTheDocument();
    expect(within(responsibility).getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText('No responsible assigned')).not.toBeInTheDocument();
  });
});

describe('FacilityStructureTab — gap chips', () => {
  it('lists each unassigned level as a chip that selects it', async () => {
    state.primaryContact = false;
    const user = userEvent.setup();
    renderStructure();
    await user.click(screen.getByRole('treeitem', { name: /A-BUY/ }));
    expect(screen.getByRole('heading', { level: 2, name: 'Grow-out' })).toBeInTheDocument();

    const group = gaps() as HTMLElement;
    expect(within(group).getByRole('button', { name: 'A-BUY · Grow-out' })).toBeInTheDocument();
    await user.click(within(group).getByRole('button', { name: 'SITE-A · Ayvalik Grow-out' }));

    expect(screen.getByRole('heading', { level: 2, name: 'Ayvalik Grow-out' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /Ayvalik Grow-out/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

describe('FacilityStructureTab — linked flows gap', () => {
  it('does not call a node unlinked when the diagram list was capped at one page', async () => {
    state.flows = [
      { id: 'proc-2', name: 'Hatchery loop', status: 'DRAFT', equipmentIds: ['eq-x'] },
    ];
    state.flowsTotal = 150;
    const user = userEvent.setup();
    renderStructure();
    await user.click(screen.getByRole('treeitem', { name: /A-BUY/ }));
    await user.click(screen.getByRole('treeitem', { name: /RAS-1/ }));

    const flows = screen.getByRole('region', { name: 'Linked flows' });
    expect(within(flows).getByText(/only the first 1 of 150/)).toBeInTheDocument();
    expect(screen.queryByText('Not linked to a process diagram')).not.toBeInTheDocument();
  });

  it('calls a node unlinked when the complete list draws it nowhere', async () => {
    state.flows = [
      { id: 'proc-2', name: 'Hatchery loop', status: 'DRAFT', equipmentIds: ['eq-x'] },
    ];
    const user = userEvent.setup();
    renderStructure();
    await user.click(screen.getByRole('treeitem', { name: /A-BUY/ }));
    await user.click(screen.getByRole('treeitem', { name: /RAS-1/ }));

    expect(
      within(gaps() as HTMLElement).getByText('Not linked to a process diagram'),
    ).toBeInTheDocument();
  });
});
