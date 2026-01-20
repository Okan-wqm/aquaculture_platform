/**
 * Enterprise KPI Card Component
 * Features: Trend indicators, sparklines, comparison values, loading states
 */

import React from 'react';

// ============================================================================
// Types
// ============================================================================

export type TrendDirection = 'up' | 'down' | 'neutral';
export type CardVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
export type CardSize = 'sm' | 'md' | 'lg';

export interface KpiCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  description?: string;

  // Trend
  trend?: {
    value: number;
    direction: TrendDirection;
    label?: string;
    isPercentage?: boolean;
  };

  // Comparison
  comparison?: {
    value: string | number;
    label: string;
  };

  // Sparkline data
  sparklineData?: number[];

  // Progress
  progress?: {
    current: number;
    max: number;
    label?: string;
    showPercentage?: boolean;
  };

  // Icon
  icon?: React.ReactNode;
  iconBackground?: string;

  // Styling
  variant?: CardVariant;
  size?: CardSize;
  className?: string;

  // Loading
  loading?: boolean;

  // Click handler
  onClick?: () => void;

  // Footer
  footer?: React.ReactNode;
}

// ============================================================================
// Helper Components
// ============================================================================

const TrendIndicator: React.FC<{
  value: number;
  direction: TrendDirection;
  label?: string;
  isPercentage?: boolean;
}> = ({ value, direction, label, isPercentage = true }) => {
  const colors = {
    up: 'text-green-600 bg-green-50',
    down: 'text-red-600 bg-red-50',
    neutral: 'text-gray-600 bg-gray-50',
  };

  const icons = {
    up: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
      </svg>
    ),
    down: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
      </svg>
    ),
    neutral: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14" />
      </svg>
    ),
  };

  return (
    <div className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${colors[direction]}`}>
      {icons[direction]}
      <span>
        {direction === 'up' ? '+' : direction === 'down' ? '-' : ''}
        {Math.abs(value)}
        {isPercentage ? '%' : ''}
      </span>
      {label && <span className="text-gray-500 ml-1">{label}</span>}
    </div>
  );
};

const MiniSparkline: React.FC<{ data: number[]; color?: string; height?: number }> = ({
  data,
  color = '#3B82F6',
  height = 32,
}) => {
  if (!data || data.length < 2) return null;

  const width = 80;
  const padding = 2;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data.map((value, index) => {
    const x = padding + (index / (data.length - 1)) * (width - padding * 2);
    const y = padding + (1 - (value - min) / range) * (height - padding * 2);
    return `${x},${y}`;
  });

  const pathD = `M${points.join(' L')}`;

  // Area fill
  const areaPoints = [...points, `${width - padding},${height - padding}`, `${padding},${height - padding}`];
  const areaD = `M${areaPoints.join(' L')}Z`;

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={`gradient-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#gradient-${color.replace('#', '')})`} />
      <path d={pathD} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={points[points.length - 1].split(',')[0]} cy={points[points.length - 1].split(',')[1]} r="3" fill={color} />
    </svg>
  );
};

