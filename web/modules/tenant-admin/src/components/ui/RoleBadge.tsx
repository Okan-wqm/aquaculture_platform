import { memo } from 'react';
import { Shield } from 'lucide-react';

export interface RoleBadgeProps {
  role: string;
}

const roleConfig: Record<string, { bg: string; text: string; label: string }> = {
  SUPER_ADMIN: { bg: 'bg-red-100', text: 'text-red-700', label: 'Super Admin' },
  TENANT_ADMIN: { bg: 'bg-purple-100', text: 'text-purple-700', label: 'Tenant Admin' },
  MODULE_MANAGER: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Module Manager' },
  MODULE_USER: { bg: 'bg-gray-100', text: 'text-gray-700', label: 'Module User' },
};

const defaultConfig = { bg: 'bg-gray-100', text: 'text-gray-700', label: 'Unknown' };

/**
 * Renders a role name with appropriate color badge.
 */
export const RoleBadge = memo<RoleBadgeProps>(({ role }) => {
  const config = roleConfig[role] ?? defaultConfig;

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>
      <Shield className="w-3 h-3 mr-1" />
      {config.label}
    </span>
  );
});

RoleBadge.displayName = 'RoleBadge';
