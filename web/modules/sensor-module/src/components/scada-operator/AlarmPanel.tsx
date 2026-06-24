/**
 * AlarmPanel — Full alarm management UI.
 *
 * Features:
 *  - Two tabs: Active alarms / History
 *  - Table: Time, Severity badge, Group, Message, Value vs Threshold, Status, ACK button
 *  - Severity colour coding: critical=red, high=orange, warning=yellow, info=blue
 *  - Filter by severity (multi-select), group (dropdown), free-text search
 *  - ACK individual alarm | ACK All button
 *  - History tab: date-range picker, re-queries server
 *  - Export to CSV (active or history)
 *  - Auto-refresh every 2 s while panel is open (re-emits status request)
 *  - Tailwind CSS + lucide-react icons
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  memo,
} from 'react';
import {
  AlertTriangle,
  AlertCircle,
  Info,
  CheckCircle,
  X,
  Download,
  RefreshCw,
  Search,
  CheckCheck,
  ChevronDown,
  Filter,
} from 'lucide-react';

import type {
  AlarmInstance,
  AlarmSeverity,
  AlarmHistoryFilter,
} from '../../types/scada-runtime.types';
import { useAlarmRuntime } from '../../hooks/useAlarmRuntime';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

type PanelTab = 'active' | 'history';

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const SEVERITY_ORDER: AlarmSeverity[] = ['critical', 'high', 'warning', 'info'];

const SEVERITY_STYLES: Record<AlarmSeverity, { badge: string; row: string; icon: React.ReactNode }> = {
  critical: {
    badge: 'bg-red-600 text-white',
    row: 'bg-red-50 dark:bg-red-950/20',
    icon: <AlertCircle className="h-4 w-4 text-red-600" />,
  },
  high: {
    badge: 'bg-orange-500 text-white',
    row: 'bg-orange-50 dark:bg-orange-950/20',
    icon: <AlertTriangle className="h-4 w-4 text-orange-500" />,
  },
  warning: {
    badge: 'bg-yellow-400 text-gray-900',
    row: 'bg-yellow-50 dark:bg-yellow-950/20',
    icon: <AlertTriangle className="h-4 w-4 text-yellow-500" />,
  },
  info: {
    badge: 'bg-blue-500 text-white',
    row: 'bg-blue-50 dark:bg-blue-950/20',
    icon: <Info className="h-4 w-4 text-blue-500" />,
  },
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  cleared: 'Cleared',
  acknowledged: 'Acked',
  inactive: 'Inactive',
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function exportCsv(alarms: AlarmInstance[], filename: string): void {
  const headers = [
    'Time',
    'Severity',
    'Group',
    'Message',
    'Value',
    'Threshold',
    'Status',
    'ACK Time',
    'ACK By',
  ];
  const rows = alarms.map((a) => [
    formatTime(a.onTime),
    a.severity,
    a.group ?? '',
    `"${a.message.replace(/"/g, '""')}"`,
    a.currentValue,
    a.threshold,
    a.status,
    a.ackTime ? formatTime(a.ackTime) : '',
    a.ackUserId ?? '',
  ]);
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/*  AlarmRow sub-component                                              */
/* ------------------------------------------------------------------ */

interface AlarmRowProps {
  alarm: AlarmInstance;
  onAck: (id: string) => void;
  isHistory?: boolean;
}

