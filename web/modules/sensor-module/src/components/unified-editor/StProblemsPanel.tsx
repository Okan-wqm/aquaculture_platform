/**
 * StProblemsPanel - Bottom panel showing compilation errors, warnings, info
 *
 * Collapsible panel with severity filtering, sorting, and click-to-navigate.
 */

import React, { useState, useMemo, useCallback } from 'react';
import {
  XCircle,
  AlertTriangle,
  Info,
  Lightbulb,
  ChevronDown,
  ChevronUp,
  ArrowUpDown,
} from 'lucide-react';

export interface Diagnostic {
  range: { startLine: number; startCol: number; endLine: number; endCol: number };
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  code: string;
  source: string;
}

interface StProblemsPanelProps {
  diagnostics: Diagnostic[];
  onNavigate: (line: number) => void;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

const SEVERITY_ORDER: Record<Diagnostic['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

const SEVERITY_CONFIG: Record<
  Diagnostic['severity'],
  { icon: React.FC<{ className?: string }>; color: string; textColor: string; label: string }
> = {
  error: { icon: XCircle, color: 'text-red-400', textColor: 'text-red-300', label: 'Errors' },
  warning: { icon: AlertTriangle, color: 'text-yellow-400', textColor: 'text-yellow-300', label: 'Warnings' },
  info: { icon: Info, color: 'text-blue-400', textColor: 'text-blue-300', label: 'Info' },
  hint: { icon: Lightbulb, color: 'text-gray-500', textColor: 'text-gray-500', label: 'Hints' },
};

type SortKey = 'severity' | 'line';

const StProblemsPanel: React.FC<StProblemsPanelProps> = ({
  diagnostics,
  onNavigate,
  isExpanded,
  onToggleExpand,
}) => {
  const [visibleSeverities, setVisibleSeverities] = useState<Set<Diagnostic['severity']>>(
    new Set(['error', 'warning', 'info', 'hint']),
  );
  const [sortKey, setSortKey] = useState<SortKey>('severity');

  // Count by severity
  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, info: 0, hint: 0 };
    for (const d of diagnostics) {
      c[d.severity]++;
    }
    return c;
  }, [diagnostics]);

  // Filter and sort
  const filtered = useMemo(() => {
    const items = diagnostics.filter((d) => visibleSeverities.has(d.severity));
    if (sortKey === 'line') {
      items.sort((a, b) => a.range.startLine - b.range.startLine);
    } else {
      items.sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
          a.range.startLine - b.range.startLine,
      );
    }
    return items;
  }, [diagnostics, visibleSeverities, sortKey]);

  const toggleSeverity = useCallback((sev: Diagnostic['severity']) => {
    setVisibleSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(sev)) {
        next.delete(sev);
      } else {
        next.add(sev);
      }
      return next;
    });
  }, []);

  const toggleSort = useCallback(() => {
    setSortKey((prev) => (prev === 'severity' ? 'line' : 'severity'));
  }, []);

  return (
    <div className="flex flex-col bg-gray-900 border-t border-gray-700">
      {/* Header */}
      <button
        onClick={onToggleExpand}
        className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-750 text-xs flex-shrink-0 w-full text-left"
      >
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
        ) : (
          <ChevronUp className="w-3.5 h-3.5 text-gray-500" />
        )}
        <span className="text-gray-500 font-medium">PROBLEMS</span>

        {counts.error > 0 && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-900/50 text-red-300">
            {counts.error} {counts.error === 1 ? 'error' : 'errors'}
          </span>
        )}
        {counts.warning > 0 && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-900/50 text-yellow-300">
            {counts.warning} {counts.warning === 1 ? 'warning' : 'warnings'}
          </span>
        )}
        {counts.info > 0 && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-900/50 text-blue-300">
            {counts.info} info
          </span>
        )}
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="flex flex-col" style={{ height: 200 }}>
          {/* Filter bar */}
          <div className="flex items-center gap-1 px-3 py-1 border-b border-gray-800 flex-shrink-0">
            {(['error', 'warning', 'info', 'hint'] as const).map((sev) => {
              const cfg = SEVERITY_CONFIG[sev];
              const Icon = cfg.icon;
              const active = visibleSeverities.has(sev);
              return (
                <button
                  key={sev}
                  onClick={() => toggleSeverity(sev)}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                    active
                      ? `${cfg.color} bg-gray-800`
                      : 'text-gray-600 hover:text-gray-500'
                  }`}
                  title={`Toggle ${cfg.label}`}
                >
                  <Icon className="w-3 h-3" />
                  {counts[sev]}
                </button>
              );
            })}

            <div className="w-px h-3 bg-gray-700 mx-1" />

            <button
              onClick={toggleSort}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-gray-500 hover:text-gray-500 hover:bg-gray-800"
              title={`Sort by ${sortKey === 'severity' ? 'line' : 'severity'}`}
            >
              <ArrowUpDown className="w-3 h-3" />
              {sortKey === 'severity' ? 'Severity' : 'Line'}
            </button>
          </div>

          {/* Diagnostics list */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-xs text-gray-600 text-center">
                No problems found
              </div>
            )}

            {filtered.map((diag, i) => {
              const cfg = SEVERITY_CONFIG[diag.severity];
              const Icon = cfg.icon;
              return (
                <button
                  key={`${diag.code}-${diag.range.startLine}-${i}`}
                  onClick={() => onNavigate(diag.range.startLine)}
                  className="w-full text-left px-3 py-1 text-xs hover:bg-gray-800 flex items-center gap-2 border-b border-gray-800/50"
                >
                  <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${cfg.color}`} />
                  <span className="text-gray-500 w-16 flex-shrink-0 truncate font-mono">
                    {diag.code}
                  </span>
                  <span className="text-gray-500 w-12 flex-shrink-0 text-right tabular-nums">
                    Ln {diag.range.startLine}
                  </span>
                  <span className={`flex-1 min-w-0 truncate ${cfg.textColor}`}>
                    {diag.message}
                  </span>
                  <span className="text-gray-600 text-[10px] flex-shrink-0">
                    {diag.source}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default StProblemsPanel;
