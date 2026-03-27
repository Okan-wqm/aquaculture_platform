/**
 * VfdMiniWidget - Compact 120x80 VFD widget for dashboards and overview screens.
 *
 * Shows: device name, status LED, frequency, current, speed.
 * Click navigates to full VFD programming page or expands to full widget.
 */

import React, { memo, useMemo, useCallback, useEffect } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import { useVfdRealtimeReadings, getVfdStatus } from '../../../hooks/useVfdReadings';
import type { VfdParameters, VfdStatusBits } from '../../../types/vfd.types';

/* ------------------------------------------------------------------ */
/*  Status LED colors                                                  */
/* ------------------------------------------------------------------ */

const LED_COLORS: Record<string, string> = {
  running: '#22c55e',
  ready:   '#3b82f6',
  fault:   '#ef4444',
  warning: '#eab308',
  stopped: '#9ca3af',
};

/* ------------------------------------------------------------------ */
/*  Demo data for edit mode                                            */
/* ------------------------------------------------------------------ */

const DEMO_PARAMS: VfdParameters = {
  outputFrequency: 45.0,
  motorCurrent: 12.3,
  motorSpeed: 1350,
};

const DEMO_STATUS: VfdStatusBits = {
  ready: true,
  running: true,
  fault: false,
  warning: false,
  atSetpoint: true,
  atReference: true,
  direction: 'forward',
  remoteControl: true,
  localControl: false,
  autoMode: true,
  manualMode: false,
  currentLimit: false,
  voltageLimit: false,
  torqueLimit: false,
  speedLimit: false,
  enabled: true,
  quickStopActive: false,
  switchOnDisabled: false,
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const VfdMiniWidget: React.FC<WidgetRendererProps> = ({
  config,
  width,
  height,
  isEditing,
  onCommand,
}) => {
  const vfdDeviceId = config.vfdDeviceId as string | undefined;
  const displayName = (config.displayName as string) || (config.label as string) || 'VFD';

  const { reading } = useVfdRealtimeReadings(
    isEditing ? undefined : vfdDeviceId,
    { enabled: !isEditing && Boolean(vfdDeviceId), pollInterval: 3000 },
  );

  const params = useMemo<VfdParameters>(() => {
    if (isEditing || !reading) return DEMO_PARAMS;
    return reading.parameters;
  }, [isEditing, reading]);

  const statusBits = useMemo<VfdStatusBits | undefined>(() => {
    if (isEditing) return DEMO_STATUS;
    return reading?.statusBits;
  }, [isEditing, reading]);

  const { status, color } = useMemo(() => getVfdStatus(statusBits), [statusBits]);
  const ledColor = LED_COLORS[status] || '#9ca3af';

  const handleClick = useCallback(() => {
    if (!isEditing && onCommand) {
      onCommand('vfd:navigate', vfdDeviceId);
    }
  }, [isEditing, onCommand, vfdDeviceId]);

  const freq = (params.outputFrequency ?? 0).toFixed(1);
  const current = (params.motorCurrent ?? 0).toFixed(1);
  const speed = (params.motorSpeed ?? 0).toFixed(0);

  return (
    <div
      style={{
        width,
        height,
        cursor: isEditing ? 'default' : 'pointer',
        position: 'relative',
      }}
      onClick={handleClick}
      data-testid="vfd-mini-widget"
    >
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 160 70"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
      >
        {/* Background */}
        <rect x={1} y={1} width={158} height={68} rx={5} fill="#f8fafc" stroke="#d1d5db" strokeWidth={1.5} />

        {/* Top row: name + LED + frequency */}
        <text x={8} y={18} fontSize={11} fontWeight={600} fill="#374151">{displayName}</text>
        <circle cx={132} cy={14} r={4} fill={ledColor} data-testid="vfd-mini-led" />
        <text x={152} y={18} textAnchor="end" fontSize={10} fontWeight={700} fill="#111827">{freq}Hz</text>

        {/* Bottom row: current + speed */}
        <text x={8} y={46} fontSize={9.5} fill="#6b7280">{current}A</text>
        <text x={60} y={46} fontSize={9.5} fill="#6b7280">{speed}RPM</text>

        {/* Status bar */}
        <rect x={4} y={56} width={152} height={3} rx={1.5} fill="#e5e7eb" />
        <rect
          x={4} y={56}
          width={status === 'running' ? 152 : status === 'ready' ? 76 : 0}
          height={3} rx={1.5} fill={ledColor}
          style={{ transition: 'width 300ms ease-out' }}
        />
      </svg>
    </div>
  );
};

VfdMiniWidget.displayName = 'VfdMiniWidget';
export default memo(VfdMiniWidget);
