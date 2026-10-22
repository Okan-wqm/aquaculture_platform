/**
 * EmployeeFormPage — an employee is placed by `departmentHrId`, and only by it.
 *
 * The form used to send a legacy `department` enum string next to the
 * department's id, mapped from the department's code. The enum is retired: the
 * department entity is the one answer, and its module is the module the new
 * employee is listed under. An employee with no department belongs to no module,
 * so a module workspace requires one (otherwise the new row would vanish from the
 * very team list the user is looking at); Company may leave it empty.
 */
import { WorkforceScopeProvider } from '@aquaculture/shared-ui';
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEmployee, DECK_DEPARTMENT_ID } from '../../test-utils/employee';
import type { CreateEmployeeInput, Department, Employee, UpdateEmployeeInput } from '../../types';
import EmployeeFormPage from '../EmployeeFormPage';

const mocks = vi.hoisted(() => ({
  create: vi.fn<(input: CreateEmployeeInput) => void>(),
  update: vi.fn<(input: UpdateEmployeeInput) => void>(),
  employee: { current: undefined as Employee | undefined },
}));

const DECK = DECK_DEPARTMENT_ID;
const GALLEY = '22222222-2222-4222-8222-222222222222';

const departments: Department[] = [
  { id: DECK, name: 'Deck', code: 'DECK', moduleCode: 'FARM', isActive: true, sortOrder: 1 },
  { id: GALLEY, name: 'Galley', code: 'GAL', moduleCode: null, isActive: true, sortOrder: 2 },
];

vi.mock('../../hooks', () => ({
  useEmployee: () => ({ data: mocks.employee.current, isLoading: false }),
  useCreateEmployee: () => ({ mutate: mocks.create, isPending: false, error: null }),
  useUpdateEmployee: () => ({ mutate: mocks.update, isPending: false, error: null }),
  useDepartments: () => ({ data: departments, isLoading: false }),
}));

const ada = buildEmployee();

function renderForm(options: { scope: HrModuleCode | null; path: string }): void {
  render(
    <MemoryRouter initialEntries={[options.path]}>
      <WorkforceScopeProvider moduleCode={options.scope}>
        <Routes>
          <Route path="/hr/employees/new" element={<EmployeeFormPage />} />
          <Route path="/hr/employees/:employeeId/edit" element={<EmployeeFormPage />} />
        </Routes>
      </WorkforceScopeProvider>
    </MemoryRouter>,
  );
}

function submit(label: string): void {
  const form = screen.getByRole('button', { name: label }).closest('form');
  if (!form) throw new Error('the form is missing');
  fireEvent.submit(form);
}

function departmentSelect(): HTMLSelectElement {
  const select = screen.getByLabelText(/Department/);
  if (!(select instanceof HTMLSelectElement))
    throw new Error('The department field is not a native <select>');
  return select;
}

function created(): CreateEmployeeInput {
  const input = mocks.create.mock.calls[0]?.[0];
  if (!input) throw new Error('createEmployee was not called');
  return input;
}

describe('EmployeeFormPage department', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.update.mockReset();
    mocks.employee.current = undefined;
  });

  it('lists the departments named with their module', () => {
    renderForm({ scope: null, path: '/hr/employees/new' });

    expect(Array.from(departmentSelect().options).map((option) => option.textContent)).toEqual([
      'Select department',
      'Deck · Production',
      'Galley · Company-wide',
    ]);
  });

  it('places the new employee by departmentHrId alone — no legacy department string, no farm flag', () => {
    renderForm({ scope: null, path: '/hr/employees/new' });
    fireEvent.change(departmentSelect(), { target: { value: DECK } });

    submit('Create Employee');

    const input = created();
    expect(input.departmentHrId).toBe(DECK);
    expect(Object.keys(input)).not.toContain('department');
    expect(Object.keys(input)).not.toContain('isFarmWorker');
  });

  it('lets the Company workspace create an employee with no department', () => {
    renderForm({ scope: null, path: '/hr/employees/new' });

    submit('Create Employee');

    expect(created().departmentHrId).toBeUndefined();
  });

  it('requires a department in a module workspace, so the new employee is born inside the module', () => {
    renderForm({ scope: 'FARM', path: '/hr/employees/new' });

    submit('Create Employee');

    expect(mocks.create).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose the department this employee belongs to.',
    );
    expect(departmentSelect()).toHaveAttribute('aria-required', 'true');

    fireEvent.change(departmentSelect(), { target: { value: DECK } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    submit('Create Employee');

    expect(created().departmentHrId).toBe(DECK);
  });

  describe('editing an existing employee', () => {
    function updated(): UpdateEmployeeInput {
      const input = mocks.update.mock.calls[0]?.[0];
      if (!input) throw new Error('updateEmployee was not called');
      return input;
    }

    beforeEach(() => {
      mocks.employee.current = ada;
    });

    it('shows the department the employee is in, and does not resend it when it is untouched', () => {
      renderForm({ scope: 'FARM', path: '/hr/employees/emp-1/edit' });

      expect(departmentSelect()).toHaveValue(DECK);
      submit('Save Changes');

      expect(Object.keys(updated())).not.toContain('departmentHrId');
      expect(Object.keys(updated())).not.toContain('department');
    });

    it('moves the employee by sending the new departmentHrId alone', () => {
      renderForm({ scope: null, path: '/hr/employees/emp-1/edit' });
      fireEvent.change(departmentSelect(), { target: { value: GALLEY } });

      submit('Save Changes');

      expect(updated().departmentHrId).toBe(GALLEY);
    });

    it('lets the Company workspace take the employee out of every department', () => {
      renderForm({ scope: null, path: '/hr/employees/emp-1/edit' });
      fireEvent.change(departmentSelect(), { target: { value: '' } });

      submit('Save Changes');

      expect(updated().departmentHrId).toBeNull();
    });

    it('does not let a module workspace leave the employee without a department', () => {
      renderForm({ scope: 'FARM', path: '/hr/employees/emp-1/edit' });
      fireEvent.change(departmentSelect(), { target: { value: '' } });

      submit('Save Changes');

      expect(mocks.update).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Choose the department this employee belongs to.',
      );
    });

    it('keeps the current department selectable when it is no longer among the active ones', () => {
      mocks.employee.current = buildEmployee({
        departmentHrId: 'retired-department',
        departmentHr: {
          id: 'retired-department',
          name: 'Old shed',
          code: 'OLD',
          moduleCode: 'FARM',
        },
      });
      renderForm({ scope: null, path: '/hr/employees/emp-1/edit' });

      expect(departmentSelect()).toHaveValue('retired-department');
      expect(Array.from(departmentSelect().options).map((option) => option.textContent)).toContain(
        'Old shed · Production',
      );
    });
  });
});
