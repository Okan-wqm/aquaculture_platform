/**
 * SimulationSidebar — Main simulation panel for SCADA builder.
 *
 * Four sections:
 *   A. Tag Values — inject/modify simulation tag values
 *   B. Scenarios — preset and custom tag value scenarios
 *   C. Alarms — real-time alarm rule evaluation display
 *   D. Automation — run ST programs in closed-loop simulation
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Play,
  Pause,
  Square,
  Zap,
  AlertTriangle,
  BookOpen,
  Save,
  Trash2,
  Settings,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { getTenantId, tenantScopedStorageKey } from '@aquaculture/shared-ui';
import { useScadaStore } from '../../store/scada';
import { useAlarmEvaluation } from '../../hooks/useAlarmEvaluation';
import { useSimulation } from '../../simulation';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface TagInfo {
  tagName: string;
  widgetType: string;
  label?: string;
  dataHint: 'boolean' | 'number' | 'string';
  min?: number;
  max?: number;
}

interface Scenario {
  id: string;
  name: string;
  values: Record<string, any>;
  isBuiltIn?: boolean;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-orange-500 text-white',
  warning: 'bg-yellow-400 text-gray-900',
  info: 'bg-blue-500 text-white',
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function inferDataHint(widgetType: string): TagInfo['dataHint'] {
  const booleanTypes = ['toggleSwitch', 'pushButton', 'indicator', 'statusLight'];
  if (booleanTypes.includes(widgetType)) return 'boolean';
  if (widgetType === 'textDisplay' || widgetType === 'label') return 'string';
  return 'number';
}

function getMinMax(config: Record<string, any>): { min?: number; max?: number } {
  return {
    min: typeof config.min === 'number' ? config.min : undefined,
    max: typeof config.max === 'number' ? config.max : undefined,
  };
}

// Returns null when no tenant is resolved so callers no-op rather than writing
// to a shared 'default' bucket that would bleed scenarios across tenants.
function getScenarioStorageKey(): string | null {
  return tenantScopedStorageKey('scada-sim-scenarios', getTenantId());
}

function loadCustomScenarios(): Scenario[] {
  const key = getScenarioStorageKey();
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCustomScenarios(scenarios: Scenario[]) {
  const key = getScenarioStorageKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(scenarios));
}

/* ------------------------------------------------------------------ */
/*  Collapsible Section                                                */
/* ------------------------------------------------------------------ */

