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
import { DataTable, type DataTableColumn, Button } from '@aquaculture/shared-ui';
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
  running: { color: 'bg-success-500', label: 'Çalışıyor' },
  paused: { color: 'bg-warning-500', label: 'Duraklatıldı' },
  error: { color: 'bg-error-500', label: 'Hata' },
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
      <span
        className={`w-2 h-2 rounded-full ${color} ${state === 'running' ? 'animate-pulse' : ''}`}
      />
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
        'peer-checked:bg-primary-600 dark:peer-checked:bg-primary-500 ' +
        'peer-disabled:opacity-50 peer-disabled:cursor-not-allowed ' +
        "after:content-[''] after:absolute after:top-0.5 after:left-[2px] " +
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
        value ? 'bg-success-500' : 'bg-gray-400 dark:bg-gray-600'
      }`}
    />
    <span
      className={`font-mono text-xs ${value ? 'text-success-600 dark:text-success-400' : 'text-gray-500 dark:text-gray-500'}`}
    >
      {value ? 'TRUE' : 'FALSE'}
    </span>
  </span>
);

// ────────────────────────────────────────────────────────────────────────────
// Cell renderers — the value column is a control for inputs, a display otherwise
// ────────────────────────────────────────────────────────────────────────────

const INPUT_CLASS =
  'px-1.5 py-0.5 text-xs font-mono rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-hidden focus:ring-1 focus:ring-primary-500';

const VariableControl: React.FC<{
  variable: VariableInfo;
  onSetInput: (name: string, value: SimValue) => void;
}> = ({ variable, onSetInput }) => {
  const { name, dataType, value } = variable;

  if (isBoolType(dataType)) {
    return <BoolToggle checked={!!value} onChange={(v) => onSetInput(name, v)} />;
  }

  if (isIntType(dataType)) {
    return (
      <input
        type="number"
        step={1}
        value={typeof value === 'number' ? value : 0}
        onChange={(e) => onSetInput(name, parseInt(e.target.value, 10) || 0)}
        className={`w-24 ${INPUT_CLASS}`}
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
        className={`w-24 ${INPUT_CLASS}`}
      />
    );
  }

  if (isStringType(dataType)) {
    return (
      <input
        type="text"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onSetInput(name, e.target.value)}
        className={`w-32 ${INPUT_CLASS}`}
      />
    );
  }

  // Fallback: read-only display
  return (
    <span className="text-xs font-mono text-gray-600 dark:text-gray-500">{String(value)}</span>
  );
};

const VariableValue: React.FC<{ variable: VariableInfo }> = ({ variable }) => {
  const { dataType, value } = variable;

  if (isBoolType(dataType)) {
    return <BoolDisplay value={!!value} />;
  }

  return (
    <span className="text-xs font-mono text-gray-900 dark:text-gray-200">
      {typeof value === 'number' ? value.toFixed(isRealType(dataType) ? 3 : 0) : String(value)}
    </span>
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

  const columns = useMemo<DataTableColumn<VariableInfo>[]>(
    () => [
      {
        key: 'name',
        header: 'Değişken',
        width: '33%',
        render: (_value, variable) => (
          <span className="text-xs font-mono text-gray-900 dark:text-gray-200">
            {variable.name}
          </span>
        ),
      },
      {
        key: 'dataType',
        header: 'Tip',
        width: '4rem',
        render: (_value, variable) => (
          <span className="text-xs text-gray-500 dark:text-gray-500">{variable.dataType}</span>
        ),
      },
      {
        key: 'value',
        header: 'Değer',
        render: (_value, variable) =>
          isInput ? (
            <VariableControl variable={variable} onSetInput={onSetInput} />
          ) : (
            <VariableValue variable={variable} />
          ),
      },
    ],
    [isInput, onSetInput],
  );

  if (variables.length === 0) return null;

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-md overflow-hidden">
      {/* Section header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-gray-50 dark:bg-gray-900 hover:bg-gray-100 dark:hover:bg-gray-800 text-left transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
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
        <DataTable<VariableInfo>
          data={variables}
          columns={columns}
          keyExtractor={(variable) => variable.name}
          searchable={false}
          sortable={false}
          stickyHeader={false}
          compact
          flush
          rowClassName={(variable) =>
            `transition-colors duration-500 ${
              changedVars.has(variable.name)
                ? 'bg-warning-50 dark:bg-warning-900/20'
                : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
            }`
          }
        />
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
            <Button
              variant="primary"
              size="xs"
              leftIcon={<Download className="w-3.5 h-3.5" />}
              onClick={handleLoadClick}
              disabled={!code || code.trim().length === 0}
              title="Kodu yükle ve hazırla"
            >
              Yükle
            </Button>
          )}

          {/* Start */}
          <Button
            variant="primary"
            size="xs"
            leftIcon={<Play className="w-3.5 h-3.5" />}
            onClick={handleStart}
            disabled={!canStart}
            title="Sürekli çalıştır"
          >
            Başlat
          </Button>

          {/* Pause */}
          <Button
            variant="warning"
            size="xs"
            leftIcon={<Pause className="w-3.5 h-3.5" />}
            onClick={pause}
            disabled={!canPause}
            title="Duraklat"
          >
            Duraklat
          </Button>

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
          <Button
            variant="primary"
            size="xs"
            leftIcon={<SkipForward className="w-3.5 h-3.5" />}
            onClick={runOneCycle}
            disabled={!canStep}
            title="Tek cycle çalıştır"
          >
            1 Cycle
          </Button>
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
              className="px-1.5 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-hidden focus:ring-1 focus:ring-primary-500"
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
        <div className="flex items-start gap-2 px-3 py-2 bg-error-50 dark:bg-error-900/30 border-b border-error-200 dark:border-error-800 flex-shrink-0">
          <AlertCircle className="w-4 h-4 text-error-500 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-error-700 dark:text-error-300 break-words min-w-0">
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
            <p className="text-xs mt-1">Kod değiştiğinde otomatik olarak yüklenir</p>
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
            <AlertCircle className="w-8 h-8 mx-auto mb-2 text-error-400 opacity-50" />
            <p>Simülasyon yüklenemedi</p>
            <p className="text-xs mt-1">Yukarıdaki hatayı düzeltip tekrar yükleyin</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default SimulationPanel;
