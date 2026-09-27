import React, { useMemo } from 'react';
import { Bell, AlertTriangle, ShieldAlert } from 'lucide-react';
import { useScadaPackageStore } from '../../store/scada';
import type { AlarmRuleDef } from '../../store/scada';
import { severityClasses } from '@aquaculture/shared-ui';

/* ------------------------------------------------------------------ */
/*  ISA-101 Severity Configuration                                     */
/* ------------------------------------------------------------------ */

const SEVERITY_CONFIG = {
  critical: {
    label: 'Critical',
    bg: severityClasses('critical', 'solid'),
    text: '',
    pillBg: 'bg-black/20',
    pillText: 'text-inherit',
  },
  high: {
    label: 'High',
    bg: severityClasses('high', 'solid'),
    text: '',
    pillBg: 'bg-black/20',
    pillText: 'text-inherit',
  },
  warning: {
    label: 'Warning',
    bg: severityClasses('warning', 'solid'),
    text: '',
    pillBg: 'bg-black/10',
    pillText: 'text-inherit',
  },
  info: {
    label: 'Info',
    bg: severityClasses('info', 'solid'),
    text: '',
    pillBg: 'bg-black/20',
    pillText: 'text-inherit',
  },
} as const;

type Severity = AlarmRuleDef['severity'];

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'warning', 'info'];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const GlobalAlarmBanner: React.FC = () => {
  const alarmRules = useScadaPackageStore((s) => s.alarmRules);
  const simulationMode = useScadaPackageStore((s) => s.simulationMode);
  const simAlarms = useScadaPackageStore((s) => s.simAlarms);

  const { counts, total, highestSeverity } = useMemo(() => {
    // In simulation mode, show fired simulation alarms
    if (simulationMode && simAlarms.length > 0) {
      const c: Record<Severity, number> = { critical: 0, high: 0, warning: 0, info: 0 };
      for (const alarm of simAlarms) {
        const sev = alarm.severity as Severity;
        if (c[sev] !== undefined) c[sev]++;
      }
      let highest: Severity | null = null;
      for (const sev of SEVERITY_ORDER) {
        if (c[sev] > 0) {
          highest = sev;
          break;
        }
      }
      return { counts: c, total: simAlarms.length, highestSeverity: highest };
    }

    const c: Record<Severity, number> = {
      critical: 0,
      high: 0,
      warning: 0,
      info: 0,
    };

    for (const rule of alarmRules) {
      c[rule.severity] = (c[rule.severity] ?? 0) + 1;
    }

    // Find highest severity that has at least one rule
    let highest: Severity | null = null;
    for (const sev of SEVERITY_ORDER) {
      if (c[sev] > 0) {
        highest = sev;
        break;
      }
    }

    return { counts: c, total: alarmRules.length, highestSeverity: highest };
  }, [alarmRules, simulationMode, simAlarms]);

  const hasCritical = counts.critical > 0;
  const isEmpty = total === 0;

  /* Bar background: red-600 + pulse if critical, otherwise neutral dark */
  const barClasses = [
    'flex items-center justify-between px-4 h-8 text-xs select-none',
    hasCritical
      ? 'bg-error-600 text-white animate-pulse'
      : 'bg-gray-800 text-gray-500 dark:text-gray-400',
  ].join(' ');

  return (
    <div className={barClasses}>
      {/* Left: Icon + Label */}
      <div className="flex items-center gap-2 min-w-0">
        {hasCritical ? (
          <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0" />
        ) : (
          <Bell className="w-3.5 h-3.5 flex-shrink-0" />
        )}
        <span className="font-medium whitespace-nowrap">
          {simulationMode ? 'Alarms (SIM)' : 'Alarms'}
        </span>
      </div>

      {/* Center: Severity summary or empty message */}
      <div className="flex items-center gap-2">
        {isEmpty ? (
          <span className="text-gray-500 dark:text-gray-400 italic">No alarm rules defined</span>
        ) : (
          <div className="flex items-center gap-1.5">
            {SEVERITY_ORDER.map((sev, idx) => {
              const cfg = SEVERITY_CONFIG[sev];
              return (
                <React.Fragment key={sev}>
                  {idx > 0 && (
                    <span
                      className={
                        hasCritical ? 'text-error-300' : 'text-gray-600 dark:text-gray-400'
                      }
                    >
                      &middot;
                    </span>
                  )}
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full ${cfg.pillBg} ${cfg.pillText}`}
                  >
                    <span className="font-semibold">{counts[sev]}</span>
                    <span>{cfg.label}</span>
                  </span>
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>

      {/* Right: Total alarm rules badge */}
      <div className="flex items-center gap-1.5 min-w-0">
        <AlertTriangle className="w-3 h-3 flex-shrink-0 opacity-60" />
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded-full font-medium ${
            isEmpty
              ? 'bg-gray-700 text-gray-500 dark:text-gray-400'
              : hasCritical
                ? 'bg-error-800 text-error-100'
                : 'bg-gray-700 text-gray-200'
          }`}
        >
          {total} rule{total !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
};