const Section: React.FC<{
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  badge?: string | number;
  children: React.ReactNode;
}> = ({ title, icon, defaultOpen = true, badge, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-gray-700">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-gray-300 hover:bg-gray-750 transition-colors"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {icon}
        <span className="flex-1 text-left">{title}</span>
        {badge !== undefined && (
          <span className="px-1.5 py-0.5 rounded-full bg-gray-600 text-gray-200 text-[10px] font-medium">
            {badge}
          </span>
        )}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Tag Value Row                                                      */
/* ------------------------------------------------------------------ */

const TagRow: React.FC<{
  tag: TagInfo;
  value: any;
  onChange: (tagName: string, value: any) => void;
  changed: boolean;
}> = ({ tag, value, onChange, changed }) => {
  const bgClass = changed ? 'bg-yellow-900/30' : '';

  return (
    <div
      className={`flex items-center gap-2 py-1 px-1 rounded transition-colors duration-500 ${bgClass}`}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-gray-300 truncate" title={tag.tagName}>
          {tag.tagName}
        </div>
        <div className="text-[10px] text-gray-400">{tag.widgetType}</div>
      </div>
      <div className="flex-shrink-0">
        {tag.dataHint === 'boolean' && (
          <button
            onClick={() => onChange(tag.tagName, !value)}
            aria-label={`Toggle ${tag.tagName}`}
            aria-pressed={!!value}
            className={`relative w-8 h-4 rounded-full transition-colors ${
              value ? 'bg-cyan-500' : 'bg-gray-600'
            }`}
          >
            <span
              className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                value ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        )}
        {tag.dataHint === 'number' && (
          <div className="flex items-center gap-1">
            <input
              type="range"
              min={tag.min ?? 0}
              max={tag.max ?? 100}
              step={1}
              value={typeof value === 'number' ? value : 0}
              onChange={(e) => onChange(tag.tagName, Number(e.target.value))}
              className="w-16 h-1 accent-cyan-500"
            />
            <input
              type="number"
              value={typeof value === 'number' ? value : 0}
              onChange={(e) => onChange(tag.tagName, Number(e.target.value))}
              className="w-14 px-1 py-0.5 text-[11px] bg-gray-700 border border-gray-600 rounded text-gray-200 text-right"
            />
          </div>
        )}
        {tag.dataHint === 'string' && (
          <input
            type="text"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(tag.tagName, e.target.value)}
            className="w-24 px-1 py-0.5 text-[11px] bg-gray-700 border border-gray-600 rounded text-gray-200"
          />
        )}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

export const SimulationSidebar: React.FC = () => {
  const {
    screens,
    simTagValues,
    setSimTagValue,
    setSimTagValuesBatch,
    clearSimTagValues,
    alarmRules,
    setSimAlarms,
    automationBindings,
  } = useScadaStore(
    useShallow((s) => ({
      screens: s.screens,
      simTagValues: s.simTagValues,
      setSimTagValue: s.setSimTagValue,
      setSimTagValuesBatch: s.setSimTagValuesBatch,
      clearSimTagValues: s.clearSimTagValues,
      alarmRules: s.alarmRules,
      setSimAlarms: s.setSimAlarms,
      automationBindings: s.automationBindings,
    })),
  );

  // Track recently changed tags for highlight (500ms yellow fade)
  const [changedTags, setChangedTags] = useState<Set<string>>(new Set());
  const prevValuesRef = useRef<Record<string, any>>({});

  useEffect(() => {
    const changed = new Set<string>();
    for (const [key, val] of Object.entries(simTagValues)) {
      if (prevValuesRef.current[key] !== val) {
        changed.add(key);
      }
    }
    // Always update ref to prevent double-detection
    prevValuesRef.current = { ...simTagValues };
    if (changed.size > 0) {
      setChangedTags(changed);
      const timer = setTimeout(() => setChangedTags(new Set()), 500);
      return () => clearTimeout(timer);
    }
  }, [simTagValues]);

  // ── Collect all tags from widgets ──
  const allTags = useMemo<TagInfo[]>(() => {
    const tagMap = new Map<string, TagInfo>();
    for (const screen of screens) {
      for (const widget of screen.widgets) {
        const tagName = (widget.config?.tagName || widget.config?.tag) as string | undefined;
        if (!tagName || tagMap.has(tagName)) continue;
        tagMap.set(tagName, {
          tagName,
          widgetType: widget.widgetType,
          label: (widget.config?.label as string) || undefined,
          dataHint: inferDataHint(widget.widgetType),
          ...getMinMax(widget.config || {}),
        });
      }
    }
    return Array.from(tagMap.values()).sort((a, b) => a.tagName.localeCompare(b.tagName));
  }, [screens]);

  // ── Tag value change handler ──
  const handleTagChange = useCallback(
    (tagName: string, value: any) => {
      setSimTagValue(tagName, value);
    },
    [setSimTagValue],
  );

  // ── Scenarios ──
  const [customScenarios, setCustomScenarios] = useState<Scenario[]>(loadCustomScenarios);
  const [newScenarioName, setNewScenarioName] = useState('');

  const builtInScenarios = useMemo<Scenario[]>(() => {
    const scenarios: Scenario[] = [];
    const boolTags = allTags.filter((t) => t.dataHint === 'boolean');
    const numTags = allTags.filter((t) => t.dataHint === 'number');

    // Normal Operation
    const normalValues: Record<string, any> = {};
    for (const t of boolTags) {
      const isPump = t.widgetType.toLowerCase().includes('pump') || t.tagName.toLowerCase().includes('pump');
      const isValve = t.widgetType.toLowerCase().includes('valve') || t.tagName.toLowerCase().includes('valve');
      normalValues[t.tagName] = isPump || isValve;
    }
    for (const t of numTags) {
      const mid = ((t.min ?? 0) + (t.max ?? 100)) / 2;
      normalValues[t.tagName] = Math.round(mid);
    }
    scenarios.push({ id: '__normal__', name: 'Normal Operation', values: normalValues, isBuiltIn: true });

    // Pump Fault
    if (boolTags.some((t) => t.tagName.toLowerCase().includes('pump') || t.widgetType.toLowerCase().includes('pump'))) {
      const faultValues = { ...normalValues };
      const pumpTag = boolTags.find((t) => t.tagName.toLowerCase().includes('pump') || t.widgetType.toLowerCase().includes('pump'));
      if (pumpTag) faultValues[pumpTag.tagName] = false;
      const faultNum = numTags.find((t) => t.tagName.toLowerCase().includes('fault') || t.tagName.toLowerCase().includes('pump'));
      if (faultNum) faultValues[faultNum.tagName] = -1;
      scenarios.push({ id: '__pump_fault__', name: 'Pump Fault', values: faultValues, isBuiltIn: true });
    }

    // Tank Overflow
    if (numTags.some((t) => t.tagName.toLowerCase().includes('tank') || t.tagName.toLowerCase().includes('level'))) {
      const overflowValues = { ...normalValues };
      for (const t of numTags) {
        if (t.tagName.toLowerCase().includes('tank') || t.tagName.toLowerCase().includes('level')) {
          overflowValues[t.tagName] = Math.round((t.max ?? 100) * 0.95);
        }
      }
      scenarios.push({ id: '__tank_overflow__', name: 'Tank Overflow', values: overflowValues, isBuiltIn: true });
    }

    // All Stop
    const stopValues: Record<string, any> = {};
    for (const t of allTags) {
      stopValues[t.tagName] = t.dataHint === 'boolean' ? false : 0;
    }
    scenarios.push({ id: '__all_stop__', name: 'All Stop', values: stopValues, isBuiltIn: true });

    return scenarios;
  }, [allTags]);

  const handleApplyScenario = useCallback(
    (scenario: Scenario) => {
      setSimTagValuesBatch(scenario.values);
    },
    [setSimTagValuesBatch],
  );

  const handleSaveScenario = useCallback(() => {
    if (!newScenarioName.trim()) return;
    const scenario: Scenario = {
      id: crypto.randomUUID(),
      name: newScenarioName.trim(),
      values: { ...simTagValues },
    };
    const updated = [...customScenarios, scenario];
    setCustomScenarios(updated);
    saveCustomScenarios(updated);
    setNewScenarioName('');
  }, [newScenarioName, simTagValues, customScenarios]);

  const handleDeleteScenario = useCallback(
    (id: string) => {
      const updated = customScenarios.filter((s) => s.id !== id);
      setCustomScenarios(updated);
      saveCustomScenarios(updated);
    },
    [customScenarios],
  );

  // ── Alarm Evaluation ──
  const getSimTagValue = useCallback(
    (tag: string) => simTagValues[tag],
    [simTagValues],
  );

  const firedAlarms = useAlarmEvaluation(alarmRules, getSimTagValue);

  // Sync fired alarms to store
  useEffect(() => {
    setSimAlarms(
      firedAlarms.map((a) => ({
        ruleId: a.ruleId,
        severity: a.severity,
        message: a.message,
        firedAt: a.firedAt,
      })),
    );
  }, [firedAlarms, setSimAlarms]);

  // ── Automation Programs ──
  const simulation = useSimulation();
  const [activeProgram, setActiveProgram] = useState<string | null>(null);
  const [scanInterval, setScanInterval] = useState(100);
  const automationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanIntervalRef = useRef(scanInterval);
  scanIntervalRef.current = scanInterval;
  const [automationError, setAutomationError] = useState<string | null>(null);

  /** Stop any running automation interval */
  const stopAutomation = useCallback(() => {
    if (automationIntervalRef.current) {
      clearInterval(automationIntervalRef.current);
      automationIntervalRef.current = null;
    }
    simulation.stop();
    setActiveProgram(null);
    setAutomationError(null);
  }, [simulation]);

  /**
   * Run one closed-loop tick: feed inputs from simTagValues, execute one ST cycle,
   * read outputs back. Extracted to avoid duplication between handleStartProgram
   * and the scanInterval restart effect.
   *
   * Returns false if the simulation mode was turned off (caller should stop interval).
   * Throws if ST runtime error occurs (caller must catch).
   */
  const runClosedLoopTick = useCallback(
    (programId: string): boolean => {
      const store = useScadaStore.getState();
      // Guard: simulation mode might have been turned off
      if (!store.simulationMode) {
        return false;
      }

      const currentBinding = store.automationBindings.find((b) => b.programId === programId);
      if (!currentBinding) return true; // binding gone, but sim mode still on — skip tick

      // 1. Feed INPUT and INOUT variables from simTagValues
      for (const vb of currentBinding.variableBindings) {
        if ((vb.scope === 'INPUT' || vb.scope === 'INOUT') && vb.boundTag) {
          const val = store.simTagValues[vb.boundTag];
          if (val !== undefined && val !== null) {
            simulation.setInputDirect(vb.varName, val);
          }
        }
      }

      // 2. Run one cycle directly (no React state update per tick)
      const success = simulation.runOneCycleDirect();
      if (!success) {
        // runOneCycleDirect returns false on ST runtime error (it sets error state internally).
        // Re-throw so the caller's try/catch can handle UI cleanup.
        throw new Error(
          'ST runtime error: error occurred while executing program',
        );
      }

      // 3. Read OUTPUT and INOUT variables synchronously from interpreter
      const snapshot = simulation.getVariableSnapshot();
      for (const vb of currentBinding.variableBindings) {
        if ((vb.scope === 'OUTPUT' || vb.scope === 'INOUT') && vb.boundTag) {
          const varInfo = snapshot.find(
            (v) => v.name.toLowerCase() === vb.varName.toLowerCase(),
          );
          if (varInfo) {
            store.setSimTagValue(vb.boundTag, varInfo.value);
          }
        }
      }

      return true;
    },
    [simulation],
  );

  const handleStartProgram = useCallback(
    (programId: string) => {
      // Guard: already running this program
      if (activeProgram === programId) return;

      // Stop any previously running program first
      if (automationIntervalRef.current) {
        clearInterval(automationIntervalRef.current);
        automationIntervalRef.current = null;
        simulation.stop();
      }

      const binding = automationBindings.find((b) => b.programId === programId);
      if (!binding) return;

      simulation.load(binding.programCode);

      // Check if load succeeded (interpreter is ready)
      // simulation.state is async, but interpreterRef is set synchronously by load()
      // Use getVariableSnapshot to verify — if empty after load, the program failed
      const vars = simulation.getVariableSnapshot();
      if (vars.length === 0) {
        // Load failed — don't start interval
        return;
      }

      setActiveProgram(programId);
      setAutomationError(null);

      // Start closed-loop cycle using the extracted tick function
      automationIntervalRef.current = setInterval(() => {
        try {
          const continueRunning = runClosedLoopTick(programId);
          if (!continueRunning) {
            if (automationIntervalRef.current) {
              clearInterval(automationIntervalRef.current);
              automationIntervalRef.current = null;
            }
          }
        } catch (err) {
          // ST runtime error — stop the interval and surface the error
          if (automationIntervalRef.current) {
            clearInterval(automationIntervalRef.current);
            automationIntervalRef.current = null;
          }
          const message = err instanceof Error ? err.message : String(err);
          setAutomationError(`ST runtime error: ${message}`);
          setActiveProgram(null);
          simulation.stop();
        }
      }, scanIntervalRef.current);
    },
    [automationBindings, simulation, activeProgram, runClosedLoopTick],
  );

  // Restart interval when scan interval changes during active run
  useEffect(() => {
    if (activeProgram && automationIntervalRef.current) {
      clearInterval(automationIntervalRef.current);
      // Re-create with new interval using extracted tick function
      const programId = activeProgram;
      automationIntervalRef.current = setInterval(() => {
        try {
          const continueRunning = runClosedLoopTick(programId);
          if (!continueRunning) {
            if (automationIntervalRef.current) {
              clearInterval(automationIntervalRef.current);
              automationIntervalRef.current = null;
            }
          }
        } catch (err) {
          if (automationIntervalRef.current) {
            clearInterval(automationIntervalRef.current);
            automationIntervalRef.current = null;
          }
          const message = err instanceof Error ? err.message : String(err);
          setAutomationError(`ST runtime error: ${message}`);
          setActiveProgram(null);
          simulation.stop();
        }
      }, scanInterval);
    }
  }, [scanInterval, activeProgram, simulation, runClosedLoopTick]);

  // Periodically flush cycle count to React state for UI updates (every 500ms)
  useEffect(() => {
    if (!activeProgram) return;
    const flushInterval = setInterval(() => {
      simulation.flushCycleCount();
    }, 500);
    return () => clearInterval(flushInterval);
  }, [activeProgram, simulation]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (automationIntervalRef.current) {
        clearInterval(automationIntervalRef.current);
      }
    };
  }, []);

  return (
    <div className="w-72 bg-gray-800 border-l border-gray-700 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-700 flex items-center gap-2">
        <Zap className="w-4 h-4 text-cyan-400" />
        <span className="text-sm font-semibold text-gray-200">Simulation</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* A. Tag Values */}
        <Section title="Tag Values" icon={<Settings className="w-3 h-3" />} badge={allTags.length}>
          {allTags.length === 0 ? (
            <p className="text-[11px] text-gray-400 italic">Assign tags to widgets</p>
          ) : (
            <>
              <div className="space-y-0.5">
                {allTags.map((tag) => (
                  <TagRow
                    key={tag.tagName}
                    tag={tag}
                    value={simTagValues[tag.tagName]}
                    onChange={handleTagChange}
                    changed={changedTags.has(tag.tagName)}
                  />
                ))}
              </div>
              <button
                onClick={clearSimTagValues}
                className="mt-2 flex items-center gap-1 px-2 py-1 text-[11px] text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                Reset All
              </button>
            </>
          )}
        </Section>

        {/* B. Scenarios */}
        <Section title="Scenarios" icon={<BookOpen className="w-3 h-3" />} defaultOpen={false}>
          <div className="space-y-1">
            {builtInScenarios.map((sc) => (
              <button
                key={sc.id}
                onClick={() => handleApplyScenario(sc)}
                className="w-full text-left px-2 py-1.5 text-[11px] text-gray-300 hover:bg-gray-700 rounded transition-colors"
              >
                {sc.name}
              </button>
            ))}
            {customScenarios.length > 0 && (
              <>
                <div className="h-px bg-gray-700 my-1" />
                {customScenarios.map((sc) => (
                  <div key={sc.id} className="flex items-center gap-1">
                    <button
                      onClick={() => handleApplyScenario(sc)}
                      className="flex-1 text-left px-2 py-1.5 text-[11px] text-gray-300 hover:bg-gray-700 rounded transition-colors truncate"
                    >
                      {sc.name}
                    </button>
                    <button
                      onClick={() => handleDeleteScenario(sc.id)}
                      aria-label="Delete scenario"
                      className="p-1 text-gray-400 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>
          <div className="mt-2 flex items-center gap-1">
            <input
              type="text"
              value={newScenarioName}
              onChange={(e) => setNewScenarioName(e.target.value)}
              placeholder="Scenario name..."
              className="flex-1 px-2 py-1 text-[11px] bg-gray-700 border border-gray-600 rounded text-gray-200 placeholder-gray-500"
              onKeyDown={(e) => e.key === 'Enter' && handleSaveScenario()}
            />
            <button
              onClick={handleSaveScenario}
              disabled={!newScenarioName.trim()}
              className="p-1 text-gray-400 hover:text-cyan-400 disabled:opacity-30 transition-colors"
              aria-label="Save current values as scenario"
              title="Save current values as scenario"
            >
              <Save className="w-3.5 h-3.5" />
            </button>
          </div>
        </Section>

        {/* C. Active Alarms */}
        <Section
          title="Active Alarms"
          icon={<AlertTriangle className="w-3 h-3" />}
          badge={firedAlarms.length > 0 ? firedAlarms.length : undefined}
        >
          {alarmRules.length === 0 ? (
            <p className="text-[11px] text-gray-400 italic">No alarm rules defined</p>
          ) : firedAlarms.length === 0 ? (
            <p className="text-[11px] text-green-400">No alarms triggered</p>
          ) : (
            <div className="space-y-1.5">
              {firedAlarms.map((alarm) => (
                <div
                  key={alarm.ruleId}
                  className="p-2 rounded bg-gray-750 border border-gray-600"
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                        SEVERITY_COLORS[alarm.severity] || 'bg-gray-600 text-gray-200'
                      }`}
                    >
                      {alarm.severity.toUpperCase()}
                    </span>
                    <span className="text-[11px] text-gray-200 truncate">{alarm.message}</span>
                  </div>
                  <div className="text-[10px] text-gray-400">
                    {alarm.tag}: {alarm.currentValue} {alarm.condition} {alarm.threshold}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* D. Automation Programs */}
        {automationBindings.length > 0 && (
          <Section
            title="Automation Programs"
            icon={<Play className="w-3 h-3" />}
            badge={automationBindings.length}
            defaultOpen={false}
          >
            {/* Scan interval selector */}
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] text-gray-400">Scan:</span>
              <select
                value={scanInterval}
                onChange={(e) => setScanInterval(Number(e.target.value))}
                className="text-[10px] bg-gray-700 border border-gray-600 rounded px-1 py-0.5 text-gray-200"
              >
                {[50, 100, 250, 500, 1000].map((ms) => (
                  <option key={ms} value={ms}>
                    {ms}ms
                  </option>
                ))}
              </select>
            </div>

            {automationError && (
              <div className="mb-2 p-2 rounded bg-red-900/40 border border-red-700 text-[11px] text-red-300 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-red-400" />
                <div>
                  <div className="font-medium text-red-200 mb-0.5">Program stopped</div>
                  <div>{automationError}</div>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {automationBindings.map((binding) => {
                const isActive = activeProgram === binding.programId;
                const boundCount = binding.variableBindings.filter((v) => v.boundTag).length;
                const totalCount = binding.variableBindings.length;

                return (
                  <div
                    key={binding.programId}
                    className="p-2 rounded bg-gray-750 border border-gray-600"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] text-gray-200 font-medium truncate">
                        {binding.programName}
                      </span>
                      <span className="text-[10px] text-gray-400">
                        {boundCount}/{totalCount}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {!isActive ? (
                        <button
                          onClick={() => handleStartProgram(binding.programId)}
                          className="flex items-center gap-1 px-2 py-0.5 text-[10px] bg-green-600 hover:bg-green-700 text-white rounded transition-colors"
                        >
                          <Play className="w-3 h-3" />
                          Run
                        </button>
                      ) : (
                        <button
                          onClick={stopAutomation}
                          className="flex items-center gap-1 px-2 py-0.5 text-[10px] bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
                        >
                          <Square className="w-3 h-3" />
                          Stop
                        </button>
                      )}
                      {isActive && (
                        <span className="text-[9px] text-green-400 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                          Cycle: {simulation.cycleCount}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
};
