/**
 * Loading Bileşenleri
 * Yükleme durumları için spinner, skeleton ve overlay bileşenleri
 */

import React from 'react';

// ============================================================================
// Spinner Bileşeni
// ============================================================================

export interface SpinnerProps {
  /** Boyut */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Renk */
  color?: 'primary' | 'white' | 'gray';
  /** Metin */
  text?: string;
  className?: string;
}

const spinnerSizes = {
  sm: 'w-4 h-4',
  md: 'w-6 h-6',
  lg: 'w-8 h-8',
  xl: 'w-12 h-12',
};

const spinnerColors = {
  primary: 'text-blue-600',
  white: 'text-white',
  gray: 'text-gray-400',
};

/**
 * Spinner bileşeni
 *
 * @example
 * <Spinner size="md" />
 * <Spinner size="lg" text="Yükleniyor..." />
 */
export const Spinner: React.FC<SpinnerProps> = ({
  size = 'md',
  color = 'primary',
  text,
  className = '',
}) => {
  return (
    <div className={`inline-flex items-center ${className}`}>
      <svg
        className={`animate-spin ${spinnerSizes[size]} ${spinnerColors[color]}`}
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
      {text && <span className="ml-2 text-sm text-gray-600">{text}</span>}
    </div>
  );
};

// ============================================================================
// Loading Overlay Bileşeni
// ============================================================================

export interface LoadingOverlayProps {
  /** Görünür mü */
  visible: boolean;
  /** Yükleme metni */
  text?: string;
  /** Tam sayfa mı (yoksa parent relative olmalı) */
  fullScreen?: boolean;
  /** Arka plan şeffaflığı */
  opacity?: 'light' | 'medium' | 'dark';
  className?: string;
}

const overlayOpacity = {
  light: 'bg-white/60',
  medium: 'bg-white/80',
  dark: 'bg-gray-900/50',
};

/**
 * Loading Overlay bileşeni
 *
 * @example
 * // Relative container içinde
 * <div className="relative">
 *   <Content />
 *   <LoadingOverlay visible={isLoading} text="Kaydediliyor..." />
 * </div>
 *
 * @example
 * // Tam sayfa
 * <LoadingOverlay visible={isLoading} fullScreen text="Sayfa yükleniyor..." />
 */
export const LoadingOverlay: React.FC<LoadingOverlayProps> = ({
  visible,
  text = 'Yükleniyor...',
  fullScreen = false,
  opacity = 'medium',
  className = '',
}) => {
  if (!visible) return null;

  return (
    <div
      className={`
        ${fullScreen ? 'fixed inset-0 z-50' : 'absolute inset-0'}
        flex items-center justify-center
        ${overlayOpacity[opacity]}
        ${className}
      `}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center space-y-3">
        <Spinner size="lg" color={opacity === 'dark' ? 'white' : 'primary'} />
        <p className={`text-sm font-medium ${opacity === 'dark' ? 'text-white' : 'text-gray-700'}`}>
          {text}
        </p>
      </div>
    </div>
  );
};

// ============================================================================
// Skeleton Bileşenleri
// ============================================================================

export interface SkeletonProps {
  /** Genişlik */
  width?: string | number;
  /** Yükseklik */
  height?: string | number;
  /** Yuvarlak mı */
  circle?: boolean;
  /** Yuvarlak köşe */
  rounded?: boolean;
  /** Özel CSS stil */
  style?: React.CSSProperties;
  className?: string;
}

/**
 * Skeleton bileşeni
 *
 * @example
 * <Skeleton width={200} height={20} />
 * <Skeleton circle width={40} height={40} />
 */
export const Skeleton: React.FC<SkeletonProps> = ({
  width,
  height,
  circle = false,
  rounded = true,
  style: customStyle,
  className = '',
}) => {
  const style: React.CSSProperties = {
    width: width || '100%',
    height: height || '1rem',
    ...customStyle,
  };

  return (
    <div
      className={`
        animate-pulse bg-gray-200
        ${circle ? 'rounded-full' : rounded ? 'rounded' : ''}
        ${className}
      `}
      style={style}
      aria-hidden="true"
    />
  );
};

/**
 * Metin satırları için skeleton
 */
export interface SkeletonTextProps {
  /** Satır sayısı */
  lines?: number;
  /** Son satır genişliği */
  lastLineWidth?: string;
  /** Satır yüksekliği */
  lineHeight?: number;
  /** Satırlar arası boşluk */
  spacing?: number;
  className?: string;
}

export const SkeletonText: React.FC<SkeletonTextProps> = ({
  lines = 3,
  lastLineWidth = '75%',
  lineHeight = 16,
  spacing = 8,
  className = '',
}) => {
  return (
    <div className={className}>
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton
          key={index}
          height={lineHeight}
          width={index === lines - 1 ? lastLineWidth : '100%'}
          className={index > 0 ? `mt-${spacing / 4}` : ''}
          style={{ marginTop: index > 0 ? spacing : 0 } as React.CSSProperties}
        />
      ))}
    </div>
  );
};

/**
 * Card skeleton
 */
export const SkeletonCard: React.FC<{ className?: string }> = ({ className = '' }) => {
  return (
    <div className={`bg-white rounded-lg shadow p-4 ${className}`}>
      <div className="animate-pulse">
        <Skeleton height={160} className="mb-4" />
        <Skeleton height={20} width="60%" className="mb-2" />
        <SkeletonText lines={2} />
      </div>
    </div>
  );
};

/**
 * Table skeleton
 */
export interface SkeletonTableProps {
  rows?: number;
  columns?: number;
  className?: string;
}

export const SkeletonTable: React.FC<SkeletonTableProps> = ({
  rows = 5,
  columns = 4,
  className = '',
}) => {
  return (
    <div className={`bg-white rounded-lg shadow overflow-hidden ${className}`}>
      <div className="animate-pulse">
        {/* Header */}
        <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
          <div className="flex space-x-4">
            {Array.from({ length: columns }).map((_, i) => (
              <Skeleton key={i} height={16} width={`${100 / columns}%`} />
            ))}
          </div>
        </div>

        {/* Rows */}
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div
            key={rowIndex}
            className="px-4 py-3 border-b border-gray-100 last:border-0"
          >
            <div className="flex space-x-4">
              {Array.from({ length: columns }).map((_, colIndex) => (
                <Skeleton
                  key={colIndex}
                  height={14}
                  width={colIndex === 0 ? '30%' : `${100 / columns}%`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ============================================================================
// Page Loading Bileşeni
// ============================================================================

/**
 * Tam sayfa yükleme durumu
 */
export const PageLoading: React.FC<{ text?: string }> = ({
  text = 'Sayfa yükleniyor...',
}) => {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <Spinner size="xl" />
        <p className="mt-4 text-lg text-gray-600">{text}</p>
      </div>
    </div>
  );
};

export default Spinner;
