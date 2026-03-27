/**
 * VfdDriveWidget - Rich SCADA widget for VFD drive visualization.
 * SVG-based enclosure with brand colors, animated flow, motor rotation,
 * live parameters, quick actions, and fault/warning/offline overlays.
 */
import React, { memo, useMemo, useEffect, useCallback } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import { useVfdRealtimeReadings, getVfdStatus } from '../../../hooks/useVfdReadings';
import type { VfdReading, VfdStatusBits, VfdParameters } from '../../../types/vfd.types';
import { VfdBrand } from '../../../types/vfd.types';

/* ------------------------------------------------------------------ */
/*  CSS keyframes injection (once)                                     */
/* ------------------------------------------------------------------ */

let vfdStyleInjected = false;

function injectVfdStyles(): void {
  if (vfdStyleInjected) return;
  const style = document.createElement('style');
  style.textContent = `
@keyframes vfdFlowPulse {
  0%   { stroke-dashoffset: 0; }
  100% { stroke-dashoffset: -20; }
}
@keyframes vfdMotorSpin {
  0%   { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
@keyframes vfdFaultPulse {
  0%   { opacity: 1; }
  50%  { opacity: 0.4; }
  100% { opacity: 1; }
}
@keyframes vfdProgPulse {
  0%   { stroke-opacity: 0.3; }
  50%  { stroke-opacity: 1; }
  100% { stroke-opacity: 0.3; }
}
`;
  document.head.appendChild(style);
  vfdStyleInjected = true;
}

/* ------------------------------------------------------------------ */
/*  Brand color map                                                    */
/* ------------------------------------------------------------------ */

const BRAND_COLORS: Record<string, { primary: string; accent: string; text: string }> = {
  [VfdBrand.ABB]:        { primary: '#c00', accent: '#ff3333', text: '#fff' },
  [VfdBrand.SIEMENS]:    { primary: '#009999', accent: '#00cccc', text: '#fff' },
  [VfdBrand.DANFOSS]:    { primary: '#b71c1c', accent: '#e53935', text: '#fff' },
  [VfdBrand.SCHNEIDER]:  { primary: '#3dab2d', accent: '#66cc55', text: '#fff' },
  [VfdBrand.YASKAWA]:    { primary: '#003e8a', accent: '#1565c0', text: '#fff' },
  [VfdBrand.DELTA]:      { primary: '#004d99', accent: '#2979ff', text: '#fff' },
  [VfdBrand.MITSUBISHI]: { primary: '#cc0000', accent: '#ff4444', text: '#fff' },
  [VfdBrand.ROCKWELL]:   { primary: '#c62828', accent: '#ef5350', text: '#fff' },
};

const DEFAULT_BRAND_COLORS = { primary: '#374151', accent: '#6b7280', text: '#fff' };

const BRAND_LABELS: Record<string, string> = {
  [VfdBrand.ABB]: 'ABB',
  [VfdBrand.SIEMENS]: 'Siemens',
  [VfdBrand.DANFOSS]: 'Danfoss',
  [VfdBrand.SCHNEIDER]: 'Schneider',
  [VfdBrand.YASKAWA]: 'Yaskawa',
  [VfdBrand.DELTA]: 'Delta',
  [VfdBrand.MITSUBISHI]: 'Mitsubishi',
  [VfdBrand.ROCKWELL]: 'Rockwell',
};

/* ------------------------------------------------------------------ */
/*  VFD widget state type                                              */
/* ------------------------------------------------------------------ */

type VfdWidgetState = 'running' | 'stopped' | 'fault' | 'warning' | 'offline' | 'programming';

/* ------------------------------------------------------------------ */
/*  Status LED colors                                                  */
/* ------------------------------------------------------------------ */

const STATUS_LED: Record<VfdWidgetState, string> = {
  running:     '#22c55e',
  stopped:     '#9ca3af',
  fault:       '#ef4444',
  warning:     '#eab308',
  offline:     '#6b7280',
  programming: '#3b82f6',
};

/* ------------------------------------------------------------------ */
/*  Demo data for builder preview                                      */
/* ------------------------------------------------------------------ */

