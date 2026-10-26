/**
 * DepartmentsPage — a department belongs to a module, or to none.
 *
 * In a module workspace the list is that module's and a new department is born
 * in it, with no selector; only the Company workspace picks a department's
 * module, offers "Company-wide", and may move an existing department (which
 * moves its employees between module team lists).
 */
import { WorkforceScopeProvider } from '@aquaculture/shared-ui';
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateDepartmentInput, Department, UpdateDepartmentInput } from '../../types';
import DepartmentsPage from '../DepartmentsPage';

const mocks = vi.hoisted(() => ({
  create: vi.fn<(input: CreateDepartmentInput) => Promise<void>>(),
  update: vi.fn<(input: UpdateDepartmentInput) => Promise<void>>(),
  isManager: { current: true },
}));

const operations: Department = {
  id: 'dept-ops',
  name: 'Operations',
  code: 'OPS',
  moduleCode: 'FARM',
  isActive: true,
  sortOrder: 1,
};
const finance: Department = {
  id: 'dept-fin',
  name: 'Finance',
  code: 'FIN',
  moduleCode: null,
  isActive: true,
  sortOrder: 2,
};

vi.mock('../../hooks', () => ({
  useDepartments: () => ({ data: [operations, finance], isLoading: false, error: null }),
  useCreateDepartment: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUpdateDepartment: () => ({ mutateAsync: mocks.update, isPending: false }),
  useIsWorkforceManager: () => mocks.isManager.current,
}));

function renderPage(scope: HrModuleCode | null): void {
  render(
    <MemoryRouter>
      <WorkforceScopeProvider moduleCode={scope}>
        <DepartmentsPage />
      </WorkforceScopeProvider>
    </MemoryRouter>,
  );
}

function fillNameAndCode(name: string, code: string): void {
  fireEvent.change(screen.getByPlaceholderText('e.g. Operations'), { target: { value: name } });
  fireEvent.change(screen.getByPlaceholderText('e.g. OPS'), { target: { value: code } });
}

function moduleSelect(): HTMLSelectElement {
  const select = screen.getByLabelText('Module');
  if (!(select instanceof HTMLSelectElement))
    throw new Error('The module field is not a native <select>');
  return select;
}

describe('DepartmentsPage', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.create.mockResolvedValue(undefined);
    mocks.update.mockReset();
    mocks.update.mockResolvedValue(undefined);
    mocks.isManager.current = true;
  });

  it('offers creating and editing departments to a workforce manager', () => {
    renderPage(null);

    expect(screen.getByRole('button', { name: /New Department/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Edit department' })).toHaveLength(2);
  });

  it('offers neither to a reader the service would reject, but still lists the departments', () => {
    mocks.isManager.current = false;
    renderPage(null);

    expect(screen.queryByRole('button', { name: /New Department/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit department' })).not.toBeInTheDocument();
    expect(screen.getByText('OPS · Production')).toBeInTheDocument();
  });

  it('shows the module each department belongs to, and company-wide for none', () => {
    renderPage(null);

    expect(screen.getByText('OPS · Production')).toBeInTheDocument();
    expect(screen.getByText('FIN · Company-wide')).toBeInTheDocument();
  });

  it('says in its header which workspace’s departments it lists', () => {
    renderPage('SENSOR');

    expect(screen.getByText('Control & sensors')).toBeInTheDocument();
  });

  it('links each department to the team list filtered to it', () => {
    renderPage(null);

    expect(screen.getAllByRole('link', { name: /View Employees/ })[0]).toHaveAttribute(
      'href',
      '/hr/employees?departmentId=dept-ops',
    );
  });

  it('keeps the link to the organization chart', () => {
    renderPage(null);

    expect(screen.getByRole('link', { name: 'View full organization chart' })).toHaveAttribute(
      'href',
      '/hr/organization',
    );
  });

  describe('in a module workspace', () => {
    it('creates a department in the workspace’s module, with no module selector', async () => {
      renderPage('HYDROPONICS');
      fireEvent.click(screen.getByRole('button', { name: /New Department/ }));
      fillNameAndCode('Nutrients', 'NUT');

      expect(screen.queryByLabelText('Module')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
      expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({
        name: 'Nutrients',
        code: 'NUT',
        moduleCode: 'HYDROPONICS',
      });
    });

    it('does not touch a department’s module when it is edited', async () => {
      renderPage('FARM');
      fireEvent.click(screen.getAllByRole('button', { name: 'Edit department' })[0]!);

      expect(screen.queryByLabelText('Module')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Update' }));

      await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
      expect(Object.keys(mocks.update.mock.calls[0]?.[0] ?? {})).not.toContain('moduleCode');
    });
  });

  describe('in the Company workspace', () => {
    it('offers company-wide and every module when creating', () => {
      renderPage(null);
      fireEvent.click(screen.getByRole('button', { name: /New Department/ }));

      expect(Array.from(moduleSelect().options).map((option) => option.textContent)).toEqual([
        'Company-wide',
        'Production',
        'Greenhouse',
        'Control & sensors',
        'Human resources',
      ]);
    });

    it('creates a department in the chosen module', async () => {
      renderPage(null);
      fireEvent.click(screen.getByRole('button', { name: /New Department/ }));
      fillNameAndCode('Nutrients', 'NUT');
      fireEvent.change(moduleSelect(), { target: { value: 'HYDROPONICS' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
      expect(mocks.create.mock.calls[0]?.[0].moduleCode).toBe('HYDROPONICS');
    });

    it('creates a company-wide department by sending no module', async () => {
      renderPage(null);
      fireEvent.click(screen.getByRole('button', { name: /New Department/ }));
      fillNameAndCode('Legal', 'LEG');
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
      expect(mocks.create.mock.calls[0]?.[0].moduleCode).toBeUndefined();
    });

    it('moves a department back to company-wide with null, and says what that does to its employees', async () => {
      renderPage(null);
      fireEvent.click(screen.getAllByRole('button', { name: 'Edit department' })[0]!);

      expect(moduleSelect()).toHaveValue('FARM');
      expect(
        screen.getByText(/moves its employees to that module's team list/),
      ).toBeInTheDocument();
      fireEvent.change(moduleSelect(), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'Update' }));

      await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
      expect(mocks.update.mock.calls[0]?.[0]).toMatchObject({ id: 'dept-ops', moduleCode: null });
    });
  });
});
