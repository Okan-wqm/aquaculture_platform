/**
 * Chart Container Component
 * Wrapper component for charts with title, legend, and actions
 */

import React from 'react';

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
    <div className="h-full bg-gray-100 rounded-lg" />
  </div>
);

const ErrorState: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex items-center justify-center h-full min-h-[200px] bg-red-50 rounded-lg">
    <div className="text-center">
      <svg className="w-12 h-12 mx-auto text-red-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p className="text-sm text-red-600">{message}</p>
    </div>
  </div>
);

export const ChartContainer: React.FC<ChartContainerProps> = ({
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
    <div className={`bg-white rounded-xl shadow-sm border border-gray-200 ${className}`}>
      {/* Header */}
      {(title || actions) && (
        <div className="flex items-start justify-between p-4 border-b border-gray-100">
          <div>
            {title && <h3 className="text-sm font-semibold text-gray-900">{title}</h3>}
            {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
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
      {footer && <div className="px-4 py-3 border-t border-gray-100 bg-gray-50 rounded-b-xl">{footer}</div>}
    </div>
  );
};

export default ChartContainer;
