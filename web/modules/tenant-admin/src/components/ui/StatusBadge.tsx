import React, { memo } from 'react';
import { CheckCircle, XCircle, Clock } from 'lucide-react';

export interface StatusBadgeProps {
  status: string;
}

const statusConfig: Record<string, { bg: string; text: string; icon: React.ReactNode }> = {
  active: { bg: 'bg-green-100', text: 'text-green-700', icon: <CheckCircle className="w-3 h-3" /> },
  inactive: { bg: 'bg-gray-100', text: 'text-gray-700', icon: <XCircle className="w-3 h-3" /> },
  pending: { bg: 'bg-yellow-100', text: 'text-yellow-700', icon: <Clock className="w-3 h-3" /> },
};

const defaultConfig = { bg: 'bg-gray-100', text: 'text-gray-700', icon: <Clock className="w-3 h-3" /> };

/**
 * Renders a user status with appropriate color and icon.
 */
export const StatusBadge = memo<StatusBadgeProps>(({ status }) => {
  const config = statusConfig[status] ?? defaultConfig;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>
      {config.icon}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
});

StatusBadge.displayName = 'StatusBadge';
