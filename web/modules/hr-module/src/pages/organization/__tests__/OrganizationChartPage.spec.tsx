/**
 * OrganizationChartPage — the chart a reader sees at /hr/organization.
 *
 * It states whose chart it is (the workspace scope), shows each department with
 * its code, module, head count and manager as a nested list, can be walked with
 * the keyboard alone, and never hides what is wrong: a failed load, a parent
 * outside the view, a parent loop, people who sit in no department.
 */
import { WorkforceScopeProvider } from '@aquaculture/shared-ui';
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrganizationChart } from '../../../hooks/useOrganizationChart';
import { buildOrgTree, type OrgDepartment } from '../buildOrgTree';
import OrganizationChartPage from '../OrganizationChartPage';

const mocks = vi.hoisted(() => ({ chart: vi.fn<() => OrganizationChart>() }));

vi.mock('../../../hooks/useOrganizationChart', () => ({ useOrganizationChart: mocks.chart }));

function department(id: string, overrides: Partial<OrgDepartment> = {}): OrgDepartment {
  return {
    id,
    name: id,
    code: id.toUpperCase(),
    moduleCode: 'FARM',
    isActive: true,
    sortOrder: 0,
    headCount: 0,
    managerName: null,
    ...overrides,
  };
}

function loaded(departments: OrgDepartment[], unplacedHeadCount = 0): OrganizationChart {
  return { tree: buildOrgTree(departments), unplacedHeadCount, isLoading: false, error: null };
}

function renderPage(scope: HrModuleCode | null = null): void {
  render(
    <MemoryRouter>
      <WorkforceScopeProvider moduleCode={scope}>
        <OrganizationChartPage />
      </WorkforceScopeProvider>
    </MemoryRouter>,
  );
}

/** The list item that holds one department's card. */
function nodeOf(name: string): HTMLElement {
  const item = screen.getByText(name).closest('li');
  if (!item) throw new Error(`no list item around ${name}`);
  return item;
}

