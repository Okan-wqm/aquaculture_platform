/**
 * useOperatorPermission — Evaluate widget-level permissions against the
 * current HMI operator role.
 *
 * Rules:
 *  - Admin bypasses every restriction (visible=true, enabled=true, no pin/confirm).
 *  - If showRoles is empty, all roles can see the widget.
 *  - If enabledRoles is empty, all roles can interact.
 *  - requiresConfirm: true when the role can interact but is not supervisor/admin.
 *  - requiresPin:     true when the role is exactly 'viewer' (view-only users
 *                     that were nonetheless granted enabledRoles access need a PIN).
 *
 * Result is fully memoized: recalculates only when role or permission changes.
 */

import { useMemo } from 'react';
import { HmiRole, hmiRoleAtLeast } from '@platform/identity';
import { useOperatorStore } from '../store/scada/operatorStore';
import type {
  WidgetPermission,
  WidgetPermissionResult,
} from '../types/scada-runtime.types';

export function useOperatorPermission(
  permission?: WidgetPermission,
): WidgetPermissionResult {
  const currentUserRole = useOperatorStore((s) => s.currentUserRole);

  return useMemo<WidgetPermissionResult>(() => {
    // Admin always has full access.
    if (currentUserRole === 'admin') {
      return { visible: true, enabled: true, requiresConfirm: false, requiresPin: false };
    }

    // No permission definition → fully open.
    if (!permission) {
      return { visible: true, enabled: true, requiresConfirm: false, requiresPin: false };
    }

    const { showRoles, enabledRoles } = permission;

    // Visibility check.
    const visible =
      showRoles.length === 0 || showRoles.includes(currentUserRole);

    // Interaction check.
    const enabled =
      visible &&
      (enabledRoles.length === 0 || enabledRoles.includes(currentUserRole));

    // Require confirmation for roles below supervisor when the widget is
    // interactable.  This models a "are you sure?" confirmation dialog.
    const requiresConfirm =
      enabled && !hmiRoleAtLeast(currentUserRole, HmiRole.SUPERVISOR);

    // Require PIN for viewers who were explicitly granted interaction access.
    const requiresPin = enabled && currentUserRole === HmiRole.VIEWER;

    return { visible, enabled, requiresConfirm, requiresPin };
  }, [currentUserRole, permission]);
}
