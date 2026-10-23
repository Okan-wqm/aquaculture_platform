/**
 * EmployeesListPage — the team list of the workspace, by department.
 *
 * An employee's department is `departmentHr` (the department entity), and it
 * carries the module the employee is listed under. The legacy `department`
 * enum and the "Farm" membership toggle are gone: membership of a module is the
 * department's, changed only by placing the employee in another department.
 */
import { WorkforceScopeProvider } from '@aquaculture/shared-ui';
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEmployee, DECK_DEPARTMENT_ID } from '../../../test-utils/employee';
import type { Department, Employee, EmployeeFilterInput } from '../../../types';
import { EmployeesListPage } from '../EmployeesListPage';

type EmployeesQuery = (
  filter?: EmployeeFilterInput,
  pagination?: { limit?: number; page?: number },
) => { data: { items: Employee[]; total: number }; isLoading: boolean };

const mocks = vi.hoisted(() => ({
  employees: vi.fn<EmployeesQuery>(),
  isManager: { current: true },
}));

const DECK = DECK_DEPARTMENT_ID;
const GALLEY = '22222222-2222-4222-8222-222222222222';

const departments: Department[] = [
  { id: DECK, name: 'Deck', code: 'DECK', moduleCode: 'FARM', isActive: true, sortOrder: 1 },
  { id: GALLEY, name: 'Galley', code: 'GAL', moduleCode: null, isActive: true, sortOrder: 2 },
];

vi.mock('../../../hooks', () => ({
  useEmployees: mocks.employees,
  useDepartments: () => ({ data: departments }),
  usePositions: () => ({ data: [] }),
  useIsWorkforceManager: () => mocks.isManager.current,
}));

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return { ...actual, useAuth: () => ({ user: null, tenantId: 'tenant-1' }) };
});

const ada = buildEmployee();

function renderPage(options: { scope?: HrModuleCode | null; url?: string } = {}): void {
  render(
    <MemoryRouter initialEntries={[options.url ?? '/hr/employees']}>
      <WorkforceScopeProvider moduleCode={options.scope ?? null}>
        <EmployeesListPage />
      </WorkforceScopeProvider>
    </MemoryRouter>,
  );
}

function lastFilter(): EmployeeFilterInput | undefined {
  const { calls } = mocks.employees.mock;
  return calls[calls.length - 1]?.[0];
}

describe('EmployeesListPage', () => {
  beforeEach(() => {
    mocks.employees.mockReset();
    mocks.employees.mockReturnValue({ data: { items: [ada], total: 1 }, isLoading: false });
    mocks.isManager.current = true;
  });

  it('offers hiring and editing to a workforce manager', () => {
    renderPage();

    expect(screen.getByRole('button', { name: 'Add Employee' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('offers neither to a reader the service would reject', () => {
    mocks.isManager.current = false;
    renderPage();

    expect(screen.queryByRole('button', { name: 'Add Employee' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
  });

  it('shows each employee under the department they are placed in, with its module', () => {
    renderPage();

    const row = screen.getByText('Ada Lovelace').closest('tr');
    if (!row) throw new Error('the employee row is missing');
    expect(within(row).getByText('Deck')).toBeInTheDocument();
    expect(within(row).getByText('· Production')).toBeInTheDocument();
  });

  it('has no farm-worker column: module membership is the department’s', () => {
    renderPage();

    expect(screen.queryByRole('columnheader', { name: 'Farm' })).not.toBeInTheDocument();
  });

  it('says in its header which workspace’s people it lists', () => {
    renderPage({ scope: 'HYDROPONICS' });

    expect(screen.getByText('Greenhouse')).toBeInTheDocument();
  });

  it('starts filtered to the department the Departments page linked to', () => {
    renderPage({ url: `/hr/employees?departmentId=${DECK}` });

    expect(lastFilter()).toEqual({ departmentHrId: DECK });
  });

  it('offers departments named with their module and filters by the department entity', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));

    const select = screen.getByLabelText('Department');
    if (!(select instanceof HTMLSelectElement))
      throw new Error('The department filter is not a native <select>');
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'All Departments',
      'Deck · Production',
      'Galley · Company-wide',
    ]);

    fireEvent.change(select, { target: { value: GALLEY } });

    expect(lastFilter()).toEqual({ departmentHrId: GALLEY });
  });
});
