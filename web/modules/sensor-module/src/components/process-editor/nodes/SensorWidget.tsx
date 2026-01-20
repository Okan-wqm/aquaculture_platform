/**
 * SensorWidget - Live Sensor Data Visualization Node
 *
 * Features:
 * - MQTT Push mode (WebSocket real-time)
 * - HTTP Poll mode (interval-based)
 * - HTTP onChange mode (ETag-based conditional)
 * - Gauge/bar visualization (300x200px)
 * - Threshold indicators (low/high)
 * - Configurable scale and units
 *
 * This is a read-only display node - no state management needed
 */

import React, { useState, useEffect, useRef } from 'react';
import type { NodeProps } from 'reactflow';

/* -------------------------------------------------- */
/*  Types                                             */
/* -------------------------------------------------- */
export interface SensorWidgetData {
  label?: string;
  widgetName?: string;
  subtitle?: string;
  unit?: string;
  value?: number | string;
  scaleMax?: number;
  lowThreshold?: number;
  highThreshold?: number;
  mode?: 'push' | 'poll' | 'onChange';
  mqttUrl?: string;
  mqttTopic?: string;
  httpUrl?: string;
  pollInterval?: number;
}

/* -------------------------------------------------- */
/*  Constants                                         */
/* -------------------------------------------------- */
const W = 300;
const H = 200;
const BAR_WIDTH = 160;
const BAR_X = (W - BAR_WIDTH) / 2;
const BAR_Y = 140;
const BAR_HEIGHT = 12;

