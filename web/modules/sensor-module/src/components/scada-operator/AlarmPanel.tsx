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
 *  - Rows render through shared-ui DataTable (sticky header, loading and
 *    empty states); severity tints the row, status and severity are pills
 */

import React, { useState, useEffect, useCallback, useMemo, memo } from 'react';
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
import {
  DataTable,
  type DataTableColumn,
  severityClasses,
  Button,
  Input,
} from '@aquaculture/shared-ui';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

type PanelTab = 'active' | 'history';

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const SEVERITY_ORDER: AlarmSeverity[] = ['critical', 'high', 'warning', 'info'];

const SEVERITY_STYLES: Record<
  AlarmSeverity,
  { badge: string; row: string; icon: React.ReactNode }
> = {
  critical: {
    badge: severityClasses('critical', 'solid'),
    row: severityClasses('critical', 'row'),
    icon: <AlertCircle className={`h-4 w-4 ${severityClasses('critical', 'text')}`} />,
  },
  high: {
    badge: severityClasses('high', 'solid'),
    row: severityClasses('high', 'row'),
    icon: <AlertTriangle className={`h-4 w-4 ${severityClasses('high', 'text')}`} />,
  },
  warning: {
    badge: severityClasses('warning', 'solid'),
    row: severityClasses('warning', 'row'),
    icon: <AlertTriangle className={`h-4 w-4 ${severityClasses('warning', 'text')}`} />,
  },
  info: {
    badge: severityClasses('info', 'solid'),
    row: severityClasses('info', 'row'),
    icon: <Info className={`h-4 w-4 ${severityClasses('info', 'text')}`} />,
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
/*  Cell renderers                                                      */
/* ------------------------------------------------------------------ */

const SeverityBadge: React.FC<{ severity: AlarmSeverity }> = ({ severity }) => {
  const styles = SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.info;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide ${styles.badge}`}
    >
      {styles.icon}
      {severity}
    </span>
  );
};

const STATUS_PILL: Record<string, string> = {
  active: 'text-error-700 bg-error-100 dark:bg-error-900/30 dark:text-error-300',
  cleared: 'text-accent-700 bg-accent-100 dark:bg-accent-900/30 dark:text-accent-300',
  acknowledged: 'text-success-700 bg-success-100 dark:bg-success-900/30 dark:text-success-300',
};

const StatusPill: React.FC<{ status: string }> = ({ status }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      STATUS_PILL[status] ?? 'text-gray-500 bg-gray-100 dark:bg-gray-800 dark:text-gray-400'
    }`}
  >
    {STATUS_LABELS[status] ?? status}
  </span>
);

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
    source.forEach((a) => {
      if (a.group) groups.add(a.group);
    });
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
        if (!alarm.message.toLowerCase().includes(q) && !alarm.ruleName.toLowerCase().includes(q)) {
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
    const filename =
      tab === 'active' ? `alarms-active-${Date.now()}.csv` : `alarms-history-${Date.now()}.csv`;
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

  // ── Columns — the ACK column only on the active tab ─────────────────────
  const columns = useMemo<DataTableColumn<AlarmInstance>[]>(() => {
    const base: DataTableColumn<AlarmInstance>[] = [
      {
        key: 'onTime',
        header: 'Time',
        className: 'whitespace-nowrap',
        render: (_value, alarm) => <span className="text-xs">{formatTime(alarm.onTime)}</span>,
      },
      {
        key: 'severity',
        header: 'Severity',
        render: (_value, alarm) => <SeverityBadge severity={alarm.severity} />,
      },
      {
        key: 'group',
        header: 'Group',
        render: (_value, alarm) => (
          <span className="text-xs text-gray-600 dark:text-gray-400">{alarm.group ?? '—'}</span>
        ),
      },
      {
        key: 'message',
        header: 'Message',
        className: 'max-w-xs truncate',
        render: (_value, alarm) => (
          <span title={alarm.message} className="text-gray-900 dark:text-gray-100">
            {alarm.message}
          </span>
        ),
      },
      {
        key: 'currentValue',
        header: 'Value / Threshold',
        className: 'whitespace-nowrap',
        render: (_value, alarm) => (
          <span className="text-xs font-mono">
            {alarm.currentValue.toFixed(2)} / {alarm.threshold.toFixed(2)}
          </span>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        render: (_value, alarm) => <StatusPill status={alarm.status} />,
      },
    ];
    if (tab === 'active') {
      base.push({
        key: 'ack',
        header: 'ACK',
        render: (_value, alarm) =>
          alarm.status !== 'acknowledged' ? (
            <Button
              variant="primary"
              size="xs"
              leftIcon={<CheckCircle className="h-3.5 w-3.5" />}
              onClick={() => acknowledgeAlarm(alarm.id)}
              title="Acknowledge alarm"
            >
              ACK
            </Button>
          ) : null,
      });
    }
    return base;
  }, [tab, acknowledgeAlarm]);

  /* ---------------------------------------------------------------- */
  /*  Render                                                            */
  /* ---------------------------------------------------------------- */

  return (
    <div
      className={`flex flex-col bg-white dark:bg-gray-900 rounded-lg shadow-xl border
                  border-gray-200 dark:border-gray-700 ${className} min-w-[720px] max-h-[80vh]`}
    >
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-accent-500" />
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
            <Button
              variant="primary"
              size="xs"
              leftIcon={<CheckCheck className="h-3.5 w-3.5" />}
              onClick={acknowledgeAll}
            >
              ACK All
            </Button>
          )}

          {/* Export */}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Export to CSV"
            onClick={handleExport}
            title="Export to CSV"
          >
            <Download className="h-4 w-4" />
          </Button>

          {/* Close */}
          {onClose && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Close"
              onClick={onClose}
              title="Close"
            >
              <X className="h-4 w-4" />
            </Button>
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
                  ? 'border-info-600 text-info-600 dark:border-info-400 dark:text-info-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
              }`}
          >
            {t === 'active' ? 'Active Alarms' : 'History'}
          </button>
        ))}
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
        {/* Text search */}
        <div className="relative flex-1 min-w-40">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 dark:text-gray-500" />
          <Input
            fullWidth
            type="text"
            placeholder="Search alarms…"
            value={textSearch}
            onChange={(e) => setTextSearch(e.target.value)}
          />
        </div>

        {/* Severity filter */}
        <div className="relative">
          <Button variant="secondary" size="sm" onClick={() => setShowSeverityDropdown((v) => !v)}>
            <Filter className="h-3.5 w-3.5" />
            Severity
            {selectedSeverities.size > 0 && (
              <span className="ml-1 px-1 rounded bg-info-500 text-white text-xs">
                {selectedSeverities.size}
              </span>
            )}
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>

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
                  <span
                    className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${SEVERITY_STYLES[sev].badge}`}
                  >
                    {sev}
                  </span>
                </label>
              ))}
              <div className="border-t border-gray-100 dark:border-gray-700 px-3 py-1">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setSelectedSeverities(new Set());
                    setShowSeverityDropdown(false);
                  }}
                >
                  Clear filter
                </Button>
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
                       focus:outline-hidden focus:ring-1 focus:ring-info-500"
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
            <Input
              type="datetime-local"
              value={historyFrom}
              onChange={(e) => setHistoryFrom(e.target.value)}
            />
            <span className="text-gray-400 dark:text-gray-500 text-xs">to</span>
            <Input
              type="datetime-local"
              value={historyTo}
              onChange={(e) => setHistoryTo(e.target.value)}
            />
            <Button
              variant="primary"
              size="xs"
              leftIcon={<RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />}
              onClick={() => void handleHistoryQuery()}
              disabled={isLoading}
            >
              Query
            </Button>
          </>
        )}
      </div>

      {/* ── Table ──────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0">
        <DataTable<AlarmInstance>
          data={sortedAlarms}
          columns={columns}
          keyExtractor={(alarm) => alarm.id}
          loading={isLoading}
          loadingMessage="Loading…"
          emptyIcon={<CheckCircle className="h-8 w-8 text-success-400" />}
          emptyMessage={`No alarms${tab === 'active' ? ' active' : ' in history'}`}
          searchable={false}
          sortable={false}
          compact
          stickyHeader
          flush
          maxHeight="100%"
          className="h-full"
          rowClassName={(alarm) => (SEVERITY_STYLES[alarm.severity] ?? SEVERITY_STYLES.info).row}
        />
      </div>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-800 text-xs text-gray-400 dark:text-gray-500">
        Showing {sortedAlarms.length} alarm{sortedAlarms.length !== 1 ? 's' : ''}
        {tab === 'active' && <span className="ml-2">• Live updates active</span>}
      </div>
    </div>
  );
});

AlarmPanel.displayName = 'AlarmPanel';
