/**
 * One sensor on /sensor/readings: every enabled channel as a value tile, plus
 * the multi-parameter trend for the selected period (SENSOR-HIGH-138). All
 * values come from channelLatestValues / channelSeries — nothing is invented
 * client-side.
 */
import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Clock, Radio, Server, Wifi, WifiOff } from 'lucide-react';

import { MultiParameterTrendCard } from '../charts/MultiParameterTrendCard';
import type { ChannelLatestValue } from '../../graphql/channelReadings';
import type { RegisteredSensor } from '../../hooks/useSensorList';
import {
  ALERT_LABELS,
  formatAge,
  formatValue,
  freshness,
  lastReportedAt,
  unitOf,
  type Freshness,
} from './readingsModel';
import type { TimeRangeSpec } from '@aquaculture/shared-contracts';
import type { ChannelDataBounds } from '../../graphql/channelReadings';

const TILE_TONE: Readonly<Record<'NORMAL' | 'WARNING' | 'CRITICAL' | 'NONE', string>> = {
  NORMAL: 'border-gray-100 dark:border-gray-700',
  WARNING: 'border-warning-300 dark:border-warning-700 bg-warning-50/40 dark:bg-warning-900/10',
  CRITICAL: 'border-error-300 dark:border-error-700 bg-error-50/40 dark:bg-error-900/10',
  NONE: 'border-dashed border-gray-200 dark:border-gray-700',
};

const BADGE_TONE: Readonly<Record<'NORMAL' | 'WARNING' | 'CRITICAL', string>> = {
  NORMAL: 'bg-success-100 text-success-700 dark:bg-success-900/40 dark:text-success-300',
  WARNING: 'bg-warning-100 text-warning-700 dark:bg-warning-900/40 dark:text-warning-300',
  CRITICAL: 'bg-error-100 text-error-700 dark:bg-error-900/40 dark:text-error-300',
};

const FRESHNESS_BADGE: Readonly<Record<Freshness, { label: string; className: string }>> = {
  live: {
    label: 'Veri akıyor',
    className: 'bg-success-100 text-success-700 dark:bg-success-900/40 dark:text-success-300',
  },
  stale: {
    label: 'Veri gelmiyor',
    className: 'bg-warning-100 text-warning-700 dark:bg-warning-900/40 dark:text-warning-300',
  },
  none: {
    label: 'Hiç veri yok',
    className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  },
};

export const ChannelTile: React.FC<{ channel: ChannelLatestValue; now: number }> = ({
  channel,
  now,
}) => {
  const tone = channel.alertLevel ?? 'NONE';
  return (
    <div
      className={`rounded-lg border p-3 ${TILE_TONE[tone]}`}
      data-testid={`channel-tile-${channel.channelKey}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
          {channel.displayLabel}
        </p>
        {channel.alertLevel && (
          <span
            className={`px-1.5 py-0.5 rounded text-xs font-medium ${BADGE_TONE[channel.alertLevel]}`}
          >
            {ALERT_LABELS[channel.alertLevel]}
          </span>
        )}
      </div>
      <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">
        {formatValue(channel)}{' '}
        <span className="text-sm font-normal text-gray-500 dark:text-gray-400">
          {unitOf(channel)}
        </span>
      </p>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {formatAge(channel.time, now)}
      </p>
    </div>
  );
};

export interface SensorReadingsCardProps {
  sensor: RegisteredSensor;
  channels: readonly ChannelLatestValue[];
  /** The range every card charts, owned by the page. */
  range: TimeRangeSpec;
  /** First and last stored sample per channel id (the page's bounds query). */
  bounds: ReadonlyMap<string, ChannelDataBounds>;
  onShowRange: (range: TimeRangeSpec) => void;
  now: number;
  defaultExpanded?: boolean;
}

export const SensorReadingsCard: React.FC<SensorReadingsCardProps> = ({
  sensor,
  channels,
  range,
  bounds,
  onShowRange,
  now,
  defaultExpanded = true,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  // The jump goes to the last sample of the channels shown (the parameter
  // filter applies), not of a sibling the chart does not draw.
  const lastSampleAt = useMemo(() => {
    const instants = channels.flatMap((channel) => {
      const last = bounds.get(channel.channelId)?.lastSampleAt;
      return last ? [new Date(last).getTime()] : [];
    });
    return instants.length > 0 ? Math.max(...instants) : null;
  }, [channels, bounds]);
  const lastAt = lastReportedAt(channels);
  const state = freshness(lastAt, now);
  const topic = sensor.protocolConfiguration?.['topic'];

  return (
    <section className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-4 p-4 text-left hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="w-5 h-5 text-gray-500 dark:text-gray-400" />
        ) : (
          <ChevronRight className="w-5 h-5 text-gray-500 dark:text-gray-400" />
        )}
        <div className="p-2 bg-info-50 dark:bg-info-900/20 rounded-lg">
          <Server className="w-5 h-5 text-info-600 dark:text-info-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100 truncate">
              {sensor.name}
            </h3>
            <span
              className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${FRESHNESS_BADGE[state].className}`}
            >
              {state === 'live' ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              {FRESHNESS_BADGE[state].label}
            </span>
          </div>
          {typeof topic === 'string' && topic.length > 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400 font-mono truncate mt-0.5">
              <Radio className="w-3 h-3 inline mr-1" />
              {topic}
            </p>
          )}
        </div>
        <div className="hidden sm:flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
          <span>{channels.length} kanal</span>
          <span className="flex items-center gap-1">
            <Clock className="w-4 h-4" />
            {lastAt === null ? 'Veri yok' : formatAge(new Date(lastAt).toISOString(), now)}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 dark:border-gray-700 p-4 space-y-4">
          {channels.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-6">
              Bu cihazda etkin veri kanalı tanımlı değil.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
                {channels.map((channel) => (
                  <ChannelTile key={channel.channelId} channel={channel} now={now} />
                ))}
              </div>
              <MultiParameterTrendCard
                sensorId={sensor.id}
                sensorName={sensor.name}
                range={range}
                lastSampleAt={lastSampleAt}
                onShowRange={onShowRange}
                channels={channels.map((channel) => ({
                  channelKey: channel.channelKey,
                  displayLabel: channel.displayLabel,
                  unit: unitOf(channel) || undefined,
                }))}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
};
