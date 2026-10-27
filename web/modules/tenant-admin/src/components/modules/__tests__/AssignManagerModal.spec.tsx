/**
 * AssignManagerModal — Assign Manager names the module by its code (PKG-06; RBAC-HIGH-034,
 * RBAC-MEDIUM-036).
 *
 * The modal sent the module's catalogue id, and the server promoted the chosen user's users.role
 * tenant-wide. Assign Manager now takes the module code and writes only that module's primary
 * manager grant, so the modal sends `{ moduleCode, userId }` and never an id the server would
 * have to map back to a module.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  assign: vi.fn(),
}));

vi.mock('../../../hooks/useTenantData', () => ({
  useTenantUsers: () => ({
    data: [
      { id: 'user-ada', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' },
      { id: 'user-bo', firstName: 'Bo', lastName: 'Ek', email: 'bo@example.test' },
    ],
    isLoading: false,
  }),
  useAssignModuleManager: () => ({ mutateAsync: state.assign, isPending: false }),
}));

vi.mock('../../../utils/error-handling', () => ({
  logError: (): void => undefined,
  sanitizeErrorMessage: () => 'The manager could not be assigned.',
}));

import AssignManagerModal from '../AssignManagerModal';
import type { DisplayModule } from '../ModuleCard';

const FARM: DisplayModule = {
  id: '10000000-0000-4000-8000-000000000001',
  code: 'farm',
  name: 'Farm Management',
  description: 'Farm Management module for your tenant',
  status: 'active',
  assignedUsers: 3,
  ownerModule: 'farm',
  lastActivity: 'Recently',
  features: [],
  icon: 'fish',
  activatedAt: '2026-10-01T00:00:00.000Z',
};

describe('AssignManagerModal', () => {
  beforeEach(() => {
    state.assign.mockReset();
  });

  it('assigns the chosen user by the module code', async () => {
    state.assign.mockResolvedValue({ id: 'tm-farm', moduleId: FARM.id });
    const onClose = vi.fn();
    render(<AssignManagerModal isOpen onClose={onClose} module={FARM} />);

    await userEvent.click(screen.getByRole('button', { name: /Ada Lovelace/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Assign Manager' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(state.assign).toHaveBeenCalledWith({ moduleCode: 'farm', userId: 'user-ada' });
  });

  it('keeps the dialog open and shows why when the assignment is refused', async () => {
    state.assign.mockRejectedValue(new Error('Module "farm" is not enabled for this tenant'));
    const onClose = vi.fn();
    render(<AssignManagerModal isOpen onClose={onClose} module={FARM} />);

    await userEvent.click(screen.getByRole('button', { name: /Bo Ek/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Assign Manager' }));

    expect(await screen.findByText('The manager could not be assigned.')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
