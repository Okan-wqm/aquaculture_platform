/**
 * AlarmSummaryBar — Compact horizontal alarm status banner.
 *
 * Displays at the bottom of the HMI operator shell:
 *   🔴 Critical: N  🟠 High: N  🟡 Warning: N  ℹ️ Info: N
 *
 * ISA-18.2 annunciation (T2): chips with UNACKNOWLEDGED alarms FLASH
 * (scada-alarm-flash); once every alarm of that severity is acknowledged the
 * chip goes STEADY. Severity is carried by COLOR only, never by the
 * animation. Shelving is a documented deviation (see AlarmStatusSummary).
 *
 * Features:
 *  - Click anywhere on the bar to open the AlarmPanel
 *  - Zero count badges are shown as muted to reduce visual noise
 *  - AlarmPanel rendered as a modal overlay
 *  - Hidden if summary is null (e.g. not yet connected)
 *
 * Tailwind CSS + lucide-react icons
 */

import React, { useState, useCallback, useEffect, memo } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Info,
  ChevronUp,
} from 'lucide-react';

import type { AlarmSeverity, AlarmStatusSummary } from '../../types/scada-runtime.types';
import { useAlarmRuntime } from '../../hooks/useAlarmRuntime';
import { AlarmPanel } from './AlarmPanel';

/* ------------------------------------------------------------------ */
/*  CSS keyframes injected once                                         */
/* ------------------------------------------------------------------ */

const BLINK_CSS = `
@keyframes alarm-critical-blink {
  0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0); border-color: rgb(220,38,38); }
  50%       { box-shadow: 0 0 12px 4px rgba(220,38,38,0.6); border-color: rgb(239,68,68); }
}
.alarm-critical-blink {
  animation: alarm-critical-blink 1s ease-in-out infinite;
}
@keyframes scada-alarm-flash { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0.25; } }
.scada-alarm-flash { animation: scada-alarm-flash 0.75s step-end infinite; }
`;

let styleInjected = false;

