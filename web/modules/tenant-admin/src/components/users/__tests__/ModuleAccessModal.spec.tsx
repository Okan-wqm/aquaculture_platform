/**
 * ModuleAccessModal — a tenant administrator states a member's role in each module (PKG-06;
 * ADR-051 §2 "Change": setUserModuleAccess).
 *
 * A member's module power came from the tenant-wide users.role, so making someone manager of one
 * module made them manager of all. The dialog shows one choice per enabled owner module (none,
 * MODULE_USER, MODULE_MANAGER) as the member's next token carries them, and saves the member's
 * whole set at once — a declarative replace, so a module left at "none" is sent as null. It is
 * not offered for an administrator, who holds every enabled module through the account role.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  viewerRole: 'TENANT_ADMIN',
  save: vi.fn(),
  queried: [] as Array<{ userId: string; enabled: boolean }>,
  // One object, as react-query's structural sharing hands back the same data between renders.
  grants: { farm: 'MODULE_USER', hr: null, sensor: 'MODULE_MANAGER', hydroponics: null },
}));

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    // The dialog renders through the real shared-ui primitives; only the session seams are faked.
    Modal: actual.Modal,
    Button: actual.Button,
    Select: actual.Select,
    useAuth: () => ({ user: { role: state.viewerRole } }),
    useAuthContext: () => ({
      modules: [
        { code: 'farm', name: 'Farm Management', defaultRoute: '/farm/dashboard' },
        { code: 'hr', name: 'Human Resources', defaultRoute: '/hr/dashboard' },
        { code: 'sensor', name: 'Sensors', defaultRoute: '/sensor/dashboard' },
        { code: 'alert', name: 'Alerts', defaultRoute: '/alerts' },
      ],
    }),
  };
});

vi.mock('../../../hooks/useModuleAccess', () => ({
  useUserModuleAccess: (userId: string, enabled: boolean) => {
    state.queried.push({ userId, enabled });
    return {
      data: state.grants,
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
  useSetUserModuleAccess: () => ({ mutateAsync: state.save, isPending: false }),
}));

vi.mock('../../../utils/error-handling', () => ({
  logError: (): void => undefined,
  sanitizeErrorMessage: () => 'The module access could not be saved.',
}));

import { ModuleAccessModal } from '../ModuleAccessModal';
import type { DisplayUser } from '../UserListSection';

function member(role: string): DisplayUser {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    role,
    status: 'active',
    isLocked: false,
    lastLogin: 'Never',
  };
}

describe('ModuleAccessModal', () => {
  beforeEach(() => {
    state.viewerRole = 'TENANT_ADMIN';
    state.save.mockReset();
    state.queried = [];
  });

  it("shows one role choice per enabled owner module, as the member's token carries them", () => {
    render(<ModuleAccessModal isOpen onClose={vi.fn()} user={member('MODULE_USER')} />);

    expect(screen.getByRole('combobox', { name: 'Farm Management' })).toHaveValue('MODULE_USER');
    expect(screen.getByRole('combobox', { name: 'Human Resources' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Sensors' })).toHaveValue('MODULE_MANAGER');
    // alert owns no data and carries no grant.
    expect(screen.queryByRole('combobox', { name: 'Alerts' })).toBeNull();
    expect(state.queried.at(-1)).toEqual({ userId: member('MODULE_USER').id, enabled: true });
  });

  it("saves the member's whole set of module roles, a module left at none as null", async () => {
    state.save.mockResolvedValue({ userId: member('MODULE_USER').id });
    const onClose = vi.fn();
    render(<ModuleAccessModal isOpen onClose={onClose} user={member('MODULE_USER')} />);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Farm Management' }), '');
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Human Resources' }),
      'MODULE_USER',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save module access' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(state.save).toHaveBeenCalledWith({
      userId: member('MODULE_USER').id,
      moduleAccess: { farm: null, hr: 'MODULE_USER', sensor: 'MODULE_MANAGER', hydroponics: null },
    });
  });

  it('keeps the dialog open and shows why when the change is refused', async () => {
    state.save.mockRejectedValue(new Error('Module "hr" is not enabled for this tenant'));
    const onClose = vi.fn();
    render(<ModuleAccessModal isOpen onClose={onClose} user={member('MODULE_MANAGER')} />);

    await userEvent.click(screen.getByRole('button', { name: 'Save module access' }));

    expect(await screen.findByText('The module access could not be saved.')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(['TENANT_ADMIN', 'SUPER_ADMIN'])(
    'is not offered for a %s, who holds every enabled module',
    (role) => {
      render(<ModuleAccessModal isOpen onClose={vi.fn()} user={member(role)} />);

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(state.queried.every((query) => !query.enabled)).toBe(true);
    },
  );

  it('is not offered to a viewer who is no tenant administrator', () => {
    state.viewerRole = 'MODULE_MANAGER';
    render(<ModuleAccessModal isOpen onClose={vi.fn()} user={member('MODULE_USER')} />);

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
