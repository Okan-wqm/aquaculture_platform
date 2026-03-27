/**
 * VfdGroupWidget - Shows multiple VFDs in a compact grid.
 *
 * Used for pump station overview with total/average calculations.
 * Each mini card shows name, status, frequency/fault, and current.
 * Faulted VFDs are highlighted with a red border.
 */

import React, { memo, useMemo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import type { VfdParameters, VfdStatusBits } from '../../../types/vfd.types';

/* ------------------------------------------------------------------ */
/*  VFD card data interface                                            */
/* ------------------------------------------------------------------ */

interface VfdCardData {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'fault' | 'warning' | 'offline';
  frequency: number;
  current: number;
  power: number;
  faultCode?: number;
}

/* ------------------------------------------------------------------ */
/*  Status LED colors                                                  */
/* ------------------------------------------------------------------ */

const LED_COLORS: Record<string, string> = {
  running: '#22c55e',
  stopped: '#9ca3af',
  fault:   '#ef4444',
  warning: '#eab308',
  offline: '#6b7280',
};

/* ------------------------------------------------------------------ */
/*  Demo data for builder preview                                      */
/* ------------------------------------------------------------------ */

const DEMO_DEVICES: VfdCardData[] = [
  { id: '1', name: 'VFD#1', status: 'running', frequency: 45.0, current: 12.3, power: 5.2 },
  { id: '2', name: 'VFD#2', status: 'running', frequency: 50.0, current: 10.1, power: 4.8 },
  { id: '3', name: 'VFD#3', status: 'fault', frequency: 0, current: 0, power: 0, faultCode: 23 },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const VfdGroupWidget: React.FC<WidgetRendererProps> = ({
  config,
  width,
  height,
  isEditing,
}) => {
  const title = (config.groupTitle as string) || (config.label as string) || 'Pump Station VFDs';

  /* ---- Resolve device data ---- */
  const devices: VfdCardData[] = useMemo(() => {
    if (isEditing) return DEMO_DEVICES;

    const raw = config.devices as VfdCardData[] | undefined;
    if (Array.isArray(raw) && raw.length > 0) return raw;
    return [];
  }, [isEditing, config.devices]);

  /* ---- Aggregate calculations ---- */
  const totalPower = useMemo(
    () => devices.reduce((sum, d) => sum + (d.power || 0), 0),
    [devices],
  );

  const avgFrequency = useMemo(() => {
    const running = devices.filter((d) => d.status === 'running');
    if (running.length === 0) return 0;
    return running.reduce((sum, d) => sum + d.frequency, 0) / running.length;
  }, [devices]);

  /* ---- Grid layout ---- */
  const cols = devices.length <= 3 ? devices.length : Math.min(4, devices.length);
  const cardW = 90;
  const cardH = 60;
  const gapX = 8;
  const gapY = 8;
  const headerH = 28;
  const footerH = 22;
  const gridStartX = 10;
  const gridStartY = headerH + 6;

  const totalVbW = Math.max(260, gridStartX * 2 + cols * (cardW + gapX) - gapX);
  const rows = Math.ceil(devices.length / cols) || 1;
  const totalVbH = gridStartY + rows * (cardH + gapY) - gapY + footerH + 10;

  return (
    <div
      style={{ width, height, position: 'relative' }}
      data-testid="vfd-group-widget"
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${totalVbW} ${totalVbH}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
      >
        {/* Background */}
        <rect x={1} y={1} width={totalVbW - 2} height={totalVbH - 2} rx={6} fill="#f8fafc" stroke="#d1d5db" strokeWidth={1.5} />

        {/* Title */}
        <text x={12} y={20} fontSize={12} fontWeight={700} fill="#374151">{title}</text>

        {/* VFD cards */}
        {devices.map((device, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const x = gridStartX + col * (cardW + gapX);
          const y = gridStartY + row * (cardH + gapY);
          const isFault = device.status === 'fault';

          return (
            <g key={device.id} data-testid={`vfd-group-card-${device.id}`}>
              {/* Card background */}
              <rect
                x={x} y={y} width={cardW} height={cardH} rx={4}
                fill="#fff"
                stroke={isFault ? '#ef4444' : '#e5e7eb'}
                strokeWidth={isFault ? 2 : 1}
              />
              {/* Name + LED */}
              <text x={x + 6} y={y + 14} fontSize={9} fontWeight={600} fill="#374151">
                {device.name}
              </text>
              <circle cx={x + cardW - 10} cy={y + 10} r={3.5} fill={LED_COLORS[device.status] || '#9ca3af'} />

              {/* Main value row */}
              {isFault ? (
                <>
                  <text x={x + 6} y={y + 30} fontSize={10} fontWeight={700} fill="#ef4444">FAULT</text>
                  {device.faultCode !== undefined && (
                    <text x={x + 6} y={y + 44} fontSize={9} fill="#ef4444">
                      F{String(device.faultCode).padStart(3, '0')}
                    </text>
                  )}
                </>
              ) : (
                <>
                  <text x={x + 6} y={y + 32} fontSize={10} fontWeight={600} fill="#111827">
                    {device.frequency.toFixed(1)} Hz
                  </text>
                  <text x={x + 6} y={y + 46} fontSize={9} fill="#6b7280">
                    {device.current.toFixed(1)} A
                  </text>
                </>
              )}
            </g>
          );
        })}

        {/* Empty state */}
        {devices.length === 0 && (
          <text x={totalVbW / 2} y={gridStartY + 30} textAnchor="middle" fontSize={10} fill="#9ca3af">
            No VFD devices configured
          </text>
        )}

        {/* Footer: aggregates */}
        {devices.length > 0 && (
          <g transform={`translate(0, ${gridStartY + rows * (cardH + gapY) - gapY + 8})`}>
            <line x1={10} y1={0} x2={totalVbW - 10} y2={0} stroke="#e5e7eb" strokeWidth={1} />
            <text x={12} y={16} fontSize={9} fill="#6b7280">
              Total Power: {totalPower.toFixed(1)} kW
            </text>
            <text x={totalVbW - 12} y={16} textAnchor="end" fontSize={9} fill="#6b7280">
              Avg Freq: {avgFrequency.toFixed(1)} Hz
            </text>
          </g>
        )}
      </svg>
    </div>
  );
};

VfdGroupWidget.displayName = 'VfdGroupWidget';
export default memo(VfdGroupWidget);