function injectBlinkStyle(): void {
  if (styleInjected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = BLINK_CSS;
  document.head.appendChild(style);
  styleInjected = true;
}

/* ------------------------------------------------------------------ */
/*  SeverityChip sub-component                                          */
/* ------------------------------------------------------------------ */

interface SeverityChipProps {
  count: number;
  label: string;
  icon: React.ReactNode;
  activeClass: string;
  mutedClass: string;
  /** ISA-18.2: flash while unacknowledged alarms of this severity exist. */
  flashing?: boolean;
}

const SeverityChip = memo(({ count, label, icon, activeClass, mutedClass, flashing }: SeverityChipProps) => {
  const isActive = count > 0;
  return (
    <div
      className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold transition-colors ${
        isActive ? activeClass : mutedClass
      } ${flashing ? 'scada-alarm-flash' : ''}`}
    >
      {icon}
      <span>{label}:</span>
      <span className="tabular-nums">{count}</span>
    </div>
  );
});
SeverityChip.displayName = 'SeverityChip';

/* ------------------------------------------------------------------ */
/*  AlarmSummaryBar                                                     */
/* ------------------------------------------------------------------ */

export interface AlarmSummaryBarProps {
  /** If true, the bar is rendered even when all counts are 0. */
  alwaysVisible?: boolean;
  /** Optional CSS class for the outer wrapper. */
  className?: string;
}

export const AlarmSummaryBar = memo(({ alwaysVisible = true, className = '' }: AlarmSummaryBarProps) => {
  const { summary, activeAlarms } = useAlarmRuntime();
  const [panelOpen, setPanelOpen] = useState(false);

  // Inject blink CSS once on mount
  useEffect(() => {
    injectBlinkStyle();
  }, []);

/** Backend-parity unacked definition (A7/Plan 2): active OR cleared-unacked. */
function isUnacked(a: { status: string; ackTime?: number }): boolean {
  return a.status === 'active' || (a.status === 'cleared' && a.ackTime == null);
}

  // ISA-18.2: unacknowledged counts per severity. Prefers the server's
  // additive `summary.unacked`; the local fallback mirrors the backend's
  // unacked definition via isUnacked (active or cleared without ack).
  const unacked = summary?.unacked ?? {
    critical: activeAlarms.filter((a) => a.severity === 'critical' && isUnacked(a)).length,
    high:     activeAlarms.filter((a) => a.severity === 'high'     && isUnacked(a)).length,
    warning:  activeAlarms.filter((a) => a.severity === 'warning'  && isUnacked(a)).length,
    info:     activeAlarms.filter((a) => a.severity === 'info'     && isUnacked(a)).length,
  };
  const hasUnacked = unacked.critical + unacked.high + unacked.warning + unacked.info > 0;

  const handleBarClick = useCallback(() => {
    setPanelOpen(true);
  }, []);

  const handlePanelClose = useCallback(() => {
    setPanelOpen(false);
  }, []);

  // Hide bar if no summary yet and not alwaysVisible
  if (!summary && !alwaysVisible) return null;

  const criticalCount = summary?.critical ?? 0;
  const highCount = summary?.high ?? 0;
  const warningCount = summary?.warning ?? 0;
  const infoCount = summary?.info ?? 0;
  // Server-counted total when present; otherwise the severity sum.
  const totalActive = summary?.totalActive ?? (criticalCount + highCount + warningCount + infoCount);

  return (
    <>
      {/* ── Summary Bar ──────────────────────────────────────────── */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleBarClick}
        onKeyDown={(e) => e.key === 'Enter' && handleBarClick()}
        title="Click to open Alarm Panel"
        className={`
          flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none
          bg-gray-900 dark:bg-gray-950 border-t-2
          ${unacked.critical > 0 ? 'border-red-600 alarm-critical-blink' : 'border-gray-700'}
          transition-all duration-300
          ${className}
        `}
      >
        {/* Alarm icon — flashes only while unacknowledged alarms exist */}
        <AlertTriangle
          className={`h-4 w-4 flex-shrink-0 ${
            criticalCount > 0
              ? 'text-red-500'
              : highCount > 0
              ? 'text-orange-400'
              : warningCount > 0
              ? 'text-yellow-400'
              : 'text-gray-500'
          } ${hasUnacked ? 'scada-alarm-flash' : ''}`}
        />

        {/* Severity chips — unacked severities flash; severity is color-only */}
        <SeverityChip
          count={criticalCount}
          label="Critical"
          icon={<AlertCircle className="h-3.5 w-3.5" />}
          activeClass="bg-red-700 text-white"
          mutedClass="bg-gray-800 text-gray-500"
          flashing={unacked.critical > 0}
        />

        <SeverityChip
          count={highCount}
          label="High"
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          activeClass="bg-orange-600 text-white"
          mutedClass="bg-gray-800 text-gray-500"
          flashing={unacked.high > 0}
        />

        <SeverityChip
          count={warningCount}
          label="Warning"
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          activeClass="bg-yellow-500 text-gray-900"
          mutedClass="bg-gray-800 text-gray-500"
          flashing={unacked.warning > 0}
        />

        <SeverityChip
          count={infoCount}
          label="Info"
          icon={<Info className="h-3.5 w-3.5" />}
          activeClass="bg-blue-600 text-white"
          mutedClass="bg-gray-800 text-gray-500"
          flashing={unacked.info > 0}
        />

        {/* Total badge (muted when zero) */}
        <div
          className={`ml-1 px-2 py-0.5 rounded text-xs font-bold ${
            totalActive > 0
              ? 'bg-red-600 text-white'
              : 'bg-gray-700 text-gray-500'
          }`}
        >
          {totalActive} active
        </div>

        {/* Expand indicator */}
        <div className="ml-auto flex items-center gap-1 text-gray-500 text-xs">
          <ChevronUp className="h-4 w-4" />
          <span className="hidden sm:inline">Alarms</span>
        </div>
      </div>

      {/* ── AlarmPanel modal ─────────────────────────────────────── */}
      {panelOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-stretch pointer-events-none"
          style={{ paddingBottom: '2.5rem' }} // leave room above the bar
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40 pointer-events-auto"
            onClick={handlePanelClose}
          />

          {/* Panel */}
          <div className="relative w-full pointer-events-auto px-4 pb-2">
            <AlarmPanel
              onClose={handlePanelClose}
              className="w-full"
            />
          </div>
        </div>
      )}
    </>
  );
});

AlarmSummaryBar.displayName = 'AlarmSummaryBar';
