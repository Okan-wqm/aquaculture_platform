/**
 * RoleBadge — a platform role on the shared-ui Badge scale (FE-HIGH-079):
 * the four roles stay distinguishable (error / info / outline / neutral)
 * without a private colour map.
 */
import React, { memo } from 'react';
import { Shield } from 'lucide-react';
import { Badge } from '@aquaculture/shared-ui';

export interface RoleBadgeProps {
  role: string;
}

type BadgeVariant = React.ComponentProps<typeof Badge>['variant'];

const ROLE: Record<string, { variant: BadgeVariant; label: string }> = {
  SUPER_ADMIN: { variant: 'error', label: 'Super Admin' },
  TENANT_ADMIN: { variant: 'info', label: 'Tenant Admin' },
  MODULE_MANAGER: { variant: 'outline', label: 'Module Manager' },
  MODULE_USER: { variant: 'default', label: 'Module User' },
};
const UNKNOWN = { variant: 'default' as BadgeVariant, label: 'Unknown' };

export const RoleBadge = memo<RoleBadgeProps>(({ role }) => {
  const config = ROLE[role] ?? UNKNOWN;
  return (
    <Badge variant={config.variant} size="sm" className="gap-1">
      <Shield className="w-3 h-3" aria-hidden="true" />
      {config.label}
    </Badge>
  );
});

RoleBadge.displayName = 'RoleBadge';