const DEMO_PARAMETERS: VfdParameters = {
  outputFrequency: 45.0,
  motorCurrent: 12.3,
  motorSpeed: 1350,
  outputPower: 5.2,
  driveTemperature: 42,
  faultCode: 0,
  warningCode: 0,
};

const DEMO_STATUS_BITS: VfdStatusBits = {
  ready: true, running: true, fault: false, warning: false,
  atSetpoint: true, atReference: true, direction: 'forward',
  remoteControl: true, localControl: false, autoMode: true, manualMode: false,
  currentLimit: false, voltageLimit: false, torqueLimit: false, speedLimit: false,
  enabled: true, quickStopActive: false, switchOnDisabled: false,
};

function deriveWidgetState(
  statusBits: VfdStatusBits | undefined,
  isOffline: boolean,
  isProgramming: boolean,
): VfdWidgetState {
  if (isOffline) return 'offline';
  if (isProgramming) return 'programming';
  if (!statusBits) return 'offline';
  if (statusBits.fault) return 'fault';
  if (statusBits.warning) return 'warning';
  if (statusBits.running) return 'running';
  return 'stopped';
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const VfdDriveWidget: React.FC<WidgetRendererProps> = ({
  config,
  width,
  height,
  isEditing,
  onCommand,
}) => {
  useEffect(injectVfdStyles, []);

  /* ---- Config ---- */
  const vfdDeviceId = config.vfdDeviceId as string | undefined;
  const brand = (config.brand as string) || VfdBrand.ABB;
  const displayName = (config.displayName as string) || (config.label as string) || 'VFD Drive';
  const maxFrequency = (config.maxFrequency as number) || 60;
  const tempWarningThreshold = (config.tempWarningThreshold as number) || 70;
  const currentWarningThreshold = (config.currentWarningThreshold as number) || 15;
  const showQuickActions = config.showQuickActions !== false;
  const showFrequency = config.showFrequency !== false;
  const showCurrent = config.showCurrent !== false;
  const showSpeed = config.showSpeed !== false;
  const showPower = config.showPower !== false;
  const showTemperature = config.showTemperature !== false;
  const isProgramming = Boolean(config.demoState === 'programming');
  const demoState = config.demoState as string | undefined;

  /* ---- Live data ---- */
  const { reading, error: readError } = useVfdRealtimeReadings(
    isEditing ? undefined : vfdDeviceId,
    { enabled: !isEditing && Boolean(vfdDeviceId), pollInterval: 2000 },
  );

  const params: VfdParameters = useMemo(() => {
    if (isEditing || !reading) return DEMO_PARAMETERS;
    return reading.parameters;
  }, [isEditing, reading]);

  const statusBits: VfdStatusBits | undefined = useMemo(() => {
    if (isEditing) {
      if (demoState === 'fault') return { ...DEMO_STATUS_BITS, running: false, fault: true };
      if (demoState === 'warning') return { ...DEMO_STATUS_BITS, warning: true };
      if (demoState === 'stopped') return { ...DEMO_STATUS_BITS, running: false };
      if (demoState === 'offline') return undefined;
      return DEMO_STATUS_BITS;
    }
    return reading?.statusBits;
  }, [isEditing, demoState, reading]);

  const isOffline = useMemo(() => {
    if (isEditing) return demoState === 'offline';
    return !reading && !vfdDeviceId || (Boolean(readError) && !reading);
  }, [isEditing, demoState, reading, readError, vfdDeviceId]);

  const widgetState = useMemo(
    () => deriveWidgetState(statusBits, isOffline, isProgramming),
    [statusBits, isOffline, isProgramming],
  );

  const isRunning = widgetState === 'running';

  /* ---- Brand styling ---- */
  const colors = BRAND_COLORS[brand] || DEFAULT_BRAND_COLORS;
  const brandLabel = BRAND_LABELS[brand] || brand;

  /* ---- Frequency gauge ---- */
  const freq = params.outputFrequency ?? 0;
  const freqPct = Math.min(1, Math.max(0, freq / maxFrequency));

  /* ---- Temperature bar ---- */
  const temp = params.driveTemperature ?? 0;
  const tempMax = 100;
  const tempPct = Math.min(1, Math.max(0, temp / tempMax));
  const tempExceedsWarning = temp >= tempWarningThreshold;
  const currentExceedsWarning = (params.motorCurrent ?? 0) >= currentWarningThreshold;

  /* ---- Handlers ---- */
  const handleStart = useCallback(() => {
    if (!isEditing && onCommand) onCommand('vfd:start');
  }, [isEditing, onCommand]);

  const handleStop = useCallback(() => {
    if (!isEditing && onCommand) onCommand('vfd:stop');
  }, [isEditing, onCommand]);

  const handleProgram = useCallback(() => {
    if (!isEditing && onCommand) onCommand('vfd:program', vfdDeviceId);
  }, [isEditing, onCommand, vfdDeviceId]);

  /* ---- Responsive sizing ---- */
  const vbW = 240;
  const vbH = 340;
  const fontSize = {
    brand: 11,
    param: 9.5,
    paramVal: 10,
    status: 9,
    btn: 8.5,
    label: 10,
  };

  /* ---- Fault code display ---- */
  const faultCode = params.faultCode;
  const hasFault = widgetState === 'fault' && faultCode !== undefined && faultCode !== 0;

  /* ---- Status label ---- */
  const statusLabel = useMemo(() => {
    const labels: Record<VfdWidgetState, string> = {
      running: 'RUNNING',
      stopped: 'STOPPED',
      fault: hasFault ? `FAULT F${String(faultCode).padStart(3, '0')}` : 'FAULT',
      warning: 'WARNING',
      offline: 'OFFLINE',
      programming: 'PROGRAMMING',
    };
    return labels[widgetState];
  }, [widgetState, hasFault, faultCode]);

  /* ---- Risk level from config (last change set) ---- */
  const riskLevel = (config.riskLevel as string) || 'none';
  const riskColor: Record<string, string> = {
    low: '#22c55e', medium: '#eab308', high: '#f97316', critical: '#ef4444', none: '#9ca3af',
  };

  return (
    <div
      style={{ width, height, position: 'relative', overflow: 'hidden' }}
      data-testid="vfd-drive-widget"
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${vbW} ${vbH}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
      >
        {/* ---- Outer border (fault pulse / programming glow) ---- */}
        <rect
          x={1} y={1} width={vbW - 2} height={vbH - 2}
          rx={6} fill="#f8fafc" stroke={widgetState === 'fault' ? '#ef4444' : widgetState === 'programming' ? '#3b82f6' : '#d1d5db'}
          strokeWidth={2}
          style={
            widgetState === 'fault'
              ? { animation: 'vfdFaultPulse 1.2s ease-in-out infinite' }
              : widgetState === 'programming'
                ? { animation: 'vfdProgPulse 1.5s ease-in-out infinite' }
                : undefined
          }
        />

        {/* ---- Header bar ---- */}
        <rect x={4} y={4} width={vbW - 8} height={28} rx={4} fill={colors.primary} />
        <text x={12} y={22} fontSize={fontSize.brand} fontWeight={700} fill={colors.text}>
          {brandLabel} {displayName}
        </text>
        {/* Status LED */}
        <circle cx={vbW - 16} cy={18} r={5} fill={STATUS_LED[widgetState]} />

        {/* ---- Frequency gauge arc (below header) ---- */}
        <g transform="translate(120, 52)">
          {/* Background arc */}
          <path
            d="M -40,0 A 40,40 0 0 1 40,0"
            fill="none" stroke="#e5e7eb" strokeWidth={5} strokeLinecap="round"
          />
          {/* Value arc */}
          <path
            d="M -40,0 A 40,40 0 0 1 40,0"
            fill="none" stroke={isRunning ? colors.accent : '#9ca3af'}
            strokeWidth={5} strokeLinecap="round"
            strokeDasharray={`${freqPct * 125.66} 125.66`}
            style={{ transition: 'stroke-dasharray 300ms ease-out' }}
          />
          <text x={0} y={-6} textAnchor="middle" fontSize={14} fontWeight={700} fill="#111827">
            {freq.toFixed(1)}
          </text>
          <text x={0} y={6} textAnchor="middle" fontSize={8} fill="#6b7280">Hz</text>
        </g>

        {/* ---- Drive enclosure ---- */}
        <g transform="translate(70, 70)">
          {/* Enclosure box */}
          <rect x={0} y={0} width={100} height={80} rx={4}
            fill="#f1f5f9" stroke={colors.primary} strokeWidth={2}
          />
          {/* Brand color strip */}
          <rect x={0} y={0} width={100} height={8} rx={4} fill={colors.primary} />
          <rect x={0} y={4} width={100} height={4} fill={colors.primary} />
          {/* VFD label */}
          <text x={50} y={30} textAnchor="middle" fontSize={14} fontWeight={700} fill="#374151">VFD</text>

          {/* Motor symbol */}
          <g transform="translate(50, 55)">
            <circle cx={0} cy={0} r={14} fill="none" stroke="#374151" strokeWidth={2} />
            <text
              x={0} y={5} textAnchor="middle" fontSize={12} fontWeight={600} fill="#374151"
              style={
                isRunning
                  ? { transformOrigin: '0px 0px', animation: 'vfdMotorSpin 1.5s linear infinite' }
                  : undefined
              }
            >M</text>
          </g>
        </g>

        {/* ---- Power flow arrows ---- */}
        {/* Input arrow (left) */}
        <line x1={30} y1={115} x2={68} y2={115}
          stroke={isRunning ? colors.accent : '#d1d5db'} strokeWidth={3}
          strokeDasharray="6 4"
          style={isRunning ? { animation: 'vfdFlowPulse 0.8s linear infinite' } : undefined}
          markerEnd="url(#vfdArrow)"
        />
        {/* Output arrow (right) */}
        <line x1={172} y1={115} x2={210} y2={115}
          stroke={isRunning ? colors.accent : '#d1d5db'} strokeWidth={3}
          strokeDasharray="6 4"
          style={isRunning ? { animation: 'vfdFlowPulse 0.8s linear infinite' } : undefined}
          markerEnd="url(#vfdArrow)"
        />
        {/* Arrow marker */}
        <defs>
          <marker id="vfdArrow" markerWidth={8} markerHeight={6} refX={7} refY={3} orient="auto">
            <polygon points="0,0 8,3 0,6" fill={isRunning ? colors.accent : '#d1d5db'} />
          </marker>
        </defs>

        {/* ---- Temperature bar (right side) ---- */}
        {showTemperature && (
          <g transform={`translate(${vbW - 18}, 70)`}>
            <rect x={0} y={0} width={8} height={80} rx={3} fill="#e5e7eb" />
            <rect
              x={0}
              y={80 - 80 * tempPct}
              width={8}
              height={80 * tempPct}
              rx={3}
              fill={tempExceedsWarning ? '#ef4444' : '#22c55e'}
              style={{ transition: 'height 300ms, y 300ms' }}
            />
            <text x={4} y={-4} textAnchor="middle" fontSize={7} fill="#6b7280">{temp.toFixed(0)}&#xB0;C</text>
          </g>
        )}

        {/* ---- Separator ---- */}
        <line x1={10} y1={158} x2={vbW - 10} y2={158} stroke="#e5e7eb" strokeWidth={1} />

        {/* ---- Parameter display ---- */}
        {(() => {
          const paramLines: Array<{ label: string; value: string; warn: boolean }> = [];
          if (showFrequency) paramLines.push({ label: 'Frequency', value: `${(params.outputFrequency ?? 0).toFixed(1)} Hz`, warn: false });
          if (showCurrent) paramLines.push({ label: 'Current', value: `${(params.motorCurrent ?? 0).toFixed(1)} A`, warn: currentExceedsWarning });
          if (showSpeed) paramLines.push({ label: 'Speed', value: `${(params.motorSpeed ?? 0).toFixed(0)} RPM`, warn: false });
          if (showPower) paramLines.push({ label: 'Power', value: `${(params.outputPower ?? 0).toFixed(1)} kW`, warn: false });
          if (showTemperature) paramLines.push({ label: 'Temperature', value: `${(params.driveTemperature ?? 0).toFixed(0)}°C`, warn: tempExceedsWarning });

          return paramLines.map((p, i) => (
            <g key={p.label} transform={`translate(14, ${168 + i * 16})`}>
              <text x={0} y={0} fontSize={fontSize.param} fill="#6b7280">{p.label}:</text>
              <text x={vbW - 48} y={0} textAnchor="end" fontSize={fontSize.paramVal} fontWeight={600} fill={p.warn ? '#ef4444' : '#111827'}>
                {p.value}
              </text>
              {p.warn && <text x={vbW - 38} y={1} fontSize={10} fill="#ef4444">&#9888;</text>}
            </g>
          ));
        })()}

        {/* ---- Separator ---- */}
        <line x1={10} y1={258} x2={vbW - 10} y2={258} stroke="#e5e7eb" strokeWidth={1} />

        {/* ---- Status row ---- */}
        <text x={14} y={274} fontSize={fontSize.status} fill="#6b7280">Status:</text>
        <text x={54} y={274} fontSize={fontSize.status} fontWeight={700} fill={STATUS_LED[widgetState]}>
          {statusLabel}
        </text>
        <circle cx={vbW - 16} cy={270} r={4} fill={STATUS_LED[widgetState]} />

        {/* ---- Separator ---- */}
        <line x1={10} y1={282} x2={vbW - 10} y2={282} stroke="#e5e7eb" strokeWidth={1} />

        {/* ---- Quick action buttons ---- */}
        {showQuickActions && (
          <g transform="translate(14, 290)">
            {/* Start */}
            <g
              onClick={handleStart}
              style={{ cursor: isEditing ? 'default' : 'pointer' }}
              data-testid="vfd-btn-start"
            >
              <rect x={0} y={0} width={60} height={20} rx={4} fill="#22c55e" opacity={0.9} />
              <text x={30} y={14} textAnchor="middle" fontSize={fontSize.btn} fontWeight={600} fill="#fff">Start</text>
            </g>
            {/* Stop */}
            <g
              onClick={handleStop}
              style={{ cursor: isEditing ? 'default' : 'pointer' }}
              data-testid="vfd-btn-stop"
            >
              <rect x={68} y={0} width={60} height={20} rx={4} fill="#ef4444" opacity={0.9} />
              <text x={98} y={14} textAnchor="middle" fontSize={fontSize.btn} fontWeight={600} fill="#fff">Stop</text>
            </g>
            {/* Program */}
            <g
              onClick={handleProgram}
              style={{ cursor: isEditing ? 'default' : 'pointer' }}
              data-testid="vfd-btn-program"
            >
              <rect x={136} y={0} width={76} height={20} rx={4} fill="#3b82f6" opacity={0.9} />
              <text x={174} y={14} textAnchor="middle" fontSize={fontSize.btn} fontWeight={600} fill="#fff">Program</text>
            </g>
          </g>
        )}

        {/* ---- Risk level ---- */}
        {riskLevel !== 'none' && (
          <g transform="translate(14, 318)">
            <text x={0} y={0} fontSize={fontSize.status} fill="#6b7280">Risk:</text>
            <circle cx={38} cy={-3} r={4} fill={riskColor[riskLevel] || '#9ca3af'} />
            <text x={46} y={0} fontSize={fontSize.status} fontWeight={600} fill="#374151">
              {riskLevel.toUpperCase()}
            </text>
          </g>
        )}

        {/* ---- Offline overlay ---- */}
        {widgetState === 'offline' && (
          <g>
            <rect x={1} y={1} width={vbW - 2} height={vbH - 2} rx={6} fill="#f3f4f6" opacity={0.75} />
            <text x={vbW / 2} y={vbH / 2 - 6} textAnchor="middle" fontSize={13} fontWeight={700} fill="#991b1b">
              No Communication
            </text>
            <text x={vbW / 2} y={vbH / 2 + 12} textAnchor="middle" fontSize={9} fill="#6b7280">
              Device offline or not configured
            </text>
          </g>
        )}

        {/* ---- Programming overlay ---- */}
        {widgetState === 'programming' && (
          <g>
            <rect x={1} y={1} width={vbW - 2} height={vbH - 2} rx={6} fill="#eff6ff" opacity={0.6} />
            <text x={vbW / 2} y={vbH / 2} textAnchor="middle" fontSize={11} fontWeight={700} fill="#1d4ed8">
              Change Set Applying...
            </text>
          </g>
        )}
      </svg>
    </div>
  );
};

VfdDriveWidget.displayName = 'VfdDriveWidget';
export default memo(VfdDriveWidget);
