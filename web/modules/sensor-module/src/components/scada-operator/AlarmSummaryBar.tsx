/**
 * AlarmSummaryBar — Compact horizontal alarm status banner.
 *
 * Displays at the bottom of the HMI operator shell:
 *   🔴 Critical: N  🟠 High: N  🟡 Warning: N  ℹ️ Info: N
 *
 * Features:
 *  - Blinking red border/glow animation when there are unacknowledged critical alarms
 *  - Click anywhere on the bar to open the AlarmPanel
 *  - Zero count badges are shown as muted to reduce visual noise
 *  - AlarmPanel rendered as a modal overlay
 *  - Hidden if summary is null (e.g. not yet connected)
 *
 * Tailwind CSS + lucide-react icons
 */

import React, { useState, useCallback, useEffect, useRef, memo } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Info,
  ChevronUp,
} from 'lucide-react';

import type { AlarmStatusSummary } from '../../types/scada-runtime.types';
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
}

const SeverityChip = memo(({ count, label, icon, activeClass, mutedClass }: SeverityChipProps) => {
  const isActive = count > 0;
  return (
    <div
      className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold transition-colors ${
        isActive ? activeClass : mutedClass
      }`}
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
  const prevCriticalCountRef = useRef(0);
  const [hasNewCritical, setHasNewCritical] = useState(false);

  // Inject blink CSS once on mount
  useEffect(() => {
    injectBlinkStyle();
  }, []);

  // Detect new critical alarms (count increases) and trigger blink
  useEffect(() => {
    const currentCritical = summary?.critical ?? 0;
    if (currentCritical > prevCriticalCountRef.current) {
      setHasNewCritical(true);
    } else if (currentCritical === 0) {
      setHasNewCritical(false);
    }
    prevCriticalCountRef.current = currentCritical;
  }, [summary?.critical]);

  // Stop blinking once all criticals are acknowledged
  useEffect(() => {
    const unackedCritical = activeAlarms.filter(
      (a) => a.severity === 'critical' && a.status === 'active',
    ).length;
    if (unackedCritical === 0) {
      setHasNewCritical(false);
    }
  }, [activeAlarms]);

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
  const totalActive = criticalCount + highCount + warningCount + infoCount;

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
          ${hasNewCritical ? 'border-red-600 alarm-critical-blink' : 'border-gray-700'}
          transition-all duration-300
          ${className}
        `}
      >
        {/* Alarm icon */}
        <AlertTriangle
          className={`h-4 w-4 flex-shrink-0 ${
            criticalCount > 0
              ? 'text-red-500 animate-pulse'
              : highCount > 0
              ? 'text-orange-400'
              : warningCount > 0
              ? 'text-yellow-400'
              : 'text-gray-500'
          }`}
        />

        {/* Severity chips */}
        <SeverityChip
          count={criticalCount}
          label="Critical"
          icon={<AlertCircle className="h-3.5 w-3.5" />}
          activeClass="bg-red-700 text-white"
          mutedClass="bg-gray-800 text-gray-500"
        />

        <SeverityChip
          count={highCount}
          label="High"
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          activeClass="bg-orange-600 text-white"
          mutedClass="bg-gray-800 text-gray-500"
        />

        <SeverityChip
          count={warningCount}
          label="Warning"
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          activeClass="bg-yellow-500 text-gray-900"
          mutedClass="bg-gray-800 text-gray-500"
        />

        <SeverityChip
          count={infoCount}
          label="Info"
          icon={<Info className="h-3.5 w-3.5" />}
          activeClass="bg-blue-600 text-white"
          mutedClass="bg-gray-800 text-gray-500"
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
