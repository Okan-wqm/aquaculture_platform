/**
 * Card Bileşeni
 * İçerik kartları için yeniden kullanılabilir konteyner
 * Başlık, alt başlık, footer ve çeşitli stil seçenekleri sunar
 */

import React, { HTMLAttributes, forwardRef } from 'react';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Kart başlığı */
  title?: React.ReactNode;
  /** Alt başlık */
  subtitle?: React.ReactNode;
  /** Sağ üst köşe aksiyonları */
  headerAction?: React.ReactNode;
  /** Alt kısım içeriği */
  footer?: React.ReactNode;
  /** Padding boyutu */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Gölge seviyesi */
  shadow?: 'none' | 'sm' | 'md' | 'lg';
  /** Kenarlık */
  bordered?: boolean;
  /** Hover efekti */
  hoverable?: boolean;
  /** Seçili durumu */
  selected?: boolean;
  /** Yükleniyor durumu */
  isLoading?: boolean;
}

// ============================================================================
// Stil Sınıfları
// ============================================================================

const paddingStyles = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
};

const shadowStyles = {
  none: '',
  sm: 'shadow-sm',
  md: 'shadow-md',
  lg: 'shadow-lg',
};

// ============================================================================
// Loading Skeleton Bileşeni
// ============================================================================

const CardSkeleton: React.FC = () => (
  <div className="animate-pulse">
    <div className="h-4 bg-gray-200 rounded w-3/4 mb-4"></div>
    <div className="space-y-3">
      <div className="h-3 bg-gray-200 rounded"></div>
      <div className="h-3 bg-gray-200 rounded w-5/6"></div>
      <div className="h-3 bg-gray-200 rounded w-4/6"></div>
    </div>
  </div>
);

// ============================================================================
// Card Bileşeni
// ============================================================================

/**
 * Card bileşeni
 *
 * @example
 * // Temel kullanım
 * <Card>
 *   <p>Kart içeriği</p>
 * </Card>
 *
 * @example
 * // Başlık ve aksiyonlar ile
 * <Card
 *   title="Sensör Verileri"
 *   subtitle="Son 24 saat"
 *   headerAction={<Button size="sm">Detaylar</Button>}
 * >
 *   <SensorChart />
 * </Card>
 *
 * @example
 * // Footer ile
 * <Card
 *   title="Çiftlik Özeti"
 *   footer={<Button fullWidth>Tümünü Gör</Button>}
 * >
 *   <FarmStats />
 * </Card>
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(
  (
    {
      title,
      subtitle,
      headerAction,
      footer,
      padding = 'md',
      shadow = 'sm',
      bordered = true,
      hoverable = false,
      selected = false,
      isLoading = false,
      className = '',
      children,
      ...props
    },
    ref
  ) => {
    // Temel stil sınıfları
    const baseStyles = `
      bg-white rounded-lg
      ${shadowStyles[shadow]}
      ${bordered ? 'border border-gray-200' : ''}
      ${hoverable ? 'hover:shadow-md transition-shadow duration-200 cursor-pointer' : ''}
      ${selected ? 'ring-2 ring-blue-500 border-blue-500' : ''}
    `;

    // Header var mı kontrolü
    const hasHeader = title || subtitle || headerAction;

    return (
      <div
        ref={ref}
        className={`${baseStyles} ${className}`.trim()}
        {...props}
      >
        {/* Kart Başlığı */}
        {hasHeader && (
          <div
            className={`
              flex items-start justify-between
              ${padding !== 'none' ? paddingStyles[padding] : 'px-4 py-3'}
              ${children || footer ? 'border-b border-gray-100' : ''}
            `}
          >
            <div className="flex-1 min-w-0">
              {title && (
                <h3 className="text-lg font-semibold text-gray-900 truncate">
                  {title}
                </h3>
              )}
              {subtitle && (
                <p className="mt-1 text-sm text-gray-500">{subtitle}</p>
              )}
            </div>
            {headerAction && (
              <div className="flex-shrink-0 ml-4">{headerAction}</div>
            )}
          </div>
        )}

        {/* Kart İçeriği */}
        {(children || isLoading) && (
          <div className={paddingStyles[padding]}>
            {isLoading ? <CardSkeleton /> : children}
          </div>
        )}

        {/* Kart Footer */}
        {footer && (
          <div
            className={`
              ${paddingStyles[padding]}
              border-t border-gray-100
              bg-gray-50 rounded-b-lg
            `}
          >
            {footer}
          </div>
        )}
      </div>
    );
  }
);

