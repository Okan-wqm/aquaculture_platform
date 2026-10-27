import React, { useEffect, useMemo, useState } from 'react';
import { Button, Modal, Select, useAuth, useAuthContext } from '@aquaculture/shared-ui';
import {
  OWNER_MODULE_CODES,
  isModuleRole,
  type ModuleRole,
  type OwnerModuleCode,
} from '@aquaculture/shared-contracts';
import { RefreshCw } from 'lucide-react';

import { useSetUserModuleAccess, useUserModuleAccess } from '../../hooks/useModuleAccess';
import { canManageUserSiteAccess } from '../../hooks/useUserSiteAccess';
import type { ModuleAccessGrants } from '../../lib/module-access-api';
import { logError, sanitizeErrorMessage } from '../../utils/error-handling';
import type { DisplayUser } from './UserListSection';

/**
 * ModuleAccessModal — a member's role in each module (PKG-06; ADR-051 §2 "Change").
 *
 * WHY: a member's module power came from the tenant-wide users.role, so a manager of one module
 * managed them all, HR payroll included. The administrator now states the member's role per
 * module, and the member's next token carries exactly that.
 *
 * WHAT: one choice per owner module the tenant has enabled (none, user, manager), filled from
 * what the member's next token carries, saved as the member's whole set: a declarative replace,
 * so a module left at none is sent as null. The server invalidates the member's tokens and
 * audits the change. Administrators hold every enabled module through the account role, so the
 * dialog is offered for members only, and only to a tenant administrator — the same gate as the
 * server's (TenantAdminOrHigher) and as site access.
 */
const ROLE_OPTIONS: ReadonlyArray<{ value: '' | ModuleRole; label: string }> = [
  { value: '', label: 'No access' },
  { value: 'MODULE_USER', label: 'User' },
  { value: 'MODULE_MANAGER', label: 'Manager' },
];

const NO_GRANTS: ModuleAccessGrants = { farm: null, hr: null, sensor: null, hydroponics: null };

function isAdministrator(role: string): boolean {
  return role === 'TENANT_ADMIN' || role === 'SUPER_ADMIN';
}

interface ModuleAccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: DisplayUser | null;
}

export const ModuleAccessModal: React.FC<ModuleAccessModalProps> = ({ isOpen, onClose, user }) => {
  const { user: viewer } = useAuth();
  const { modules } = useAuthContext();
  const isMember = user !== null && !isAdministrator(user.role);
  const dialogIsOpen = isOpen && isMember && canManageUserSiteAccess(viewer?.role);
  const userId = user === null ? '' : user.id;

  const accessQuery = useUserModuleAccess(userId, dialogIsOpen);
  const saveMutation = useSetUserModuleAccess();
  const [choice, setChoice] = useState<ModuleAccessGrants>(NO_GRANTS);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setChoice(accessQuery.data ?? NO_GRANTS);
    setSaveError(null);
  }, [accessQuery.data, isOpen, userId]);

  // The tenant's enabled owner modules, in the dictionary's order, named as the console names them.
  const enabledModules = useMemo(
    () =>
      OWNER_MODULE_CODES.flatMap((code) => {
        const record = modules.find((module) => module.code === code);
        return record === undefined ? [] : [{ code, name: record.name || code }];
      }),
    [modules],
  );

  if (!dialogIsOpen || user === null) return null;

  const setRole = (code: OwnerModuleCode, value: string): void => {
    setChoice((previous) => ({ ...previous, [code]: isModuleRole(value) ? value : null }));
  };

  const handleSave = async (): Promise<void> => {
    setSaveError(null);
    // Only enabled modules are offered; a module the tenant has not enabled is sent as none.
    const moduleAccess: { [Code in OwnerModuleCode]: ModuleRole | null } = { ...NO_GRANTS };
    for (const { code } of enabledModules) moduleAccess[code] = choice[code];
    try {
      await saveMutation.mutateAsync({ userId: user.id, moduleAccess });
      onClose();
    } catch (error) {
      logError('ModuleAccessModal', error);
      setSaveError(sanitizeErrorMessage(error));
    }
  };

  const busy = saveMutation.isPending;
  return (
    <Modal
      isOpen
      onClose={onClose}
      size="sm"
      title="Module access"
      description={<>The role {user.name} holds in each module</>}
      showCloseButton={!busy}
      closeOnEscape={!busy}
      closeOnOverlayClick={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={busy || accessQuery.data === undefined}
          >
            {busy && <RefreshCw className="w-4 h-4 animate-spin" />}
            Save module access
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {accessQuery.isError && (
          <p className="text-sm text-error-600 dark:text-error-400">
            The member&apos;s module access could not be loaded.
          </p>
        )}
        {enabledModules.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            The tenant has no module that grants access.
          </p>
        )}
        {enabledModules.map(({ code, name }) => (
          <Select
            key={code}
            label={name}
            options={ROLE_OPTIONS.map((option) => ({ ...option }))}
            value={choice[code] ?? ''}
            disabled={busy || accessQuery.data === undefined}
            onChange={(event) => setRole(code, event.target.value)}
          />
        ))}
        {saveError && <p className="text-sm text-error-600 dark:text-error-400">{saveError}</p>}
      </div>
    </Modal>
  );
};
