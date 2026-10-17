/**
 * useViewAsMenu — the user menu's "View as role" section (FE-HIGH-334, design
 * README §8, decision D20: tenant admins only).
 *
 * WHAT: the admin's own view first, then each tenant role (auth-service
 * tenantRoles, useViewAsRoles), each with the number of console pages it can
 * open as the nav model counts them; the row being shown is pressed, and a
 * pick hands the role — or null for the admin's own view — to `onPick`.
 * Anyone but a tenant admin gets no section, and their roles are not fetched.
 */
import { useI18n, type UserMenuRole, type UserMenuViewAs } from '@aquaculture/shared-ui';
import { useMemo } from 'react';

import { useConsoleShell } from '../ConsoleShellContext';
import { useViewAsRoles, type ViewAsRole } from '../data';
import { buildConsoleNav, type ConsoleNavInput } from '../nav';

import { OWN_VIEW_ID, countConsolePages, viewAsNavInput } from './viewAs';

export function useViewAsMenu(
  real: ConsoleNavInput,
  onPick: (role: ViewAsRole | null) => void,
): UserMenuViewAs | undefined {
  const { t } = useI18n();
  const { viewAsRole } = useConsoleShell();
  const isTenantAdmin = real.role === 'TENANT_ADMIN';
  const tenantRoles = useViewAsRoles({ enabled: isTenantAdmin });
  // The query's data keeps its identity between renders, so the page counts
  // are rebuilt only when the roles, the viewer or the language change.
  const roles = tenantRoles.status === 'ready' ? tenantRoles.roles : null;

  return useMemo((): UserMenuViewAs | undefined => {
    if (roles === null) return undefined;
    const own: UserMenuRole = {
      id: OWN_VIEW_ID,
      label: t('console.role.TENANT_ADMIN'),
      pageCount: countConsolePages(buildConsoleNav(real)),
    };
    const previews = roles.map(
      (role): UserMenuRole => ({
        id: role.id,
        label: role.name,
        pageCount: countConsolePages(buildConsoleNav(viewAsNavInput(real, role))),
      }),
    );
    return {
      roles: [own, ...previews],
      activeRoleId: viewAsRole === null ? OWN_VIEW_ID : viewAsRole.id,
      onViewAs: (id: string): void =>
        onPick(roles.find((role) => role.id === id && id !== OWN_VIEW_ID) ?? null),
    };
  }, [roles, real, t, viewAsRole, onPick]);
}
