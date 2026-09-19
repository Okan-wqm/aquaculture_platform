/**
 * VariableSyncPanel — Auto-detect variables from ST code and sync with backend
 *
 * Parses the current ST code to find variable declarations, compares them
 * against the registered (saved in DB) variables, and presents:
 *
 * 1. "Missing" variables: detected in code but not registered — user can add them
 * 2. "Orphaned" variables: registered in DB but no longer in code — user can remove them
 * 3. "Synced" variables: present in both code and DB — shown as matched
 * 4. "Changed" variables: same name but different type/scope — shown with diff
 *
 * The panel is designed to sit above the existing variable table in the Variables tab.
 */

import React, { useMemo, useState, useCallback } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Code,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from 'lucide-react';
import { parseStVariables, type ParsedVariable } from '../../utils/st-variable-parser';
import { DataTable, type DataTableColumn, Spinner, Button } from '@aquaculture/shared-ui';

type DetectedVariable = ParsedVariable;

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface RegisteredVariable {
  id: string;
  varName: string;
  dataType: string;
  initialValue?: string;
  scope: string;
  description?: string;
  ioTagName?: string;
  ioConfigId?: string;
}

interface SyncResult {
  added: number;
  removed: number;
  updated: number;
  unchanged: number;
}

interface VariableSyncPanelProps {
  /** Current ST code from the editor */
  stCode: string;
  /** Variables already registered in the backend */
  registeredVariables: RegisteredVariable[];
  /** Callback to add a single variable to the backend */
  onAddVariable: (variable: {
    varName: string;
    dataType: string;
    initialValue?: string;
    scope: string;
  }) => void;
  /** Callback to remove a variable from the backend by id */
  onRemoveVariable: (id: string) => void;
  /** Callback to bulk-sync all variables at once */
  onSyncAll?: (
    variables: { varName: string; dataType: string; initialValue?: string; scope: string }[],
  ) => void;
  /** Whether an add mutation is currently in progress */
  isAdding?: boolean;
  /** Whether a remove mutation is currently in progress */
  isRemoving?: boolean;
  /** Whether a bulk sync mutation is currently in progress */
  isSyncing?: boolean;
  /** Result of the last bulk sync operation */
  syncResult?: SyncResult | null;
}

type SyncStatus = 'missing' | 'orphaned' | 'synced' | 'changed';

interface ComparedVariable {
  status: SyncStatus;
  detected?: DetectedVariable;
  registered?: RegisteredVariable;
  changes?: string[]; // Human-readable list of differences
}

// ────────────────────────────────────────────────────────────────────────────
// Comparison logic
// ────────────────────────────────────────────────────────────────────────────