/* -------------------------------------------------- */
/*  Component                                         */
/* -------------------------------------------------- */
const SensorWidget: React.FC<NodeProps<SensorWidgetData>> = ({ data, selected }) => {
  const [value, setValue] = useState<number>(Number(data.value) || 0);
  const etagRef = useRef<string>('');

  /* ---------- MQTT Push Mode ----------------------- */
  useEffect(() => {
    if (data.mode !== 'push' || !data.mqttUrl || !data.mqttTopic) return;

    let client: any = null;

    // Dynamic import mqtt to avoid build issues if not installed
    const connectMqtt = async () => {
      try {
        const mqtt = await import('mqtt');
        client = mqtt.connect(data.mqttUrl!, {
          protocol: 'ws',
          reconnectPeriod: 2000,
        });

        client.on('connect', () => {
          client.subscribe(data.mqttTopic!);
        });

        client.on('message', (_: string, msg: Buffer) => {
          const num = parseFloat(msg.toString());
          setValue(isNaN(num) ? 0 : num);
        });
      } catch (err) {
        console.warn('MQTT not available:', err);
      }
    };

    connectMqtt();

    return () => {
      if (client) {
        client.end();
      }
    };
  }, [data.mode, data.mqttUrl, data.mqttTopic]);

  /* ---------- HTTP Poll Mode ----------------------- */
  useEffect(() => {
    if (data.mode !== 'poll' || !data.httpUrl) return;

    let cancelled = false;

    const fetchData = async () => {
      try {
        const res = await fetch(data.httpUrl!);
        const json = await res.json();
        const raw = json.field1 ?? json.value ?? json;
        const num = typeof raw === 'number' ? raw : parseFloat(String(raw));
        if (!cancelled) setValue(isNaN(num) ? 0 : num);
      } catch (err) {
        console.error('HTTP Poll error:', err);
      }
    };

    fetchData();
    const intervalId = setInterval(fetchData, (data.pollInterval ?? 5) * 1000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [data.mode, data.httpUrl, data.pollInterval]);

  /* ---------- HTTP onChange Mode ------------------- */
  useEffect(() => {
    if (data.mode !== 'onChange' || !data.httpUrl) return;

    let cancelled = false;

    const checkForChanges = async () => {
      try {
        const headers: HeadersInit = etagRef.current
          ? { 'If-None-Match': etagRef.current }
          : {};

        const res = await fetch(data.httpUrl!, { headers });

        // Not modified
        if (res.status === 304) return;

        etagRef.current = res.headers.get('ETag') ?? etagRef.current;
        const json = await res.json();
        const raw = json.field1 ?? json.value ?? json;
        const num = typeof raw === 'number' ? raw : parseFloat(String(raw));
        if (!cancelled) setValue(isNaN(num) ? 0 : num);
      } catch (err) {
        console.error('HTTP onChange error:', err);
      }
    };

    checkForChanges();
    const intervalId = setInterval(checkForChanges, (data.pollInterval ?? 10) * 1000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [data.mode, data.httpUrl, data.pollInterval]);

  /* ---------- Calculate visual values -------------- */
  const scaleMax = data.scaleMax ?? 100;
  const percentage = Math.min(100, Math.max(0, (value / scaleMax) * 100));
  const fillWidth = (BAR_WIDTH * percentage) / 100;

  const lowThreshold = data.lowThreshold ?? 25;
  const highThreshold = data.highThreshold ?? 75;
  const lowX = BAR_X + BAR_WIDTH * (lowThreshold / 100);
  const highX = BAR_X + BAR_WIDTH * (highThreshold / 100);

  const displayValue = value.toFixed(2);
  const title = data.label || data.widgetName || 'Sensor';
  const subtitle = data.subtitle?.trim() || `0 - ${scaleMax}`;

  // Color based on thresholds
  let fillColor = '#22c55e'; // green - normal
  if (percentage < lowThreshold) {
    fillColor = '#3b82f6'; // blue - low
  } else if (percentage > highThreshold) {
    fillColor = '#ef4444'; // red - high
  }

  /* ---------- Render ------------------------------- */
  return (
    <div
      style={{
        background: 'white',
        borderRadius: 8,
        border: selected ? '2px solid #3b82f6' : '2px solid #e5e7eb',
        boxShadow: selected ? '0 0 0 2px rgba(59, 130, 246, 0.3)' : '0 1px 3px rgba(0,0,0,0.1)',
        overflow: 'hidden',
      }}
    >
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
      >
        {/* Background gradient */}
        <defs>
          <linearGradient id="barGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={fillColor} stopOpacity={0.8} />
            <stop offset="100%" stopColor={fillColor} stopOpacity={1} />
          </linearGradient>
        </defs>

        {/* Header background */}
        <rect x="0" y="0" width={W} height="55" fill="#f8fafc" />

        {/* Title */}
        <text
          x="50%"
          y="35"
          textAnchor="middle"
          style={{
            fontSize: 16,
            fontWeight: 600,
            fill: '#1f2937',
          }}
        >
          {title}
        </text>

        {/* Value display */}
        <text
          x="50%"
          y="95"
          textAnchor="middle"
          style={{
            fontSize: 36,
            fontWeight: 700,
            fill: '#111827',
          }}
        >
          {displayValue}
        </text>

        {/* Unit */}
        <text
          x="50%"
          y="118"
          textAnchor="middle"
          style={{
            fontSize: 14,
            fill: '#6b7280',
          }}
        >
          {data.unit || ''}
        </text>

        {/* Bar background */}
        <rect
          x={BAR_X}
          y={BAR_Y}
          width={BAR_WIDTH}
          height={BAR_HEIGHT}
          rx={4}
          fill="#e5e7eb"
        />

        {/* Bar fill */}
        <rect
          x={BAR_X}
          y={BAR_Y}
          width={fillWidth}
          height={BAR_HEIGHT}
          rx={4}
          fill="url(#barGradient)"
        />

        {/* Low threshold marker */}
        <line
          x1={lowX}
          y1={BAR_Y - 2}
          x2={lowX}
          y2={BAR_Y + BAR_HEIGHT + 2}
          stroke="#3b82f6"
          strokeWidth={2}
          strokeDasharray="2,2"
        />

        {/* High threshold marker */}
        <line
          x1={highX}
          y1={BAR_Y - 2}
          x2={highX}
          y2={BAR_Y + BAR_HEIGHT + 2}
          stroke="#ef4444"
          strokeWidth={2}
          strokeDasharray="2,2"
        />

        {/* Scale subtitle */}
        <text
          x="50%"
          y="175"
          textAnchor="middle"
          style={{
            fontSize: 12,
            fill: '#9ca3af',
          }}
        >
          {subtitle}
        </text>

        {/* Mode indicator */}
        <circle
          cx={20}
          cy={20}
          r={6}
          fill={data.mode ? '#22c55e' : '#9ca3af'}
        />
        <text
          x={32}
          y={24}
          style={{
            fontSize: 10,
            fill: '#6b7280',
          }}
        >
          {data.mode || 'static'}
        </text>
      </svg>
    </div>
  );
};

export default SensorWidget;
