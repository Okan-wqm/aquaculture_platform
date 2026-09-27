/**
 * The pieces every chart primitive shares: the frame that decides between a
 * fixed and a fluid width, the empty face, the axis tick style and the series
 * palette the theme defines. recharts draws; the theme paints.
 */
import React from 'react';
import { ResponsiveContainer } from 'recharts';

import { useI18n } from '../../i18n';
import { chartChrome, chartPalette } from '../../styles/theme';

/** Axis tick typography, read by recharts as SVG text attributes. */
export const AXIS_TICK: Readonly<{ fontSize: number; fill: string }> = Object.freeze({
  fontSize: 12,
  fill: chartChrome.axis,
});

/** The series colour for index `i`: the dataset's own, else the theme palette in order. */
export function seriesColor(own: string | undefined, index: number): string {
  return own ?? chartPalette[index % chartPalette.length]!;
}

export interface ChartFrameProps {
  /** A number fixes the width; undefined fills the parent. */
  width?: number;
  height: number;
  className?: string;
  children: React.ReactElement<{ width?: number; height?: number }>;
}

/** Sizes the chart: fixed when a width is given, the parent's width otherwise. */
export const ChartFrame: React.FC<ChartFrameProps> = ({
  width,
  height,
  className = '',
  children,
}) => {
  if (width === undefined) {
    return (
      <div className={`relative ${className}`} style={{ height }}>
        <ResponsiveContainer width="100%" height={height}>
          {children}
        </ResponsiveContainer>
      </div>
    );
  }
  return (
    <div className={`relative ${className}`} style={{ width, height }}>
      {React.cloneElement(children, { width, height })}
    </div>
  );
};

export interface NoDataProps {
  width?: number;
  height: number;
  className?: string;
}

/** The face a chart shows for an empty series. */
export const NoData: React.FC<NoDataProps> = ({ width, height, className = '' }) => {
  const { t } = useI18n();
  return (
    <div
      className={`flex items-center justify-center ${className}`}
      style={{ width, height }}
      data-testid="chart-no-data"
    >
      <span className="text-sm text-gray-500 dark:text-gray-400">{t('chart.noData')}</span>
    </div>
  );
};
