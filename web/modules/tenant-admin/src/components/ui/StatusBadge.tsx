/**
 * StatusBadge — a user's lifecycle state on the shared-ui Badge scale
 * (FE-HIGH-079): active is success, pending is warning, inactive is neutral.
 */
import React, { memo } from 'react';
import { CheckCircle, XCircle, Clock } from 'lucide-react';
import { Badge } from '@aquaculture/shared-ui';

export interface StatusBadgeProps {
  status: string;
}

type BadgeVariant = React.ComponentProps<typeof Badge>['variant'];

const STATUS: Record<string, { variant: BadgeVariant; icon: React.ReactNode }> = {
  active: { variant: 'success', icon: <CheckCircle className="w-3 h-3" aria-hidden="true" /> },
  inactive: { variant: 'default', icon: <XCircle className="w-3 h-3" aria-hidden="true" /> },
  pending: { variant: 'warning', icon: <Clock className="w-3 h-3" aria-hidden="true" /> },
};
const UNKNOWN = { variant: 'default' as BadgeVariant, icon: <Clock className="w-3 h-3" aria-hidden="true" /> };

export const StatusBadge = memo<StatusBadgeProps>(({ status }) => {
  const config = STATUS[status] ?? UNKNOWN;
  return (
    <Badge variant={config.variant} size="sm" className="gap-1">
      {config.icon}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
});

StatusBadge.displayName = 'StatusBadge';