Card.displayName = 'Card';

// ============================================================================
// CardGrid Bileşeni - Kartları grid düzeninde gösterir
// ============================================================================

export interface CardGridProps {
  children: React.ReactNode;
  /** Sütun sayısı */
  columns?: 1 | 2 | 3 | 4;
  /** Boşluk */
  gap?: 'sm' | 'md' | 'lg';
  className?: string;
}

const columnStyles = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 md:grid-cols-2',
  3: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
};

const gapStyles = {
  sm: 'gap-3',
  md: 'gap-4',
  lg: 'gap-6',
};

/**
 * CardGrid - Kartları grid düzeninde gösterir
 *
 * @example
 * <CardGrid columns={3} gap="md">
 *   <Card title="Kart 1">İçerik</Card>
 *   <Card title="Kart 2">İçerik</Card>
 *   <Card title="Kart 3">İçerik</Card>
 * </CardGrid>
 */
export const CardGrid: React.FC<CardGridProps> = ({
  children,
  columns = 3,
  gap = 'md',
  className = '',
}) => {
  return (
    <div className={`grid ${columnStyles[columns]} ${gapStyles[gap]} ${className}`}>
      {children}
    </div>
  );
};

// ============================================================================
// MetricCard Bileşeni - Metrik gösterimi için özelleştirilmiş kart
// ============================================================================

export interface MetricCardProps {
  /** Metrik etiketi */
  label?: string;
  /** Metrik etiketi (alias for label) */
  title?: string;
  /** Metrik değeri */
  value: string | number;
  /** Birim */
  unit?: string;
  /** Değişim yüzdesi */
  change?: number;
  /** Değişim yönü veya sayısal değer */
  trend?: 'up' | 'down' | 'neutral' | number;
  /** Trend etiketi (örn: "bu hafta", "dünden") */
  trendLabel?: string;
  /** Ikon */
  icon?: React.ReactNode;
  /** Tıklama işleyicisi */
  onClick?: () => void;
  /** Ek CSS sınıfları */
  className?: string;
}

/**
 * MetricCard - Sayısal metrikleri göstermek için özelleştirilmiş kart
 *
 * @example
 * <MetricCard
 *   label="Toplam Çiftlik"
 *   value={24}
 *   change={12}
 *   trend="up"
 *   icon={<FarmIcon />}
 * />
 */
export const MetricCard: React.FC<MetricCardProps> = ({
  label,
  title,
  value,
  unit,
  change,
  trend: trendProp = 'neutral',
  icon,
  onClick,
  className = '',
}) => {
  // label ve title birleştir
  const displayLabel = label || title || '';

  // trend sayısal değer olabilir - dönüştür
  const trend: 'up' | 'down' | 'neutral' = typeof trendProp === 'number'
    ? trendProp > 0 ? 'up' : trendProp < 0 ? 'down' : 'neutral'
    : trendProp;

  const trendColors = {
    up: 'text-green-600',
    down: 'text-red-600',
    neutral: 'text-gray-600',
  };

  const trendIcons = {
    up: '↑',
    down: '↓',
    neutral: '→',
  };

  return (
    <Card
      hoverable={!!onClick}
      onClick={onClick}
      className={className}
      padding="md"
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-500">{displayLabel}</p>
          <div className="mt-2 flex items-baseline">
            <span className="text-3xl font-bold text-gray-900">{value}</span>
            {unit && <span className="ml-1 text-sm text-gray-500">{unit}</span>}
          </div>
          {change !== undefined && (
            <p className={`mt-2 text-sm ${trendColors[trend]}`}>
              <span className="mr-1">{trendIcons[trend]}</span>
              {Math.abs(change)}%
              <span className="ml-1 text-gray-500">son 30 günde</span>
            </p>
          )}
        </div>
        {icon && (
          <div className="flex-shrink-0 p-3 bg-blue-50 rounded-lg text-blue-600">
            {icon}
          </div>
        )}
      </div>
    </Card>
  );
};

export default Card;