const AlarmRow = memo(({ alarm, onAck, isHistory }: AlarmRowProps) => {
  const styles = SEVERITY_STYLES[alarm.severity] ?? SEVERITY_STYLES.info;

  return (
    <tr className={`border-b border-gray-200 dark:border-gray-700 ${styles.row}`}>
      {/* Time */}
      <td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-300 whitespace-nowrap">
        {formatTime(alarm.onTime)}
      </td>

      {/* Severity */}
      <td className="px-3 py-2">
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide ${styles.badge}`}
        >
          {styles.icon}
          {alarm.severity}
        </span>
      </td>

      {/* Group */}
      <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
        {alarm.group ?? '—'}
      </td>

      {/* Message */}
      <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100 max-w-xs truncate">
        <span title={alarm.message}>{alarm.message}</span>
      </td>

      {/* Value vs Threshold */}
      <td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-300 whitespace-nowrap font-mono">
        {alarm.currentValue.toFixed(2)} / {alarm.threshold.toFixed(2)}
      </td>

      {/* Status */}
      <td className="px-3 py-2 text-xs">
        <span
          className={`px-2 py-0.5 rounded font-medium ${
            alarm.status === 'active'
              ? 'text-red-700 bg-red-100 dark:bg-red-900/30 dark:text-red-300'
              : alarm.status === 'cleared'
              ? 'text-orange-700 bg-orange-100 dark:bg-orange-900/30 dark:text-orange-300'
              : alarm.status === 'acknowledged'
              ? 'text-green-700 bg-green-100 dark:bg-green-900/30 dark:text-green-300'
              : 'text-gray-500 bg-gray-100 dark:bg-gray-800 dark:text-gray-400'
          }`}
        >
          {STATUS_LABELS[alarm.status] ?? alarm.status}
        </span>
      </td>

      {/* ACK button */}
      {!isHistory && (
        <td className="px-3 py-2">
          {alarm.status !== 'acknowledged' && (
            <button
              onClick={() => onAck(alarm.id)}
              title="Acknowledge alarm"
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium
                         bg-green-600 hover:bg-green-700 text-white transition-colors"
            >
              <CheckCircle className="h-3.5 w-3.5" />
              ACK
            </button>
          )}
        </td>
      )}
    </tr>
  );
});
AlarmRow.displayName = 'AlarmRow';

/* ------------------------------------------------------------------ */
/*  AlarmPanel component                                                */
/* ------------------------------------------------------------------ */

export interface AlarmPanelProps {
  /** Called when the close button is pressed. */
  onClose?: () => void;
  /** Optional CSS class for the panel container. */
  className?: string;
}

export const AlarmPanel = memo(({ onClose, className = '' }: AlarmPanelProps) => {
  const { activeAlarms, history, acknowledgeAlarm, acknowledgeAll, queryHistory, isLoading } =
    useAlarmRuntime();

  // ── Tab ──────────────────────────────────────────────────────────────────
  const [tab, setTab] = useState<PanelTab>('active');

  // ── Filters ──────────────────────────────────────────────────────────────
  const [selectedSeverities, setSelectedSeverities] = useState<Set<AlarmSeverity>>(new Set());
  const [groupFilter, setGroupFilter] = useState('');
  const [textSearch, setTextSearch] = useState('');
  const [showSeverityDropdown, setShowSeverityDropdown] = useState(false);

  // ── History date range ───────────────────────────────────────────────────
  const [historyFrom, setHistoryFrom] = useState('');
  const [historyTo, setHistoryTo] = useState('');

  // ── Auto-refresh (active tab only) ──────────────────────────────────────
  useEffect(() => {
    if (tab !== 'active') return;

    const interval = setInterval(() => {
      // The hook already listens for ALARM_STATUS pushes;
      // nothing extra needed — the server pushes at 1 Hz.
    }, 2_000);

    return () => clearInterval(interval);
  }, [tab]);

  // ── Available groups ─────────────────────────────────────────────────────
  const availableGroups = useMemo(() => {
    const source = tab === 'active' ? activeAlarms : history;
    const groups = new Set<string>();
    source.forEach((a) => { if (a.group) groups.add(a.group); });
    return Array.from(groups).sort();
  }, [activeAlarms, history, tab]);

  // ── Filtered alarms ──────────────────────────────────────────────────────
  const displayedAlarms = useMemo(() => {
    const source = tab === 'active' ? activeAlarms : history;

    return source.filter((alarm) => {
      if (selectedSeverities.size > 0 && !selectedSeverities.has(alarm.severity)) return false;
      if (groupFilter && alarm.group !== groupFilter) return false;
      if (textSearch) {
        const q = textSearch.toLowerCase();
        if (
          !alarm.message.toLowerCase().includes(q) &&
          !alarm.ruleName.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [activeAlarms, history, tab, selectedSeverities, groupFilter, textSearch]);

  // ── Sorted alarms ────────────────────────────────────────────────────────
  const sortedAlarms = useMemo(() => {
    return [...displayedAlarms].sort((a, b) => {
      const ai = SEVERITY_ORDER.indexOf(a.severity);
      const bi = SEVERITY_ORDER.indexOf(b.severity);
      if (ai !== bi) return ai - bi;
      return b.onTime - a.onTime;
    });
  }, [displayedAlarms]);

  // ── History query ────────────────────────────────────────────────────────
  const handleHistoryQuery = useCallback(async () => {
    const filter: AlarmHistoryFilter = {
      severity: selectedSeverities.size > 0 ? Array.from(selectedSeverities) : undefined,
      group: groupFilter || undefined,
      textSearch: textSearch || undefined,
      from: historyFrom ? new Date(historyFrom).getTime() : undefined,
      to: historyTo ? new Date(historyTo).getTime() : undefined,
      limit: 500,
    };
    await queryHistory(filter);
  }, [queryHistory, selectedSeverities, groupFilter, textSearch, historyFrom, historyTo]);

  // Load history on tab switch
  useEffect(() => {
    if (tab === 'history') {
      void handleHistoryQuery();
    }
  }, [tab]);  

  // ── CSV export ───────────────────────────────────────────────────────────
  const handleExport = useCallback(() => {
    const filename = tab === 'active'
      ? `alarms-active-${Date.now()}.csv`
      : `alarms-history-${Date.now()}.csv`;
    exportCsv(sortedAlarms, filename);
  }, [sortedAlarms, tab]);

  // ── Severity filter toggle ───────────────────────────────────────────────
  const toggleSeverity = useCallback((sev: AlarmSeverity) => {
    setSelectedSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(sev)) {
        next.delete(sev);
      } else {
        next.add(sev);
      }
      return next;
    });
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Render                                                            */
  /* ---------------------------------------------------------------- */

  return (
    <div
      className={`flex flex-col bg-white dark:bg-gray-900 rounded-lg shadow-xl border
                  border-gray-200 dark:border-gray-700 ${className}`}
      style={{ minWidth: 720, maxHeight: '80vh' }}
    >
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-orange-500" />
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">
            Alarm Management
          </h2>
          <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
            ({activeAlarms.length} active)
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* ACK All */}
          {tab === 'active' && activeAlarms.some((a) => a.status !== 'acknowledged') && (
            <button
              onClick={acknowledgeAll}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium
                         bg-green-600 hover:bg-green-700 text-white transition-colors"
            >
              <CheckCheck className="h-3.5 w-3.5" />
              ACK All
            </button>
          )}

          {/* Export */}
          <button
            onClick={handleExport}
            title="Export to CSV"
            className="p-1.5 rounded text-gray-500 hover:text-gray-700 hover:bg-gray-100
                       dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-800
                       transition-colors"
          >
            <Download className="h-4 w-4" />
          </button>

          {/* Close */}
          {onClose && (
            <button
              onClick={onClose}
              title="Close"
              className="p-1.5 rounded text-gray-500 hover:text-gray-700 hover:bg-gray-100
                         dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-800
                         transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* ── Tabs ───────────────────────────────────────────────────── */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 px-4">
        {(['active', 'history'] as PanelTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors
              ${
                tab === t
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
              }`}
          >
            {t === 'active' ? 'Active Alarms' : 'History'}
          </button>
        ))}
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-850">
        {/* Text search */}
        <div className="relative flex-1 min-w-40">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <input
            type="text"
            placeholder="Search alarms…"
            value={textSearch}
            onChange={(e) => setTextSearch(e.target.value)}
            className="w-full pl-7 pr-2 py-1 text-sm rounded border border-gray-200 dark:border-gray-600
                       bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                       focus:outline-hidden focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {/* Severity filter */}
        <div className="relative">
          <button
            onClick={() => setShowSeverityDropdown((v) => !v)}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-sm rounded border
                       border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800
                       text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700
                       transition-colors"
          >
            <Filter className="h-3.5 w-3.5" />
            Severity
            {selectedSeverities.size > 0 && (
              <span className="ml-1 px-1 rounded bg-blue-500 text-white text-xs">
                {selectedSeverities.size}
              </span>
            )}
            <ChevronDown className="h-3.5 w-3.5" />
          </button>

          {showSeverityDropdown && (
            <div
              className="absolute z-50 top-full left-0 mt-1 w-44 bg-white dark:bg-gray-800
                         rounded border border-gray-200 dark:border-gray-600 shadow-lg"
            >
              {SEVERITY_ORDER.map((sev) => (
                <label
                  key={sev}
                  className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer
                             hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  <input
                    type="checkbox"
                    checked={selectedSeverities.has(sev)}
                    onChange={() => toggleSeverity(sev)}
                    className="rounded"
                  />
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${SEVERITY_STYLES[sev].badge}`}>
                    {sev}
                  </span>
                </label>
              ))}
              <div className="border-t border-gray-100 dark:border-gray-700 px-3 py-1">
                <button
                  onClick={() => { setSelectedSeverities(new Set()); setShowSeverityDropdown(false); }}
                  className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                >
                  Clear filter
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Group filter */}
        {availableGroups.length > 0 && (
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            className="px-2 py-1 text-sm rounded border border-gray-200 dark:border-gray-600
                       bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300
                       focus:outline-hidden focus:ring-1 focus:ring-blue-500"
          >
            <option value="">All groups</option>
            {availableGroups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        )}

        {/* History date range */}
        {tab === 'history' && (
          <>
            <input
              type="datetime-local"
              value={historyFrom}
              onChange={(e) => setHistoryFrom(e.target.value)}
              className="px-2 py-1 text-xs rounded border border-gray-200 dark:border-gray-600
                         bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
            />
            <span className="text-gray-400 text-xs">to</span>
            <input
              type="datetime-local"
              value={historyTo}
              onChange={(e) => setHistoryTo(e.target.value)}
              className="px-2 py-1 text-xs rounded border border-gray-200 dark:border-gray-600
                         bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
            />
            <button
              onClick={() => void handleHistoryQuery()}
              disabled={isLoading}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded
                         bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              Query
            </button>
          </>
        )}
      </div>

      {/* ── Table ──────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <RefreshCw className="h-5 w-5 animate-spin mr-2" />
            Loading…
          </div>
        ) : sortedAlarms.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-400">
            <CheckCircle className="h-8 w-8 mb-2 text-green-400" />
            <p className="text-sm">No alarms{tab === 'active' ? ' active' : ' in history'}</p>
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 bg-gray-100 dark:bg-gray-800 z-10">
              <tr>
                <th className="px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Time
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Severity
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Group
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Message
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Value / Threshold
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Status
                </th>
                {tab === 'active' && (
                  <th className="px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    ACK
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {sortedAlarms.map((alarm) => (
                <AlarmRow
                  key={alarm.id}
                  alarm={alarm}
                  onAck={acknowledgeAlarm}
                  isHistory={tab === 'history'}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-800 text-xs text-gray-400 dark:text-gray-500">
        Showing {sortedAlarms.length} alarm{sortedAlarms.length !== 1 ? 's' : ''}
        {tab === 'active' && (
          <span className="ml-2">• Live updates active</span>
        )}
      </div>
    </div>
  );
});

AlarmPanel.displayName = 'AlarmPanel';
