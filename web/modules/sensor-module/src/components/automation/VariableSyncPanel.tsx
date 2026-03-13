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
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from 'lucide-react';
import { parseStVariables, type ParsedVariable } from '../../utils/st-variable-parser';

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
  onSyncAll?: (variables: { varName: string; dataType: string; initialValue?: string; scope: string }[]) => void;
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
    missing: { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Yeni' },
    orphaned: { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Orphaned' },
    synced: { bg: 'bg-green-50', text: 'text-green-700', label: 'Synced' },
    changed: { bg: 'bg-orange-50', text: 'text-orange-700', label: 'Changed' },
  };

  const { bg, text, label } = config[status];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${bg} ${text}`}>
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
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Code className="h-4 w-4" />
          <span>
            Variables will be automatically detected when ST code is written.
          </span>
        </div>
      </div>
    );
  }

  // ── No variables detected ────────────────────────────────────────────────

  if (detectedVars.length === 0 && parseErrors.length === 0) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Code className="h-4 w-4" />
          <span>
            No variable declarations found in ST code. Define variables by adding a VAR block.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-gray-50 hover:bg-gray-100 text-left transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-gray-400 flex-shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-gray-400 flex-shrink-0" />
        )}
        <Zap className="h-4 w-4 text-indigo-500 flex-shrink-0" />
        <span className="text-sm font-medium text-gray-700">
          Variables Detected from Code
        </span>

        {/* Summary badges */}
        <div className="ml-auto flex items-center gap-2">
          {missingCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
              <Plus className="h-3 w-3" />
              {missingCount} new
            </span>
          )}
          {changedCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700">
              <RefreshCw className="h-3 w-3" />
              {changedCount} changed
            </span>
          )}
          {orphanedCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
              <AlertTriangle className="h-3 w-3" />
              {orphanedCount} orphaned
            </span>
          )}
          {!hasIssues && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
              <Check className="h-3 w-3" />
              In Sync
            </span>
          )}
          <span className="text-xs text-gray-400">
            {detectedVars.length} variables
          </span>
        </div>
      </button>

      {/* ── Parse errors ────────────────────────────────────────────────── */}
      {expanded && parseErrors.length > 0 && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-amber-700">
              <span className="font-medium">Parse warnings:</span>
              <ul className="mt-1 space-y-0.5">
                {parseErrors.slice(0, 5).map((err: { message: string; line: number; col: number }, i: number) => (
                  <li key={i}>Line {err.line}: {err.message}</li>
                ))}
                {parseErrors.length > 5 && (
                  <li>...and {parseErrors.length - 5} more warnings</li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk action bar ─────────────────────────────────────────────── */}
      {expanded && hasIssues && (
        <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 border-b border-blue-200">
          <span className="text-xs text-blue-700">
            {missingCount > 0 && `${missingCount} new`}
            {missingCount > 0 && (changedCount > 0 || orphanedCount > 0) && ', '}
            {changedCount > 0 && `${changedCount} changed`}
            {changedCount > 0 && orphanedCount > 0 && ', '}
            {orphanedCount > 0 && `${orphanedCount} orphaned`}
            {' '}variables detected.
          </span>
          <div className="ml-auto flex items-center gap-2">
            {missingCount > 0 && !onSyncAll && (
              <button
                onClick={handleAddAll}
                disabled={isAdding}
                className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {isAdding ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="h-3 w-3" />
                )}
                Add All
              </button>
            )}
            {onSyncAll && (
              <button
                onClick={handleSyncAll}
                disabled={isSyncing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {isSyncing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                Sync All
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Sync result feedback ──────────────────────────────────────── */}
      {expanded && syncResult && (
        <div className="flex items-center gap-2 px-4 py-2 bg-green-50 border-b border-green-200">
          <Check className="h-3.5 w-3.5 text-green-600 flex-shrink-0" />
          <span className="text-xs text-green-700">
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
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-2 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                  Durum
                </th>
                <th className="px-4 py-2 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                  Variable Name
                </th>
                <th className="px-4 py-2 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                  Tip
                </th>
                <th className="px-4 py-2 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                  Baslangic
                </th>
                <th className="px-4 py-2 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                  Kapsam
                </th>
                <th className="px-4 py-2 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                  Notlar
                </th>
                <th className="px-4 py-2 text-right text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                  Islem
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {comparison.map((item, idx) => {
                const varName = item.detected?.varName ?? item.registered?.varName ?? '';
                const dataType = item.detected?.dataType ?? item.registered?.dataType ?? '';
                const initialValue = item.detected?.initialValue ?? item.registered?.initialValue ?? '';
                const scope = item.detected?.scope ?? item.registered?.scope ?? '';
                const isItemAdding = addingVarNames.has(varName);
                const isItemRemoving = item.registered ? removingIds.has(item.registered.id) : false;

                const rowBg =
                  item.status === 'missing'
                    ? 'bg-blue-50/50'
                    : item.status === 'orphaned'
                      ? 'bg-amber-50/50'
                      : item.status === 'changed'
                        ? 'bg-orange-50/50'
                        : '';

                return (
                  <tr key={`${item.status}-${varName}-${idx}`} className={`${rowBg} hover:bg-gray-50`}>
                    <td className="px-4 py-2">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="px-4 py-2 text-sm font-mono text-gray-900">{varName}</td>
                    <td className="px-4 py-2 text-sm text-gray-600">{dataType}</td>
                    <td className="px-4 py-2 text-sm font-mono text-gray-500">
                      {initialValue || '-'}
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-600">{scopeLabel(scope)}</td>
                    <td className="px-4 py-2 text-xs text-gray-500">
                      {item.status === 'missing' && (
                        <span className="text-blue-600">In code, not in DB</span>
                      )}
                      {item.status === 'orphaned' && (
                        <span className="text-amber-600">In DB, not in code</span>
                      )}
                      {item.status === 'changed' && item.changes && (
                        <span className="text-orange-600">{item.changes.join('; ')}</span>
                      )}
                      {item.status === 'synced' && (
                        <span className="text-green-600">
                          <Check className="h-3 w-3 inline mr-0.5" />
                          Synced
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {item.status === 'missing' && item.detected && (
                        <button
                          onClick={() => handleAddOne(item.detected!)}
                          disabled={isItemAdding || isAdding}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                        >
                          {isItemAdding ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Plus className="h-3 w-3" />
                          )}
                          Ekle
                        </button>
                      )}
                      {item.status === 'orphaned' && item.registered && (
                        <button
                          onClick={() => handleRemoveOne(item.registered!.id)}
                          disabled={isItemRemoving || isRemoving}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
                        >
                          {isItemRemoving ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Trash2 className="h-3 w-3" />
                          )}
                          Kaldir
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}

              {comparison.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-gray-400">
                    No variables to compare.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default VariableSyncPanel;
