/**
 * Chart Container Component
 * Wrapper component for charts with title, legend, and actions
 */

import React from 'react';
import { CircleAlert } from 'lucide-react';

export interface ChartContainerProps {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  height?: number | string;
  className?: string;
  loading?: boolean;
  error?: string | null;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
}

const LoadingSkeleton: React.FC<{ height: number | string }> = ({ height }) => (
  <div className="animate-pulse" style={{ height }}>
    <div className="h-full bg-gray-100 dark:bg-gray-800 rounded-lg" />
  </div>
);

// BUG-021: Remove hardcoded min-h-[200px] — use h-full so error state respects
// the container height prop and doesn't overflow small charts
const ErrorState: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex items-center justify-center h-full w-full bg-error-50 rounded-lg">
    <div className="text-center">
      <CircleAlert className="w-12 h-12 mx-auto text-error-400 mb-2" aria-hidden="true" />
      <p className="text-sm text-error-600">{message}</p>
    </div>
  </div>
);

// PERF-009: Charts are typically expensive to render — memo prevents unnecessary re-renders
// when parent dashboard state changes but chart data hasn't changed
const ChartContainerInner: React.FC<ChartContainerProps> = ({
  title,
  subtitle,
  children,
  height = 300,
  className = '',
  loading = false,
  error = null,
  actions,
  footer,
}) => {
  return (
    <div
      className={`bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 ${className}`}
    >
      {/* Header */}
      {(title || actions) && (
        <div className="flex items-start justify-between p-4 border-b border-gray-100 dark:border-gray-700">
          <div>
            {title && (
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
            )}
            {subtitle && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}

      {/* Chart Content */}
      <div className="p-4" style={{ height: typeof height === 'number' ? `${height}px` : height }}>
        {loading ? (
          <LoadingSkeleton height={height} />
        ) : error ? (
          <ErrorState message={error} />
        ) : (
          children
        )}
      </div>

      {/* Footer */}
      {footer && (
        <div className="px-4 py-3 border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 rounded-b-xl">
          {footer}
        </div>
      )}
    </div>
  );
};

export const ChartContainer = React.memo(ChartContainerInner);
ChartContainer.displayName = 'ChartContainer';

export default ChartContainer;