const ProgressBar: React.FC<{
  current: number;
  max: number;
  label?: string;
  showPercentage?: boolean;
  variant?: CardVariant;
}> = ({ current, max, label, showPercentage = true, variant = 'default' }) => {
  const percentage = Math.min(Math.round((current / max) * 100), 100);

  const colors = {
    default: 'bg-blue-500',
    primary: 'bg-blue-600',
    success: 'bg-green-500',
    warning: 'bg-yellow-500',
    danger: 'bg-red-500',
    info: 'bg-cyan-500',
  };

  return (
    <div className="mt-3">
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>{label || 'Progress'}</span>
        {showPercentage && <span>{percentage}%</span>}
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full ${colors[variant]} rounded-full transition-all duration-500 ease-out`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
};

const LoadingSkeleton: React.FC<{ size: CardSize }> = ({ size }) => {
  const heights = {
    sm: 'h-4',
    md: 'h-6',
    lg: 'h-8',
  };

  return (
    <div className="animate-pulse">
      <div className="h-3 bg-gray-200 rounded w-1/3 mb-2" />
      <div className={`${heights[size]} bg-gray-200 rounded w-2/3 mb-2`} />
      <div className="h-3 bg-gray-200 rounded w-1/2" />
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const KpiCard: React.FC<KpiCardProps> = ({
  title,
  value,
  subtitle,
  description,
  trend,
  comparison,
  sparklineData,
  progress,
  icon,
  iconBackground = 'bg-blue-100',
  variant = 'default',
  size = 'md',
  className = '',
  loading = false,
  onClick,
  footer,
}) => {
  const sizeClasses = {
    sm: {
      padding: 'p-4',
      title: 'text-xs',
      value: 'text-xl',
      subtitle: 'text-xs',
      icon: 'w-8 h-8',
    },
    md: {
      padding: 'p-5',
      title: 'text-sm',
      value: 'text-2xl',
      subtitle: 'text-sm',
      icon: 'w-10 h-10',
    },
    lg: {
      padding: 'p-6',
      title: 'text-base',
      value: 'text-3xl',
      subtitle: 'text-base',
      icon: 'w-12 h-12',
    },
  };

  const variantColors = {
    default: {
      border: 'border-gray-200',
      iconBg: iconBackground,
      iconText: 'text-gray-600',
    },
    primary: {
      border: 'border-blue-200',
      iconBg: 'bg-blue-100',
      iconText: 'text-blue-600',
    },
    success: {
      border: 'border-green-200',
      iconBg: 'bg-green-100',
      iconText: 'text-green-600',
    },
    warning: {
      border: 'border-yellow-200',
      iconBg: 'bg-yellow-100',
      iconText: 'text-yellow-600',
    },
    danger: {
      border: 'border-red-200',
      iconBg: 'bg-red-100',
      iconText: 'text-red-600',
    },
    info: {
      border: 'border-cyan-200',
      iconBg: 'bg-cyan-100',
      iconText: 'text-cyan-600',
    },
  };

  const sizes = sizeClasses[size];
  const colors = variantColors[variant];

  return (
    <div
      className={`
        bg-white rounded-xl shadow-sm border ${colors.border}
        ${sizes.padding}
        ${onClick ? 'cursor-pointer hover:shadow-md hover:border-blue-300 transition-all duration-200' : ''}
        ${className}
      `}
      onClick={onClick}
    >
      {loading ? (
        <LoadingSkeleton size={size} />
      ) : (
        <>
          {/* Header */}
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <h3 className={`${sizes.title} font-medium text-gray-500 truncate`}>{title}</h3>
              <div className="flex items-baseline gap-2 mt-1">
                <span className={`${sizes.value} font-bold text-gray-900`}>{value}</span>
                {subtitle && <span className={`${sizes.subtitle} text-gray-500`}>{subtitle}</span>}
              </div>
            </div>

            {/* Icon or Sparkline */}
            {icon ? (
              <div className={`flex-shrink-0 ${sizes.icon} ${colors.iconBg} ${colors.iconText} rounded-lg flex items-center justify-center`}>
                {icon}
              </div>
            ) : sparklineData && sparklineData.length > 0 ? (
              <div className="flex-shrink-0">
                <MiniSparkline
                  data={sparklineData}
                  color={
                    variant === 'success'
                      ? '#10B981'
                      : variant === 'danger'
                      ? '#EF4444'
                      : variant === 'warning'
                      ? '#F59E0B'
                      : '#3B82F6'
                  }
                />
              </div>
            ) : null}
          </div>

          {/* Description */}
          {description && <p className="mt-2 text-xs text-gray-500">{description}</p>}

          {/* Trend & Comparison */}
          {(trend || comparison) && (
            <div className="flex items-center gap-3 mt-3">
              {trend && (
                <TrendIndicator
                  value={trend.value}
                  direction={trend.direction}
                  label={trend.label}
                  isPercentage={trend.isPercentage}
                />
              )}
              {comparison && (
                <span className="text-xs text-gray-500">
                  <span className="font-medium text-gray-700">{comparison.value}</span> {comparison.label}
                </span>
              )}
            </div>
          )}

          {/* Progress Bar */}
          {progress && (
            <ProgressBar
              current={progress.current}
              max={progress.max}
              label={progress.label}
              showPercentage={progress.showPercentage}
              variant={variant}
            />
          )}

          {/* Footer */}
          {footer && <div className="mt-3 pt-3 border-t border-gray-100">{footer}</div>}
        </>
      )}
    </div>
  );
};

export default KpiCard;
