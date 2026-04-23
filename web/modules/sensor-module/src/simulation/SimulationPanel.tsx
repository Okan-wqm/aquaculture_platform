/**
 * SimulationPanel - Interactive ST code simulation panel
 *
 * Provides a watch-table UI for running IEC 61131-3 Structured Text programs
 * in the browser. Users can set VAR_INPUT values, run scan cycles (single or
 * continuous), and observe how VAR_OUTPUT and internal VAR values change.
 *
 * Designed to sit alongside the ST code editor as a "Simulation" tab.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Play,
  Pause,
  Square,
  SkipForward,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Download,
} from 'lucide-react';
import { useSimulation } from './useSimulation';
import type { SimValue } from './st-interpreter';
import type { SimulationState } from './useSimulation';
import type { VariableInfo } from './st-interpreter';
import type { VarBlockKind } from '@platform/sensor-automation-types';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface SimulationPanelProps {
  /** Current ST code from the editor */
  code: string;
}

/** Scan-cycle interval presets (milliseconds) */
const SCAN_CYCLE_OPTIONS = [50, 100, 250, 500, 1000] as const;

/** Section descriptor for the three variable groups */
interface VarSection {
  key: string;
  label: string;
  scopes: VarBlockKind[];
}

const VAR_SECTIONS: VarSection[] = [
  { key: 'inputs', label: 'GİRİŞLER (VAR_INPUT)', scopes: ['VAR_INPUT'] },
  { key: 'outputs', label: 'ÇIKIŞLAR (VAR_OUTPUT)', scopes: ['VAR_OUTPUT'] },
  { key: 'locals', label: 'DAHİLİ (VAR)', scopes: ['VAR', 'VAR_IN_OUT', 'VAR_TEMP'] },
];

// ────────────────────────────────────────────────────────────────────────────
// Status indicator config
// ────────────────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<SimulationState, { color: string; label: string }> = {
  idle: { color: 'bg-gray-400', label: 'Boşta' },
  ready: { color: 'bg-gray-400', label: 'Hazır' },
  running: { color: 'bg-green-500', label: 'Çalışıyor' },
  paused: { color: 'bg-yellow-500', label: 'Duraklatıldı' },
  error: { color: 'bg-red-500', label: 'Hata' },
};

// ────────────────────────────────────────────────────────────────────────────
// Helper: determine if a data-type string represents a BOOL
// ────────────────────────────────────────────────────────────────────────────

function isBoolType(dataType: string): boolean {
  return dataType.toUpperCase() === 'BOOL';
}

function isIntType(dataType: string): boolean {
  const upper = dataType.toUpperCase();
  return ['INT', 'DINT', 'SINT', 'UINT', 'UDINT', 'USINT', 'LINT', 'ULINT'].includes(upper);
}

function isRealType(dataType: string): boolean {
  const upper = dataType.toUpperCase();
  return ['REAL', 'LREAL'].includes(upper);
}

function isStringType(dataType: string): boolean {
  const upper = dataType.toUpperCase();
  return upper === 'STRING' || upper === 'WSTRING';
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────────

/** Status dot + label shown in the toolbar */
const StatusIndicator: React.FC<{ state: SimulationState }> = ({ state }) => {
  const { color, label } = STATUS_CONFIG[state];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-500">
      <span className={`w-2 h-2 rounded-full ${color} ${state === 'running' ? 'animate-pulse' : ''}`} />
      {label}
    </span>
  );
};

/** Toggle switch styled as a checkbox with the peer trick */
const BoolToggle: React.FC<{
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}> = ({ checked, onChange, disabled }) => (
  <label className="relative inline-flex items-center cursor-pointer">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
      className="sr-only peer"
    />
    <div
      className={
        'w-8 h-4 rounded-full transition-colors ' +
        'bg-gray-300 dark:bg-gray-600 ' +
        'peer-checked:bg-indigo-600 dark:peer-checked:bg-indigo-500 ' +
        'peer-disabled:opacity-50 peer-disabled:cursor-not-allowed ' +
        'after:content-[\'\'] after:absolute after:top-0.5 after:left-[2px] ' +
        'after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all ' +
        'peer-checked:after:translate-x-full'
      }
    />
  </label>
);

