/**
 * RuntimeTable — Multi-mode data table widget for SCADA operator mode.
 *
 * Modes:
 *   data    — Live tag value rows. Columns are configurable tag bindings.
 *             Rows update in real-time as tag values change.
 *   history — Historical data with date-range filter and pagination.
 *             Fetches from IDataProvider.queryHistory on demand.
 *   alarms  — Active alarm list with severity colours and ACK buttons.
 *             Reads from the operator store's activeAlarms slice.
 *
 * Features:
 *   - Sortable columns (click header)
 *   - Pagination (configurable page size)
 *   - Tailwind CSS styling only
 *   - Accessible: aria-sort, aria-label, role="table"
 *   - React.memo — only re-renders when props or sort/page state changes
 */

import React, { memo, useState, useCallback, useMemo, useEffect } from 'react';
import {
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  CheckCircle2,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import type {
  RuntimeWidgetProps,
  TagValueChange,
  AlarmInstance,
  AlarmSeverity,
  HistoricalDataPoint,
} from '../../../types/scada-runtime.types';
import { useDataProvider } from '../../../providers';
import { useOperatorStore } from '../../../store/scada/operatorStore';
import { useAlarmRuntimeStore } from '../../../hooks/useAlarmRuntime';
import { useTagWrite } from '../../../hooks/useTagWrite';
import { QualityIndicator, Button, Input } from '@aquaculture/shared-ui';

/* ------------------------------------------------------------------ */
/*  Local types                                                         */
/* ------------------------------------------------------------------ */

type TableMode = 'data' | 'history' | 'alarms';
type SortDir = 'asc' | 'desc' | 'none';

interface ColumnDef {
  key: string;
  label: string;
  tagId?: string;
  width?: number;
  format?: 'number' | 'text' | 'boolean' | 'timestamp';
  decimals?: number;
  unit?: string;
}

interface DataRow {
  id: string;
  cells: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

const ALARM_SEVERITY_BG: Record<AlarmSeverity, string> = {
  critical: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
  high: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  warning: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  info: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
};

const ALARM_SEVERITY_DOT: Record<AlarmSeverity, string> = {
  critical: 'bg-error-500',
  high: 'bg-accent-500',
  warning: 'bg-warning-500',
  info: 'bg-info-500',
};

function formatCellValue(
  val: unknown,
  format?: ColumnDef['format'],
  decimals = 2,
  unit = '',
): string {
  if (val === null || val === undefined) return '--';
  switch (format) {
    case 'number': {
      const n = Number(val);
      return isNaN(n) ? '--' : `${n.toFixed(decimals)}${unit ? ' ' + unit : ''}`;
    }
    case 'boolean':
      return val ? 'ON' : 'OFF';
    case 'timestamp': {
      const ts = Number(val);
      return isNaN(ts) ? '--' : new Date(ts).toLocaleString();
    }
    default:
      return String(val);
  }
}

function sortRows(rows: DataRow[], colKey: string, dir: SortDir): DataRow[] {
  if (dir === 'none') return rows;
  return [...rows].sort((a, b) => {
    const av = a.cells[colKey];
    const bv = b.cells[colKey];
    const an = Number(av);
    const bn = Number(bv);
    if (!isNaN(an) && !isNaN(bn)) {
      return dir === 'asc' ? an - bn : bn - an;
    }
    const as = String(av ?? '');
    const bs = String(bv ?? '');
    return dir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as);
  });
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                      */
/* ------------------------------------------------------------------ */

const SortIcon = memo<{ col: string; sortCol: string; sortDir: SortDir }>(
  ({ col, sortCol, sortDir }) => {
    if (col !== sortCol || sortDir === 'none')
      return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return sortDir === 'asc' ? (
      <ChevronUp className="w-3 h-3" />
    ) : (
      <ChevronDown className="w-3 h-3" />
    );
  },
);
SortIcon.displayName = 'SortIcon';

/* ------------------------------------------------------------------ */
/*  DataMode table                                                      */
/* ------------------------------------------------------------------ */

interface DataModeProps {
  columns: ColumnDef[];
  tagValues: Record<string, TagValueChange>;
  pageSize: number;
}

const DataModeTable = memo<DataModeProps>(({ columns, tagValues, pageSize }) => {
  const [sortCol, setSortCol] = useState('');
  const [sortDir, setSortDir] = useState<SortDir>('none');
  const [page, setPage] = useState(0);

  const handleHeaderClick = useCallback((key: string) => {
    setSortCol((prev) => {
      if (prev !== key) {
        setSortDir('asc');
        return key;
      }
      setSortDir((d) => (d === 'asc' ? 'desc' : d === 'desc' ? 'none' : 'asc'));
      return key;
    });
  }, []);

  // Build one row per "row" binding in columns (first tagId column drives rows)
  // For data mode the table shows current values: one row per tag group
  const rows: DataRow[] = useMemo(() => {
    // Each tag binding becomes a row
    const tagCols = columns.filter((c) => c.tagId);
    if (tagCols.length === 0) return [];

    // If columns map to multiple tags, produce a single row per column tag
    return tagCols.map((col) => {
      const change = tagValues[col.tagId!];
      return {
        id: col.tagId!,
        cells: {
          label: col.label,
          value: change?.value ?? null,
          quality: change?.quality ?? 'good',
          timestamp: change?.timestamp ?? null,
        },
      };
    });
  }, [columns, tagValues]);

  const sorted = useMemo(() => sortRows(rows, sortCol, sortDir), [rows, sortCol, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const pageRows = sorted.slice(page * pageSize, (page + 1) * pageSize);

  // Auto-reset page when data changes size significantly
  useEffect(() => {
    if (page >= totalPages) setPage(Math.max(0, totalPages - 1));
  }, [page, totalPages]);

  return (
    <div className="flex flex-col h-full gap-1">
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse" role="table" aria-label="Tag data">
          <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800 z-10">
            <tr>
              {(['label', 'value', 'quality', 'timestamp'] as const).map((key) => (
                <th
                  key={key}
                  scope="col"
                  className="px-2 py-1.5 text-left font-semibold text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 cursor-pointer select-none whitespace-nowrap hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  onClick={() => handleHeaderClick(key)}
                  aria-sort={
                    sortCol === key
                      ? sortDir === 'asc'
                        ? 'ascending'
                        : sortDir === 'desc'
                          ? 'descending'
                          : 'none'
                      : 'none'
                  }
                >
                  <div className="flex items-center gap-1">
                    <span className="capitalize">{key}</span>
                    <SortIcon col={key} sortCol={sortCol} sortDir={sortDir} />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-center py-6 text-gray-400 dark:text-gray-500">
                  No data
                </td>
              </tr>
            ) : (
              pageRows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-gray-100 dark:border-gray-700 hover:bg-info-50 transition-colors"
                >
                  <td className="px-2 py-1.5 font-medium text-gray-800 dark:text-gray-200 truncate max-w-[100px]">
                    {String(row.cells['label'] ?? '--')}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-gray-900 dark:text-gray-100">
                    {formatCellValue(row.cells['value'], 'number', 2)}
                  </td>
                  <td className="px-2 py-1.5">
                    <QualityIndicator
                      quality={String(row.cells['quality'] ?? 'good')}
                      size="xs"
                      tone="soft"
                    />
                  </td>
                  <td className="px-2 py-1.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {row.cells['timestamp']
                      ? new Date(Number(row.cells['timestamp'])).toLocaleTimeString()
                      : '--'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && <Paginator page={page} totalPages={totalPages} onPageChange={setPage} />}
    </div>
  );
});
DataModeTable.displayName = 'DataModeTable';

/* ------------------------------------------------------------------ */
/*  History mode table                                                  */
/* ------------------------------------------------------------------ */

interface HistoryModeProps {
  tagIds: string[];
  pageSize: number;
}

const HistoryModeTable = memo<HistoryModeProps>(({ tagIds, pageSize }) => {
  const provider = useDataProvider();

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 3_600_000); // 1 h ago

  const [fromDate, setFromDate] = useState(defaultFrom.toISOString().slice(0, 16));
  const [toDate, setToDate] = useState(now.toISOString().slice(0, 16));
  const [rows, setRows] = useState<DataRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [sortCol, setSortCol] = useState('timestamp');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);

  const fetchHistory = useCallback(async () => {
    if (tagIds.length === 0) return;
    setLoading(true);
    try {
      const result = await provider.queryHistory(tagIds, new Date(fromDate), new Date(toDate));
      // Flatten: one row per (tagId, timestamp) pair
      const newRows: DataRow[] = [];
      for (const [tagId, points] of Object.entries(result.data)) {
        for (const pt of points as HistoricalDataPoint[]) {
          newRows.push({
            id: `${tagId}_${pt.timestamp}`,
            cells: { tagId, timestamp: pt.timestamp, value: pt.value },
          });
        }
      }
      setRows(newRows);
      setPage(0);
    } catch (err) {
      console.error('[RuntimeTable] History fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [provider, tagIds, fromDate, toDate]);

  const handleHeaderClick = useCallback((key: string) => {
    setSortCol((prev) => {
      if (prev !== key) {
        setSortDir('asc');
        return key;
      }
      setSortDir((d) => (d === 'asc' ? 'desc' : d === 'desc' ? 'none' : 'asc'));
      return key;
    });
  }, []);

  const sorted = useMemo(() => sortRows(rows, sortCol, sortDir), [rows, sortCol, sortDir]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const pageRows = sorted.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Date range controls */}
      <div className="flex flex-wrap items-center gap-2 px-1 text-xs">
        <label className="flex items-center gap-1 text-gray-600 dark:text-gray-400">
          <span>From</span>
          <Input
            type="datetime-local"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-1 text-gray-600 dark:text-gray-400">
          <span>To</span>
          <Input type="datetime-local" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </label>
        <Button
          variant="primary"
          type="button"
          onClick={() => void fetchHistory()}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Fetch'}
        </Button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse" role="table" aria-label="Historical data">
          <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800 z-10">
            <tr>
              {(['tagId', 'timestamp', 'value'] as const).map((key) => (
                <th
                  key={key}
                  scope="col"
                  className="px-2 py-1.5 text-left font-semibold text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  onClick={() => handleHeaderClick(key)}
                  aria-sort={
                    sortCol === key
                      ? sortDir === 'asc'
                        ? 'ascending'
                        : sortDir === 'desc'
                          ? 'descending'
                          : 'none'
                      : 'none'
                  }
                >
                  <div className="flex items-center gap-1">
                    <span className="capitalize">{key}</span>
                    <SortIcon col={key} sortCol={sortCol} sortDir={sortDir} />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={3} className="text-center py-6 text-gray-400 dark:text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : pageRows.length === 0 ? (
              <tr>
                <td colSpan={3} className="text-center py-6 text-gray-400 dark:text-gray-500">
                  No history. Adjust range and fetch.
                </td>
              </tr>
            ) : (
              pageRows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-gray-100 dark:border-gray-700 hover:bg-info-50 transition-colors"
                >
                  <td className="px-2 py-1.5 text-gray-600 dark:text-gray-400 font-mono text-[10px] truncate max-w-[80px]">
                    {String(row.cells['tagId'] ?? '--')}
                  </td>
                  <td className="px-2 py-1.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {new Date(Number(row.cells['timestamp'])).toLocaleString()}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-gray-900 dark:text-gray-100">
                    {formatCellValue(row.cells['value'], 'number', 3)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && <Paginator page={page} totalPages={totalPages} onPageChange={setPage} />}
    </div>
  );
});
HistoryModeTable.displayName = 'HistoryModeTable';

/* ------------------------------------------------------------------ */
/*  Alarms mode table                                                   */
/* ------------------------------------------------------------------ */

const AlarmsModeTable = memo<{ pageSize: number }>(({ pageSize }) => {
  const { writeTag } = useTagWrite();

  // Live alarms come from the alarm runtime store, the store useAlarmRuntime reads.
  const activeAlarms = useAlarmRuntimeStore((s) => s.activeAlarms);

  const [sortCol, setSortCol] = useState('onTime');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);
  const [ackingId, setAckingId] = useState<string | null>(null);

  const handleHeaderClick = useCallback((key: string) => {
    setSortCol((prev) => {
      if (prev !== key) {
        setSortDir('asc');
        return key;
      }
      setSortDir((d) => (d === 'asc' ? 'desc' : d === 'desc' ? 'none' : 'asc'));
      return key;
    });
  }, []);

  const rows: DataRow[] = useMemo(
    () =>
      activeAlarms.map((a) => ({
        id: a.id,
        cells: {
          severity: a.severity,
          ruleName: a.ruleName,
          message: a.message,
          status: a.status,
          value: a.currentValue,
          onTime: a.onTime,
        },
      })),
    [activeAlarms],
  );

  const sorted = useMemo(() => sortRows(rows, sortCol, sortDir), [rows, sortCol, sortDir]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const pageRows = sorted.slice(page * pageSize, (page + 1) * pageSize);

  const handleAck = useCallback(
    async (alarmId: string, tagId: string) => {
      setAckingId(alarmId);
      try {
        // SCADA alarm ACK convention: write 1 to the alarm's tagId
        await writeTag(tagId, 1);
      } catch {
        // Surface via useTagWrite.lastError
      } finally {
        setAckingId(null);
      }
    },
    [writeTag],
  );

  const alarmForRow = useCallback(
    (rowId: string) => activeAlarms.find((a) => a.id === rowId),
    [activeAlarms],
  );

  const headers: Array<{ key: string; label: string }> = [
    { key: 'severity', label: 'Severity' },
    { key: 'ruleName', label: 'Alarm' },
    { key: 'message', label: 'Message' },
    { key: 'value', label: 'Value' },
    { key: 'status', label: 'Status' },
    { key: 'onTime', label: 'Time' },
    { key: '_ack', label: 'ACK' },
  ];

  return (
    <div className="flex flex-col h-full gap-1">
      {activeAlarms.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-6 text-success-600 dark:text-success-400">
          <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
          <span className="text-xs">No active alarms</span>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse" role="table" aria-label="Active alarms">
          <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800 z-10">
            <tr>
              {headers.map(({ key, label }) => (
                <th
                  key={key}
                  scope="col"
                  onClick={() => key !== '_ack' && handleHeaderClick(key)}
                  className={[
                    'px-2 py-1.5 text-left font-semibold text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 whitespace-nowrap',
                    key !== '_ack'
                      ? 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors'
                      : '',
                  ].join(' ')}
                  aria-sort={
                    key !== '_ack' && sortCol === key
                      ? sortDir === 'asc'
                        ? 'ascending'
                        : sortDir === 'desc'
                          ? 'descending'
                          : 'none'
                      : 'none'
                  }
                >
                  <div className="flex items-center gap-1">
                    <span>{label}</span>
                    {key !== '_ack' && <SortIcon col={key} sortCol={sortCol} sortDir={sortDir} />}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => {
              const alarm = alarmForRow(row.id);
              const severity = row.cells['severity'] as AlarmSeverity;
              const bgClass =
                ALARM_SEVERITY_BG[severity] ??
                'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300';
              const dotClass = ALARM_SEVERITY_DOT[severity] ?? 'bg-gray-500';
              return (
                <tr
                  key={row.id}
                  className="border-b border-gray-100 dark:border-gray-700 hover:bg-accent-50 transition-colors"
                >
                  <td className="px-2 py-1.5">
                    <span
                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${bgClass}`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotClass}`}
                        aria-hidden="true"
                      />
                      {severity}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 font-medium text-gray-800 dark:text-gray-200 truncate max-w-[120px]">
                    {String(row.cells['ruleName'] ?? '--')}
                  </td>
                  <td className="px-2 py-1.5 text-gray-600 dark:text-gray-400 truncate max-w-[160px]">
                    {String(row.cells['message'] ?? '--')}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-gray-900 dark:text-gray-100">
                    {formatCellValue(row.cells['value'], 'number', 2)}
                  </td>
                  <td className="px-2 py-1.5">
                    <span
                      className={`text-[10px] uppercase font-medium ${
                        row.cells['status'] === 'active'
                          ? 'text-error-600 dark:text-error-400'
                          : row.cells['status'] === 'acknowledged'
                            ? 'text-success-600 dark:text-success-400'
                            : 'text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {String(row.cells['status'] ?? '--')}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {row.cells['onTime']
                      ? new Date(Number(row.cells['onTime'])).toLocaleTimeString()
                      : '--'}
                  </td>
                  <td className="px-2 py-1.5">
                    {alarm && alarm.status !== 'acknowledged' && (
                      <Button
                        variant="primary"
                        leftIcon={<CheckCircle2 className="w-3 h-3" aria-hidden="true" />}
                        type="button"
                        disabled={ackingId === row.id}
                        onClick={() => void handleAck(row.id, alarm.ruleId)}
                        aria-label={`Acknowledge alarm ${alarm.ruleName}`}
                      >
                        ACK
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && <Paginator page={page} totalPages={totalPages} onPageChange={setPage} />}
    </div>
  );
});
AlarmsModeTable.displayName = 'AlarmsModeTable';

/* ------------------------------------------------------------------ */
/*  Paginator                                                           */
/* ------------------------------------------------------------------ */

const Paginator = memo<{
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}>(({ page, totalPages, onPageChange }) => (
  <div
    className="flex items-center justify-center gap-2 py-1 border-t border-gray-100 dark:border-gray-700"
    role="navigation"
    aria-label="Table pagination"
  >
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      type="button"
      disabled={page === 0}
      onClick={() => onPageChange(page - 1)}
      aria-label="Previous page"
    >
      <ChevronLeft className="w-3 h-3" />
    </Button>
    <span className="text-xs text-gray-600 dark:text-gray-400">
      {page + 1} / {totalPages}
    </span>
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      type="button"
      disabled={page >= totalPages - 1}
      onClick={() => onPageChange(page + 1)}
      aria-label="Next page"
    >
      <ChevronRight className="w-3 h-3" />
    </Button>
  </div>
));
Paginator.displayName = 'Paginator';

/* ------------------------------------------------------------------ */
/*  RuntimeTable                                                        */
/* ------------------------------------------------------------------ */

interface RuntimeTableProps extends RuntimeWidgetProps {
  /** Tag IDs for history mode queries. Passed by RuntimeWidgetRenderer. */
  tagIds?: string[];
}

const RuntimeTable: React.FC<RuntimeTableProps> = ({
  config,
  tagIds,
  tagValues = {},
  isEnabled,
}) => {
  const mode = (config.mode ?? 'data') as TableMode;
  const pageSize = Number(config.pageSize ?? 10);
  const columns = (config.columns ?? []) as ColumnDef[];
  const title = (config.title ?? '') as string;

  /* ---- mode tab selector ---- */
  const [activeMode, setActiveMode] = useState<TableMode>(mode);

  const modes: TableMode[] = ['data', 'history', 'alarms'];

  return (
    <div
      className="w-full h-full flex flex-col bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded overflow-hidden"
      aria-label={title || 'Data table'}
      role="region"
      style={{ opacity: isEnabled ? 1 : 0.6, pointerEvents: isEnabled ? 'auto' : 'none' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 gap-2 flex-shrink-0">
        {title && (
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 truncate">
            {title}
          </span>
        )}
        <div className="flex items-center gap-0.5 ml-auto" role="tablist" aria-label="Table mode">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={activeMode === m}
              onClick={() => setActiveMode(m)}
              className={[
                'px-2 py-0.5 text-[10px] font-medium rounded capitalize transition-colors',
                activeMode === m
                  ? 'bg-info-500 text-white'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600',
              ].join(' ')}
            >
              {m === 'alarms' ? (
                <span className="flex items-center gap-0.5">
                  <AlertTriangle className="w-2.5 h-2.5" aria-hidden="true" />
                  {m}
                </span>
              ) : (
                m
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden p-1">
        {activeMode === 'data' && (
          <DataModeTable columns={columns} tagValues={tagValues} pageSize={pageSize} />
        )}
        {activeMode === 'history' && <HistoryModeTable tagIds={tagIds ?? []} pageSize={pageSize} />}
        {activeMode === 'alarms' && <AlarmsModeTable pageSize={pageSize} />}
      </div>
    </div>
  );
};

RuntimeTable.displayName = 'RuntimeTable';
export default memo(RuntimeTable);
