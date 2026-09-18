import { memo } from 'react';
import { Shield } from 'lucide-react';

export interface RoleBadgeProps {
  role: string;
}

// SUDERRA tints via the shell's sd-rolepill primitives
const roleConfig: Record<string, { cls: string; label: string }> = {
  SUPER_ADMIN: { cls: 'sd-rolepill sd-rolepill--super', label: 'Super Admin' },
  TENANT_ADMIN: { cls: 'sd-rolepill sd-rolepill--tenant', label: 'Tenant Admin' },
  MODULE_MANAGER: { cls: 'sd-rolepill sd-rolepill--manager', label: 'Module Manager' },
  MODULE_USER: { cls: 'sd-rolepill sd-rolepill--user', label: 'Module User' },
};

const defaultConfig = { cls: 'sd-rolepill sd-rolepill--user', label: 'Unknown' };

/**
 * Renders a role name with appropriate color badge.
 */
export const RoleBadge = memo<RoleBadgeProps>(({ role }) => {
  const config = roleConfig[role] ?? defaultConfig;

  return (
    <span className={config.cls}>
      <Shield size={12} aria-hidden="true" />
      {config.label}
    </span>
  );
});

RoleBadge.displayName = 'RoleBadge';