/** Bool display dot for outputs/internals */
const BoolDisplay: React.FC<{ value: boolean }> = ({ value }) => (
  <span className="inline-flex items-center gap-1.5">
    <span
      className={`w-2.5 h-2.5 rounded-full ${
        value ? 'bg-green-500' : 'bg-gray-400 dark:bg-gray-600'
      }`}
    />
    <span className={`font-mono text-xs ${value ? 'text-green-600 dark:text-green-400' : 'text-gray-500 dark:text-gray-500'}`}>
      {value ? 'TRUE' : 'FALSE'}
    </span>
  </span>
);

// ────────────────────────────────────────────────────────────────────────────
// Variable row with change-highlight support
// ────────────────────────────────────────────────────────────────────────────

const VariableInputRow: React.FC<{
  variable: VariableInfo;
  onSetInput: (name: string, value: SimValue) => void;
  highlighted: boolean;
}> = ({ variable, onSetInput, highlighted }) => {
  const { name, dataType, value } = variable;

  const renderControl = () => {
    if (isBoolType(dataType)) {
      return (
        <BoolToggle
          checked={!!value}
          onChange={(v) => onSetInput(name, v)}
        />
      );
    }

    if (isIntType(dataType)) {
      return (
        <input
          type="number"
          step={1}
          value={typeof value === 'number' ? value : 0}
          onChange={(e) => onSetInput(name, parseInt(e.target.value, 10) || 0)}
          className="w-24 px-1.5 py-0.5 text-xs font-mono rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      );
    }

    if (isRealType(dataType)) {
      return (
        <input
          type="number"
          step={0.1}
          value={typeof value === 'number' ? value : 0}
          onChange={(e) => onSetInput(name, parseFloat(e.target.value) || 0)}
          className="w-24 px-1.5 py-0.5 text-xs font-mono rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      );
    }

    if (isStringType(dataType)) {
      return (
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onSetInput(name, e.target.value)}
          className="w-32 px-1.5 py-0.5 text-xs font-mono rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      );
    }

    // Fallback: read-only display
    return <span className="text-xs font-mono text-gray-600 dark:text-gray-500">{String(value)}</span>;
  };

  return (
    <tr
      className={`transition-colors duration-500 ${
        highlighted
          ? 'bg-yellow-50 dark:bg-yellow-900/20'
          : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
      }`}
    >
      <td className="px-3 py-1.5 text-xs font-mono text-gray-900 dark:text-gray-200">{name}</td>
      <td className="px-3 py-1.5 text-xs text-gray-500 dark:text-gray-500">{dataType}</td>
      <td className="px-3 py-1.5">{renderControl()}</td>
    </tr>
  );
};

const VariableOutputRow: React.FC<{
  variable: VariableInfo;
  highlighted: boolean;
}> = ({ variable, highlighted }) => {
  const { name, dataType, value } = variable;

  const renderValue = () => {
    if (isBoolType(dataType)) {
      return <BoolDisplay value={!!value} />;
    }

    return (
      <span className="text-xs font-mono text-gray-900 dark:text-gray-200">
        {typeof value === 'number' ? value.toFixed(isRealType(dataType) ? 3 : 0) : String(value)}
      </span>
    );
  };

  return (
    <tr
      className={`transition-colors duration-500 ${
        highlighted
          ? 'bg-yellow-50 dark:bg-yellow-900/20'
          : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
      }`}
    >
      <td className="px-3 py-1.5 text-xs font-mono text-gray-900 dark:text-gray-200">{name}</td>
      <td className="px-3 py-1.5 text-xs text-gray-500 dark:text-gray-500">{dataType}</td>
      <td className="px-3 py-1.5">{renderValue()}</td>
    </tr>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// Collapsible section
// ────────────────────────────────────────────────────────────────────────────

const VariableSection: React.FC<{
  section: VarSection;
  variables: VariableInfo[];
  isInput: boolean;
  onSetInput: (name: string, value: SimValue) => void;
  changedVars: Set<string>;
}> = ({ section, variables, isInput, onSetInput, changedVars }) => {
  const [expanded, setExpanded] = useState(true);

  if (variables.length === 0) return null;

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-md overflow-hidden">
      {/* Section header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-gray-50 dark:bg-gray-900 hover:bg-gray-100 dark:hover:bg-gray-800 text-left transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-gray-500" />
        )}
        <span className="text-xs font-semibold text-gray-700 dark:text-gray-500">
          {section.label}
        </span>
        <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-500">
          {variables.length}
        </span>
      </button>

      {/* Variable table */}
      {expanded && (
        <table className="w-full">
          <thead>
            <tr className="border-t border-gray-200 dark:border-gray-700">
              <th className="px-3 py-1 text-left text-[10px] uppercase tracking-wider font-medium text-gray-500 dark:text-gray-500 w-1/3">
                Değişken
              </th>
              <th className="px-3 py-1 text-left text-[10px] uppercase tracking-wider font-medium text-gray-500 dark:text-gray-500 w-16">
                Tip
              </th>
              <th className="px-3 py-1 text-left text-[10px] uppercase tracking-wider font-medium text-gray-500 dark:text-gray-500">
                Değer
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {variables.map((v) =>
              isInput ? (
                <VariableInputRow
                  key={v.name}
                  variable={v}
                  onSetInput={onSetInput}
                  highlighted={changedVars.has(v.name)}
                />
              ) : (
                <VariableOutputRow
                  key={v.name}
                  variable={v}
                  highlighted={changedVars.has(v.name)}
                />
              ),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// Main component
// ────────────────────────────────────────────────────────────────────────────

const SimulationPanel: React.FC<SimulationPanelProps> = ({ code }) => {
  const {
    state,
    error,
    variables,
    cycleCount,
    scanCycleMs,
    load,
    runOneCycle,
    startContinuous,
    pause,
    stop,
    setInput,
    setScanCycleMs,
  } = useSimulation();

  // ── Debounced auto-load on code change ──────────────────────────────────
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!code || code.trim().length === 0) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      load(code);
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [code, load]);

  // ── Track changed variables for highlight ───────────────────────────────
  const [changedVars, setChangedVars] = useState<Set<string>>(new Set());
  const prevVarsRef = useRef<Map<string, SimValue>>(new Map());

  useEffect(() => {
    const newChanged = new Set<string>();
    for (const v of variables) {
      const prev = prevVarsRef.current.get(v.name);
      if (prev !== undefined && prev !== v.value) {
        newChanged.add(v.name);
      }
    }

    // Update prev snapshot
    const nextMap = new Map<string, SimValue>();
    for (const v of variables) {
      nextMap.set(v.name, v.value);
    }
    prevVarsRef.current = nextMap;

    if (newChanged.size > 0) {
      setChangedVars(newChanged);
      // Clear highlights after 500ms
      const timer = setTimeout(() => setChangedVars(new Set()), 500);
      return () => clearTimeout(timer);
    }
  }, [variables]);

  // ── Group variables by section ──────────────────────────────────────────
  const groupedVars = useMemo(() => {
    const groups: Record<string, VariableInfo[]> = {};
    for (const section of VAR_SECTIONS) {
      groups[section.key] = variables.filter((v) => section.scopes.includes(v.scope));
    }
    return groups;
  }, [variables]);

  // ── Button enable/disable logic ─────────────────────────────────────────
  const canLoad = state === 'idle' || state === 'error';
  const canStart = state === 'ready' || state === 'paused';
  const canPause = state === 'running';
  const canStop = state === 'running' || state === 'paused' || state === 'ready';
  const canStep = state === 'ready' || state === 'paused';

  // ── Handlers ────────────────────────────────────────────────────────────
  const handleStart = useCallback(() => {
    startContinuous(scanCycleMs);
  }, [startContinuous, scanCycleMs]);

  const handleLoadClick = useCallback(() => {
    if (code && code.trim().length > 0) {
      load(code);
    }
  }, [code, load]);

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 min-w-[300px]">
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex-shrink-0">
        {/* Row 1: Action buttons */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Load button (shown when idle/error) */}
          {(state === 'idle' || state === 'error') && (
            <button
              onClick={handleLoadClick}
              disabled={!code || code.trim().length === 0}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded transition-colors bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Kodu yükle ve hazırla"
            >
              <Download className="w-3.5 h-3.5" />
              Yükle
            </button>
          )}

          {/* Start */}
          <button
            onClick={handleStart}
            disabled={!canStart}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded transition-colors bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Sürekli çalıştır"
          >
            <Play className="w-3.5 h-3.5" />
            Başlat
          </button>

          {/* Pause */}
          <button
            onClick={pause}
            disabled={!canPause}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded transition-colors bg-yellow-600 text-white hover:bg-yellow-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Duraklat"
          >
            <Pause className="w-3.5 h-3.5" />
            Duraklat
          </button>

          {/* Stop / Reset */}
          <button
            onClick={stop}
            disabled={!canStop}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded transition-colors bg-gray-600 text-white hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Sıfırla"
          >
            <Square className="w-3.5 h-3.5" />
            Sıfırla
          </button>

          {/* Single cycle step */}
          <button
            onClick={runOneCycle}
            disabled={!canStep}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded transition-colors bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Tek cycle çalıştır"
          >
            <SkipForward className="w-3.5 h-3.5" />
            1 Cycle
          </button>
        </div>

        {/* Row 2: Cycle count, scan interval, status */}
        <div className="flex items-center gap-3 flex-wrap text-xs">
          {/* Cycle counter */}
          <span className="text-gray-600 dark:text-gray-500">
            Cycle:{' '}
            <span className="font-mono font-semibold text-gray-900 dark:text-gray-200">
              {cycleCount}
            </span>
          </span>

          {/* Scan cycle interval selector */}
          <span className="inline-flex items-center gap-1 text-gray-600 dark:text-gray-500">
            Scan:
            <select
              value={scanCycleMs}
              onChange={(e) => setScanCycleMs(Number(e.target.value))}
              className="px-1.5 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              {SCAN_CYCLE_OPTIONS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms}ms
                </option>
              ))}
            </select>
          </span>

          {/* Status indicator */}
          <StatusIndicator state={state} />
        </div>
      </div>

      {/* ── Error banner ─────────────────────────────────────────────────── */}
      {state === 'error' && error && (
        <div className="flex items-start gap-2 px-3 py-2 bg-red-50 dark:bg-red-900/30 border-b border-red-200 dark:border-red-800 flex-shrink-0">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-red-700 dark:text-red-300 break-words min-w-0">
            <span className="font-semibold">Hata:</span> {error}
          </div>
        </div>
      )}

      {/* ── Idle state placeholder ───────────────────────────────────────── */}
      {state === 'idle' && (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center text-sm text-gray-500 dark:text-gray-600">
            <Play className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>ST kodunu yükleyin ve simülasyonu başlatın</p>
            <p className="text-xs mt-1">
              Kod değiştiğinde otomatik olarak yüklenir
            </p>
          </div>
        </div>
      )}

      {/* ── Variable watch table ─────────────────────────────────────────── */}
      {state !== 'idle' && state !== 'error' && (
        <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-2">
          {VAR_SECTIONS.map((section) => {
            const vars = groupedVars[section.key] || [];
            const isInput = section.key === 'inputs';

            return (
              <VariableSection
                key={section.key}
                section={section}
                variables={vars}
                isInput={isInput}
                onSetInput={setInput}
                changedVars={changedVars}
              />
            );
          })}

          {/* Empty state when there are no variables */}
          {variables.length === 0 && (
            <div className="text-center text-xs text-gray-500 dark:text-gray-600 py-8">
              Değişken bulunamadı. ST kodunda VAR bloğu tanımlayın.
            </div>
          )}
        </div>
      )}

      {/* ── Error state: no table shown ──────────────────────────────────── */}
      {state === 'error' && (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center text-sm text-gray-500 dark:text-gray-600">
            <AlertCircle className="w-8 h-8 mx-auto mb-2 text-red-400 opacity-50" />
            <p>Simülasyon yüklenemedi</p>
            <p className="text-xs mt-1">
              Yukarıdaki hatayı düzeltip tekrar yükleyin
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default SimulationPanel;
