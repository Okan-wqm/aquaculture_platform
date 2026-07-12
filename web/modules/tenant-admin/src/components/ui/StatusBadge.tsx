import React, { memo } from 'react';
import { CheckCircle, XCircle, Clock } from 'lucide-react';
import { Badge, type BadgeProps } from '@aquaculture/shared-ui';

export interface StatusBadgeProps {
  status: string;
}

const statusConfig: Record<string, { variant: BadgeProps['variant']; icon: React.ReactNode }> = {
  active: { variant: 'success', icon: <CheckCircle className="w-3 h-3" /> },
  inactive: { variant: 'default', icon: <XCircle className="w-3 h-3" /> },
  pending: { variant: 'warning', icon: <Clock className="w-3 h-3" /> },
};

const defaultConfig: { variant: BadgeProps['variant']; icon: React.ReactNode } = {
  variant: 'default',
  icon: <Clock className="w-3 h-3" />,
};

/**
 * Renders a user status with appropriate color and icon.
 *
 * Thin domain wrapper over the shared-ui `Badge` (ADMIN-MEDIUM-004): the
 * status → variant mapping lives here, the markup comes from Badge.
 */
export const StatusBadge = memo<StatusBadgeProps>(({ status }) => {
  const config = statusConfig[status] ?? defaultConfig;

  return (
    <Badge variant={config.variant} size="sm" className="gap-1">
      {config.icon}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
});

StatusBadge.displayName = 'StatusBadge';
