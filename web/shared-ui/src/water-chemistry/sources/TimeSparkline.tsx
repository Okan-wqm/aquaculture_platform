/**
 * A trend drawn by time: each point where its bucket falls, a gap where the
 * channel was silent (a null point breaks the line), and the unit it is in
 * named beside it — a channel's trend is in the channel's unit, which may not
 * be the parameter's.
 */
import React from 'react';
import { Line, LineChart, XAxis, YAxis } from 'recharts';

export interface TrendPoint {
  /** Bucket time (ms). */
  readonly t: number;
  /** The bucket's value; null marks a gap. */
  readonly v: number | null;
}

export interface TimeSparklineProps {
  points: readonly TrendPoint[];
  /** The window the trend spans (ms), so a silent stretch at either end shows as space. */
  start: number;
  end: number;
  color: string;
  /** e.g. "last 24 h, in °F". */
  caption: string;
  width?: number;
  height?: number;
}

export const TimeSparkline: React.FC<TimeSparklineProps> = ({
  points,
  start,
  end,
  color,
  caption,
  width = 160,
  height = 28,
}) => (
  <figure className="mt-1" data-testid="time-sparkline">
    <LineChart
      width={width}
      height={height}
      data={[...points]}
      margin={{ top: 2, right: 2, bottom: 2, left: 2 }}
    >
      <XAxis dataKey="t" type="number" domain={[start, end]} hide />
      <YAxis type="number" domain={['auto', 'auto']} hide />
      <Line
        dataKey="v"
        stroke={color}
        strokeWidth={1.5}
        dot={false}
        connectNulls={false}
        isAnimationActive={false}
      />
    </LineChart>
    <figcaption className="text-[10px] text-gray-400 dark:text-gray-500">{caption}</figcaption>
  </figure>
);
