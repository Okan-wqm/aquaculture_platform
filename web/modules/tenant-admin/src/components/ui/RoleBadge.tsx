import { memo } from 'react';
import { Shield } from 'lucide-react';
import { Badge, type BadgeProps } from '@aquaculture/shared-ui';

export interface RoleBadgeProps {
  role: string;
}

const roleConfig: Record<string, { variant: BadgeProps['variant']; label: string }> = {
  SUPER_ADMIN: { variant: 'error', label: 'Super Admin' },
  TENANT_ADMIN: { variant: 'info', label: 'Tenant Admin' },
  MODULE_MANAGER: { variant: 'success', label: 'Module Manager' },
  MODULE_USER: { variant: 'default', label: 'Module User' },
};

const defaultConfig: { variant: BadgeProps['variant']; label: string } = {
  variant: 'default',
  label: 'Unknown',
};

/**
 * Renders a role name with appropriate color badge.
 *
 * Thin domain wrapper over the shared-ui `Badge` (ADMIN-MEDIUM-004): the
 * role → variant mapping lives here, the markup comes from Badge.
 */
export const RoleBadge = memo<RoleBadgeProps>(({ role }) => {
  const config = roleConfig[role] ?? defaultConfig;

  return (
    <Badge variant={config.variant} size="sm" className="gap-1">
      <Shield className="w-3 h-3" />
      {config.label}
    </Badge>
  );
});

RoleBadge.displayName = 'RoleBadge';