describe('OrganizationChartPage', () => {
  beforeEach(() => {
    mocks.chart.mockReset();
  });

  it('tells the reader the chart is loading', () => {
    mocks.chart.mockReturnValue({
      tree: undefined,
      unplacedHeadCount: 0,
      isLoading: true,
      error: null,
    });
    renderPage();

    expect(screen.getByRole('status')).toHaveTextContent('Loading organization chart');
  });

  it('shows a failed load as an alert, with no chart', () => {
    mocks.chart.mockReturnValue({
      tree: undefined,
      unplacedHeadCount: 0,
      isLoading: false,
      error: new Error('departments unavailable'),
    });
    renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Failed to load the organization chart: departments unavailable',
    );
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('says there is nothing to draw when the view has no departments', () => {
    mocks.chart.mockReturnValue(loaded([]));
    renderPage('SENSOR');

    expect(screen.getByText('No departments in this view')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage departments' })).toHaveAttribute(
      'href',
      '/hr/departments',
    );
  });

  it('counts the departments in the header, in the singular for one', () => {
    mocks.chart.mockReturnValue(loaded([department('ops')]));
    renderPage();
    expect(screen.getByText('1 department')).toBeInTheDocument();
  });

  it('counts several departments in the plural', () => {
    mocks.chart.mockReturnValue(loaded([department('ops'), department('fin')]));
    renderPage();
    expect(screen.getByText('2 departments')).toBeInTheDocument();
  });

  it('states whose chart it is', () => {
    mocks.chart.mockReturnValue(loaded([department('ops')]));
    renderPage('FARM');

    expect(screen.getByTitle('Showing Production')).toBeInTheDocument();
  });

  it('shows each department with its code, module, head count and manager', () => {
    mocks.chart.mockReturnValue(
      loaded([
        department('ops', {
          name: 'Operations',
          code: 'OPS',
          managerId: 'boss',
          managerName: 'Ada Lovelace',
          headCount: 2,
        }),
        department('fin', { name: 'Finance', code: 'FIN', moduleCode: null, headCount: 1 }),
      ]),
    );
    renderPage();

    const operations = within(nodeOf('Operations'));
    expect(operations.getByText('OPS · Production')).toBeInTheDocument();
    expect(operations.getByText('2 people')).toBeInTheDocument();
    expect(operations.getByText('Manager: Ada Lovelace')).toBeInTheDocument();

    const finance = within(nodeOf('Finance'));
    expect(finance.getByText('FIN · Company-wide')).toBeInTheDocument();
    expect(finance.getByText('1 person')).toBeInTheDocument();
    expect(finance.getByText('No manager assigned')).toBeInTheDocument();
  });

  it('defines its head count once, so it is not mistaken for the active-employee counts elsewhere', () => {
    mocks.chart.mockReturnValue(loaded([department('ops', { headCount: 1 })]));
    renderPage();

    expect(
      screen.getByText(
        'Head counts include active, on-leave and suspended employees; terminated employees are not counted.',
      ),
    ).toBeInTheDocument();
  });

  it('says so when a manager is no longer on record', () => {
    mocks.chart.mockReturnValue(
      loaded([department('ops', { name: 'Operations', managerId: 'gone', managerName: null })]),
    );
    renderPage();

    expect(screen.getByText('Manager: no longer on record')).toBeInTheDocument();
  });

  it('links each department to its people', () => {
    mocks.chart.mockReturnValue(loaded([department('dept-ops', { name: 'Operations' })]));
    renderPage();

    expect(
      within(nodeOf('Operations')).getByRole('link', { name: 'View team of Operations' }),
    ).toHaveAttribute('href', '/hr/employees?departmentId=dept-ops');
  });

  it('nests sub-departments and counts them in the parent total', () => {
    mocks.chart.mockReturnValue(
      loaded([
        department('ops', { name: 'Operations', headCount: 1 }),
        department('feed', { name: 'Feeding', parentDepartmentId: 'ops', headCount: 2 }),
      ]),
    );
    renderPage();

    const operations = nodeOf('Operations');
    expect(within(operations).getByText('1 person · 3 with sub-departments')).toBeInTheDocument();
    expect(within(operations).getByText('Feeding')).toBeInTheDocument();
    expect(within(nodeOf('Feeding')).getByText('2 people')).toBeInTheDocument();
  });

  it('says why a department with a parent outside the view stands at the top', () => {
    mocks.chart.mockReturnValue(
      loaded([department('feed', { name: 'Feeding', parentDepartmentId: 'management' })]),
    );
    renderPage('FARM');

    expect(screen.getByText('Reports to a department outside this view')).toBeInTheDocument();
  });

  it('marks a switched-off department', () => {
    mocks.chart.mockReturnValue(loaded([department('old', { name: 'Old shed', isActive: false })]));
    renderPage();

    expect(within(nodeOf('Old shed')).getByText('Inactive')).toBeInTheDocument();
  });

  it('warns about a parent loop and still shows every department in it', () => {
    mocks.chart.mockReturnValue(
      loaded([
        department('a', { name: 'Alpha', parentDepartmentId: 'b' }),
        department('b', { name: 'Beta', parentDepartmentId: 'a' }),
      ]),
    );
    renderPage();

    expect(
      screen.getByRole('heading', { name: 'Departments that are their own ancestors' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Alpha → Beta')).toBeInTheDocument();
    expect(nodeOf('Alpha')).toBeInTheDocument();
    expect(nodeOf('Beta')).toBeInTheDocument();
  });

  it('counts people who sit in no department instead of dropping them', () => {
    mocks.chart.mockReturnValue(loaded([department('ops', { headCount: 1 })], 1));
    renderPage();

    expect(screen.getByText('1 person is not placed in a department.')).toBeInTheDocument();
  });

  it('says nothing about unplaced people when there are none', () => {
    mocks.chart.mockReturnValue(loaded([department('ops', { headCount: 1 })], 0));
    renderPage();

    expect(screen.queryByText(/not placed in a department/)).not.toBeInTheDocument();
  });

  describe('keyboard', () => {
    function twoLevels(): void {
      mocks.chart.mockReturnValue(
        loaded([
          department('ops', { name: 'Operations' }),
          department('feed', { name: 'Feeding', parentDepartmentId: 'ops' }),
        ]),
      );
    }

    it('collapses and expands a department with Enter and Space on its toggle', async () => {
      twoLevels();
      const user = userEvent.setup();
      renderPage();

      const toggle = screen.getByRole('button', { name: 'Collapse Operations' });
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('Feeding')).toBeInTheDocument();

      toggle.focus();
      await user.keyboard('{Enter}');
      expect(screen.getByRole('button', { name: 'Expand Operations' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      expect(screen.queryByText('Feeding')).not.toBeInTheDocument();

      await user.keyboard(' ');
      expect(screen.getByRole('button', { name: 'Collapse Operations' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      expect(screen.getByText('Feeding')).toBeInTheDocument();
    });

    it('has no toggle on a department without sub-departments', () => {
      twoLevels();
      renderPage();

      expect(screen.queryByRole('button', { name: /Feeding/ })).not.toBeInTheDocument();
    });

    it('is reachable as a labelled nested list', () => {
      twoLevels();
      renderPage();

      const chart = screen.getByRole('list', { name: 'Organization chart' });
      expect(within(chart).getAllByRole('listitem')).toHaveLength(2);
    });
  });
});
