/**
 * FacilityStructureTab — the /sites/setup/structure page.
 *
 * The data hooks are mocked (London school): the page must render the tree the
 * site/department/system/equipment hooks describe, keep it keyboard-operable
 * (role=tree, aria-expanded, arrow keys), and show for the selected node the
 * chain, the subtree counts from the delete-preview reads, the responsible
 * person from the real fields, the process diagrams it is linked to, and the
 * setup gaps — never an invented value (no energy or cost figures exist).
 */
import { act, screen, waitFor, within } from '@testing-library/react';
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

describe('FacilityStructureTab — tree', () => {
  it('renders the location tree with the first site open and selected', () => {
    renderStructure();
    const tree = screen.getByRole('tree');
    const site = within(tree).getByRole('treeitem', { name: /Ayvalik Grow-out/ });
    expect(site).toHaveAttribute('aria-expanded', 'true');
    expect(site).toHaveAttribute('aria-selected', 'true');
    expect(site).toHaveAttribute('aria-level', '1');
    const department = within(tree).getByRole('treeitem', { name: /A-BUY/ });
    expect(department).toHaveAttribute('aria-expanded', 'false');
    expect(department).toHaveAttribute('aria-level', '2');
    expect(screen.getByRole('heading', { level: 2, name: 'Ayvalik Grow-out' })).toBeInTheDocument();
  });

  it('is operable with the arrow keys: move, open, enter, close, back to parent', async () => {
    const user = userEvent.setup();
    renderStructure();
    const tree = screen.getByRole('tree');
    const site = within(tree).getByRole('treeitem', { name: /Ayvalik Grow-out/ });
    act(() => site.focus());

    await user.keyboard('{ArrowDown}');
    const department = within(tree).getByRole('treeitem', { name: /A-BUY/ });
    expect(department).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(department).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{ArrowRight}');
    const system = within(tree).getByRole('treeitem', { name: /RAS-1/ });
    expect(system).toHaveFocus();
    expect(system).toHaveAttribute('aria-level', '3');

    await user.keyboard('{ArrowRight}{ArrowRight}');
    const pump = within(tree).getByRole('treeitem', { name: /P-101/ });
    expect(pump).toHaveFocus();
    expect(pump).not.toHaveAttribute('aria-expanded');

    await user.keyboard('{ArrowLeft}');
    expect(system).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(system).toHaveAttribute('aria-expanded', 'false');
    expect(within(tree).queryByRole('treeitem', { name: /P-101/ })).not.toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(system).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 2, name: 'Grow-out line 1' })).toBeInTheDocument();
  });
});

describe('FacilityStructureTab — node panel', () => {
  it('shows the site’s subtree counts and its primary contact as responsible', () => {
    renderStructure();
    const counts = screen.getByRole('region', { name: 'Items below' });
    expect(within(counts).getByText('Departments').nextElementSibling).toHaveTextContent('1');
    expect(within(counts).getByText('Systems').nextElementSibling).toHaveTextContent('2');
    expect(within(counts).getByText('Equipment').nextElementSibling).toHaveTextContent('3');
    expect(within(counts).getByText('Tanks').nextElementSibling).toHaveTextContent('2');
    expect(within(counts).getByText('1 with live stock')).toBeInTheDocument();
    const responsibility = screen.getByRole('region', { name: 'Responsibility' });
    expect(within(responsibility).getByText('Deniz Kaya · Site manager')).toBeInTheDocument();
    expect(screen.queryByText(/kW|kWh|MWh|₺/)).not.toBeInTheDocument();
  });

  it('flags a department without a responsible and without a linked flow', async () => {
    const user = userEvent.setup();
    renderStructure();
    await user.click(screen.getByRole('treeitem', { name: /A-BUY/ }));

    const path = screen.getByRole('navigation', { name: 'Path' });
    expect(within(path).getByRole('button', { name: 'SITE-A' })).toBeInTheDocument();
    const gaps = screen.getByRole('group', { name: 'Setup gaps' });
    expect(within(gaps).getByText('No responsible assigned')).toBeInTheDocument();
    expect(within(gaps).getByRole('button', { name: 'A-BUY · Grow-out' })).toBeInTheDocument();
    expect(within(gaps).getByText('Not linked to a process diagram')).toBeInTheDocument();
    expect(state.flowScopes).toContainEqual({ departmentId: 'dep-a' });
  });

  it('lists the process diagrams that draw a system’s equipment, linking to the editor', async () => {
    state.flows = [
      { id: 'proc-1', name: 'RAS-1 water loop', status: 'ACTIVE', equipmentIds: ['eq-pump'] },
      { id: 'proc-2', name: 'Hatchery loop', status: 'DRAFT', equipmentIds: ['eq-other'] },
    ];
    const user = userEvent.setup();
    renderStructure();
    await user.click(screen.getByRole('treeitem', { name: /A-BUY/ }));
    await user.click(screen.getByRole('treeitem', { name: /RAS-1/ }));

    const flows = screen.getByRole('region', { name: 'Linked flows' });
    const link = within(flows).getByRole('link', { name: /RAS-1 water loop/ });
    expect(link).toHaveAttribute('href', '/sensor/unified-editor/proc-1');
    expect(within(flows).queryByText('Hatchery loop')).not.toBeInTheDocument();
    expect(within(flows).getByRole('link', { name: /All process diagrams/ })).toHaveAttribute(
      'href',
      '/sensor/processes',
    );
    expect(screen.queryByText('Not linked to a process diagram')).not.toBeInTheDocument();
  });

  it('selects an ancestor from the path and keeps counts hidden from roles that cannot read them', async () => {
    state.canRead = false;
    state.primaryContact = false;
    const user = userEvent.setup();
    renderStructure();
    await user.click(screen.getByRole('treeitem', { name: /A-BUY/ }));
    await user.click(
      within(screen.getByRole('navigation', { name: 'Path' })).getByRole('button', {
        name: 'SITE-A',
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 2, name: 'Ayvalik Grow-out' }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText('Counts below this item are visible to tenant admins and module managers.'),
    ).toBeInTheDocument();
    const gaps = screen.getByRole('group', { name: 'Setup gaps' });
    expect(
      within(gaps).getByRole('button', { name: 'SITE-A · Ayvalik Grow-out' }),
    ).toBeInTheDocument();
  });
});