function compareVariables(
  detected: DetectedVariable[],
  registered: RegisteredVariable[],
): ComparedVariable[] {
  const result: ComparedVariable[] = [];

  // Build lookup maps (case-insensitive — ST is case-insensitive)
  const registeredMap = new Map<string, RegisteredVariable>();
  for (const v of registered) {
    registeredMap.set(v.varName.toUpperCase(), v);
  }

  const detectedMap = new Map<string, DetectedVariable>();
  for (const v of detected) {
    detectedMap.set(v.varName.toUpperCase(), v);
  }

  // Check each detected variable
  for (const det of detected) {
    const key = det.varName.toUpperCase();
    const reg = registeredMap.get(key);

    if (!reg) {
      result.push({ status: 'missing', detected: det });
    } else {
      // Check for differences
      const changes: string[] = [];
      if (reg.dataType.toUpperCase() !== det.dataType.toUpperCase()) {
        changes.push(`Type: ${reg.dataType} -> ${det.dataType}`);
      }
      if (reg.scope.toUpperCase() !== det.scope.toUpperCase()) {
        changes.push(`Scope: ${reg.scope} -> ${det.scope}`);
      }

      if (changes.length > 0) {
        result.push({ status: 'changed', detected: det, registered: reg, changes });
      } else {
        result.push({ status: 'synced', detected: det, registered: reg });
      }
    }
  }

  // Check for orphaned variables (registered but not in code)
  for (const reg of registered) {
    const key = reg.varName.toUpperCase();
    if (!detectedMap.has(key)) {
      // Skip variables with I/O bindings — they may be intentionally manual
      // and shouldn't be flagged as orphaned just because code doesn't declare them
      if (reg.ioTagName || reg.ioConfigId) {
        continue;
      }
      result.push({ status: 'orphaned', registered: reg });
    }
  }

  // Sort: missing first, then changed, then orphaned, then synced
  const order: Record<SyncStatus, number> = { missing: 0, changed: 1, orphaned: 2, synced: 3 };
  result.sort((a, b) => order[a.status] - order[b.status]);

  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Scope display helper
// ────────────────────────────────────────────────────────────────────────────

const SCOPE_DISPLAY: Record<string, string> = {
  LOCAL: 'LOCAL',
  INPUT: 'INPUT',
  OUTPUT: 'OUTPUT',
  INOUT: 'INOUT',
  RETAIN: 'RETAIN',
  CONSTANT: 'CONSTANT',
};

function scopeLabel(scope: string): string {
  return SCOPE_DISPLAY[scope.toUpperCase()] ?? scope;
}

// ────────────────────────────────────────────────────────────────────────────
// Status badge component
// ────────────────────────────────────────────────────────────────────────────

const StatusBadge: React.FC<{ status: SyncStatus }> = ({ status }) => {
  const config: Record<SyncStatus, { bg: string; text: string; label: string }> = {
    missing: {
      bg: 'bg-info-50 dark:bg-info-900/20',
      text: 'text-info-700 dark:text-info-300',
      label: 'Yeni',
    },
    orphaned: {
      bg: 'bg-warning-50 dark:bg-warning-900/20',
      text: 'text-warning-700 dark:text-warning-300',
      label: 'Orphaned',
    },
    synced: {
      bg: 'bg-success-50 dark:bg-success-900/20',
      text: 'text-success-700 dark:text-success-300',
      label: 'Synced',
    },
    changed: {
      bg: 'bg-accent-50 dark:bg-accent-900/20',
      text: 'text-accent-700 dark:text-accent-300',
      label: 'Changed',
    },
  };

  const { bg, text, label } = config[status];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${bg} ${text}`}
    >
      {label}
    </span>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// Main component
// ────────────────────────────────────────────────────────────────────────────

const VariableSyncPanel: React.FC<VariableSyncPanelProps> = ({
  stCode,
  registeredVariables,
  onAddVariable,
  onRemoveVariable,
  onSyncAll,
  isAdding = false,
  isRemoving = false,
  isSyncing = false,
  syncResult = null,
}) => {
  const [expanded, setExpanded] = useState(true);
  const [addingVarNames, setAddingVarNames] = useState<Set<string>>(new Set());
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());

  // Parse ST code and extract variables
  const { variables: detectedVars, errors: parseErrors } = useMemo(
    () => parseStVariables(stCode),
    [stCode],
  );

  // Compare detected vs registered
  const comparison = useMemo(
    () => compareVariables(detectedVars, registeredVariables),
    [detectedVars, registeredVariables],
  );

  // Summary counts
  const missingCount = comparison.filter((c) => c.status === 'missing').length;
  const orphanedCount = comparison.filter((c) => c.status === 'orphaned').length;
  const changedCount = comparison.filter((c) => c.status === 'changed').length;

  const hasIssues = missingCount > 0 || orphanedCount > 0 || changedCount > 0;
  const hasCode = stCode && stCode.trim().length > 0;

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleAddOne = useCallback(
    (det: DetectedVariable) => {
      setAddingVarNames((prev) => new Set(prev).add(det.varName));
      onAddVariable({
        varName: det.varName,
        dataType: det.dataType,
        initialValue: det.initialValue,
        scope: det.scope,
      });
      // Clear from tracking after a short delay (mutation will invalidate query)
      setTimeout(() => {
        setAddingVarNames((prev) => {
          const next = new Set(prev);
          next.delete(det.varName);
          return next;
        });
      }, 2000);
    },
    [onAddVariable],
  );

  const handleAddAll = useCallback(() => {
    const missing = comparison.filter((c) => c.status === 'missing');
    for (const item of missing) {
      if (item.detected) {
        handleAddOne(item.detected);
      }
    }
  }, [comparison, handleAddOne]);

  const handleRemoveOne = useCallback(
    (id: string) => {
      setRemovingIds((prev) => new Set(prev).add(id));
      onRemoveVariable(id);
      setTimeout(() => {
        setRemovingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 2000);
    },
    [onRemoveVariable],
  );

  const handleSyncAll = useCallback(() => {
    if (!onSyncAll) return;
    const allDetected = detectedVars.map((v) => ({
      varName: v.varName,
      dataType: v.dataType,
      initialValue: v.initialValue,
      scope: v.scope,
    }));
    onSyncAll(allDetected);
  }, [onSyncAll, detectedVars]);

  // ── Don't show panel if there's no ST code ───────────────────────────────

  if (!hasCode) {
    return (
      <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Code className="h-4 w-4" />
          <span>Variables will be automatically detected when ST code is written.</span>
        </div>
      </div>
    );
  }

  // ── No variables detected ────────────────────────────────────────────────

  if (detectedVars.length === 0 && parseErrors.length === 0) {
    return (
      <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Code className="h-4 w-4" />
          <span>
            No variable declarations found in ST code. Define variables by adding a VAR block.
          </span>
        </div>
      </div>
    );
  }

  type ItemRow = (typeof comparison)[number];
  const itemRowColumns: DataTableColumn<ItemRow>[] = [
    {
      key: 'durum',
      header: 'Durum',
      render: (_value, item) => <StatusBadge status={item.status} />,
    },
    {
      key: 'variableName',
      header: 'Variable Name',
      render: (_value, item) => {
        const varName = item.detected?.varName ?? item.registered?.varName ?? '';
        return <>{varName}</>;
      },
    },
    {
      key: 'tip',
      header: 'Tip',
      render: (_value, item) => {
        const dataType = item.detected?.dataType ?? item.registered?.dataType ?? '';
        return <>{dataType}</>;
      },
    },
    {
      key: 'baslangic',
      header: 'Baslangic',
      render: (_value, item) => {
        const initialValue = item.detected?.initialValue ?? item.registered?.initialValue ?? '';
        return <>{initialValue || '-'}</>;
      },
    },
    {
      key: 'kapsam',
      header: 'Kapsam',
      render: (_value, item) => {
        const scope = item.detected?.scope ?? item.registered?.scope ?? '';
        return <>{scopeLabel(scope)}</>;
      },
    },
    {
      key: 'notlar',
      header: 'Notlar',
      render: (_value, item) => (
        <>
          {item.status === 'missing' && (
            <span className="text-info-600 dark:text-info-400">In code, not in DB</span>
          )}
          {item.status === 'orphaned' && (
            <span className="text-warning-600 dark:text-warning-400">In DB, not in code</span>
          )}
          {item.status === 'changed' && item.changes && (
            <span className="text-accent-600 dark:text-accent-400">{item.changes.join('; ')}</span>
          )}
          {item.status === 'synced' && (
            <span className="text-success-600 dark:text-success-400">
              <Check className="h-3 w-3 inline mr-0.5" />
              Synced
            </span>
          )}
        </>
      ),
    },
    {
      key: 'islem',
      header: 'Islem',
      align: 'right',
      render: (_value, item) => {
        const varName = item.detected?.varName ?? item.registered?.varName ?? '';
        const isItemAdding = addingVarNames.has(varName);
        const isItemRemoving = item.registered ? removingIds.has(item.registered.id) : false;
        return (
          <>
            {item.status === 'missing' && item.detected && (
              <Button
                variant="primary"
                size="xs"
                onClick={() => handleAddOne(item.detected!)}
                disabled={isItemAdding || isAdding}
              >
                {isItemAdding ? (
                  <Spinner size="sm" color="inherit" />
                ) : (
                  <Plus className="h-3 w-3" />
                )}
                Ekle
              </Button>
            )}
            {item.status === 'orphaned' && item.registered && (
              <Button
                variant="warning"
                size="xs"
                onClick={() => handleRemoveOne(item.registered!.id)}
                disabled={isItemRemoving || isRemoving}
              >
                {isItemRemoving ? (
                  <Spinner size="sm" color="inherit" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
                Kaldir
              </Button>
            )}
          </>
        );
      },
    },
  ];

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 text-left transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-gray-500 dark:text-gray-400 flex-shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-gray-500 dark:text-gray-400 flex-shrink-0" />
        )}
        <Zap className="h-4 w-4 text-primary-500 flex-shrink-0" />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Variables Detected from Code
        </span>

        {/* Summary badges */}
        <div className="ml-auto flex items-center gap-2">
          {missingCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300">
              <Plus className="h-3 w-3" />
              {missingCount} new
            </span>
          )}
          {changedCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300">
              <RefreshCw className="h-3 w-3" />
              {changedCount} changed
            </span>
          )}
          {orphanedCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300">
              <AlertTriangle className="h-3 w-3" />
              {orphanedCount} orphaned
            </span>
          )}
          {!hasIssues && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300">
              <Check className="h-3 w-3" />
              In Sync
            </span>
          )}
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {detectedVars.length} variables
          </span>
        </div>
      </button>

      {/* ── Parse errors ────────────────────────────────────────────────── */}
      {expanded && parseErrors.length > 0 && (
        <div className="px-4 py-2 bg-warning-50 dark:bg-warning-900/20 border-b border-warning-200 dark:border-warning-800">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-warning-500 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-warning-700 dark:text-warning-300">
              <span className="font-medium">Parse warnings:</span>
              <ul className="mt-1 space-y-0.5">
                {parseErrors
                  .slice(0, 5)
                  .map((err: { message: string; line: number; col: number }, i: number) => (
                    <li key={i}>
                      Line {err.line}: {err.message}
                    </li>
                  ))}
                {parseErrors.length > 5 && <li>...and {parseErrors.length - 5} more warnings</li>}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk action bar ─────────────────────────────────────────────── */}
      {expanded && hasIssues && (
        <div className="flex items-center gap-2 px-4 py-2 bg-info-50 dark:bg-info-900/20 border-b border-info-200 dark:border-info-800">
          <span className="text-xs text-info-700 dark:text-info-300">
            {missingCount > 0 && `${missingCount} new`}
            {missingCount > 0 && (changedCount > 0 || orphanedCount > 0) && ', '}
            {changedCount > 0 && `${changedCount} changed`}
            {changedCount > 0 && orphanedCount > 0 && ', '}
            {orphanedCount > 0 && `${orphanedCount} orphaned`} variables detected.
          </span>
          <div className="ml-auto flex items-center gap-2">
            {missingCount > 0 && !onSyncAll && (
              <Button variant="primary" size="xs" onClick={handleAddAll} disabled={isAdding}>
                {isAdding ? <Spinner size="sm" color="inherit" /> : <Plus className="h-3 w-3" />}
                Add All
              </Button>
            )}
            {onSyncAll && (
              <Button variant="primary" size="xs" onClick={handleSyncAll} disabled={isSyncing}>
                {isSyncing ? (
                  <Spinner size="sm" color="inherit" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                Sync All
              </Button>
            )}
          </div>
        </div>
      )}

      {/* ── Sync result feedback ──────────────────────────────────────── */}
      {expanded && syncResult && (
        <div className="flex items-center gap-2 px-4 py-2 bg-success-50 dark:bg-success-900/20 border-b border-success-200 dark:border-success-800">
          <Check className="h-3.5 w-3.5 text-success-600 dark:text-success-400 flex-shrink-0" />
          <span className="text-xs text-success-700 dark:text-success-300">
            Sync complete:
            {syncResult.added > 0 && ` ${syncResult.added} added`}
            {syncResult.updated > 0 && ` ${syncResult.updated} updated`}
            {syncResult.removed > 0 && ` ${syncResult.removed} removed`}
            {syncResult.unchanged > 0 && ` ${syncResult.unchanged} unchanged`}
          </span>
        </div>
      )}

      {/* ── Comparison table ────────────────────────────────────────────── */}
      {expanded && (
        <DataTable<ItemRow>
          data={comparison}
          columns={itemRowColumns}
          keyExtractor={(item, idx) =>
            String(
              `${item.status}-${item.detected?.varName ?? item.registered?.varName ?? ''}-${idx}`,
            )
          }
          emptyMessage="No variables to compare."
          searchable={false}
          sortable={false}
          stickyHeader={false}
          compact
          rowClassName={(item) =>
            item.status === 'missing'
              ? 'bg-info-50/50 dark:bg-info-900/20/50'
              : item.status === 'orphaned'
                ? 'bg-warning-50/50 dark:bg-warning-900/20/50'
                : item.status === 'changed'
                  ? 'bg-accent-50/50 dark:bg-accent-900/20/50'
                  : ''
          }
        />
      )}
    </div>
  );
};

export default VariableSyncPanel;
