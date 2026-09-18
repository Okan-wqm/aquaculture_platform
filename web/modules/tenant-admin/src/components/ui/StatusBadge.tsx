import React, { memo } from 'react';
import { CheckCircle, XCircle, Clock } from 'lucide-react';

export interface StatusBadgeProps {
  status: string;
}

// SUDERRA tints via the shell's sd-pill primitives (host styles federated pages)
const statusConfig: Record<string, { cls: string; icon: React.ReactNode }> = {
  active: { cls: 'sd-pill sd-pill--active', icon: <CheckCircle size={13} /> },
  inactive: { cls: 'sd-pill sd-pill--inactive', icon: <XCircle size={13} /> },
  pending: { cls: 'sd-pill sd-pill--pending', icon: <Clock size={13} /> },
};

const defaultConfig = { cls: 'sd-pill sd-pill--inactive', icon: <Clock size={13} /> };

/**
 * Renders a user status with appropriate color and icon.
 */
export const StatusBadge = memo<StatusBadgeProps>(({ status }) => {
  const config = statusConfig[status] ?? defaultConfig;

  return (
    <span className={config.cls}>
      {config.icon}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
});

StatusBadge.displayName = 'StatusBadge';
