/**
 * SCADA Builder Properties Panel
 * Right sidebar with tabbed interface for widget config, alarms, controls, trends,
 * events, and animations.
 */

import React, { useState, useCallback } from 'react';
import { Settings, Plus, Trash2 } from 'lucide-react';
import { widgetConfigMap } from './widget-configs';
import { GeneralPropertiesSection } from './widget-configs/GeneralPropertiesSection';
import { WidgetPermissionsSection } from './widget-configs/WidgetPermissionsSection';
import { EventsPanel } from './widget-configs/EventsPanel';
import { AnimationsPanel } from './widget-configs/AnimationsPanel';
import { ScriptsPanel } from './widget-configs/ScriptsPanel';
import { AutomationBindingPanel } from './AutomationBindingPanel';
import { CONNECTION_TYPES, type ConnectionType } from '../../config/connectionTypes';
import type { ScadaEdge, ScadaEdgeType, ScadaEdgeData } from '../../types/scada-edge.types';
import type { WidgetEventDef, ScadaScript } from '../../engine/events/types';
import type { AnimationRule } from '../../engine/animation/types';
import type { ScreenWidget, WidgetPosition } from '../../types/scada-package.types';
import type { WidgetPermissions } from '../../types/scada-widget.types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AlarmRule {
  id: string;
  tag: string;
  condition: string;
  value: number;
  severity: 'critical' | 'high' | 'warning' | 'info';
  message: string;
  deadband?: number;
  delay?: number;
}

interface ControlSecurityConfig {
  none: string[];
  confirm: string[];
  pin: string[];
}

interface EmergencyStopConfig {
  holdDuration: number;
  affectedTags: string[];
  resetRequiresPin: boolean;
}

interface TrendConfig {
  retentionDays: number;
  sampleIntervalSec: number;
  tags: string[];
}

interface SelectedWidget {
  id: string;
  type: string;
  config: Record<string, unknown>;
  /** Human-readable name for identification in layers panel. */
  name?: string;
  /** Grid position and size. */
  position: WidgetPosition;
  /** When true the widget cannot be moved or resized. */
  locked?: boolean;
  /** When false the widget is hidden on canvas and at runtime. Defaults true. */
  visible?: boolean;
  /** Per-widget role-based access control (ISA-101). */
  permissions?: WidgetPermissions;
  events?: WidgetEventDef[];
  animations?: AnimationRule[];
}

interface PropertiesPanelProps {
  selectedWidget?: SelectedWidget | null;
  onWidgetConfigChange?: (widgetId: string, updates: Record<string, unknown>) => void;
  /** Updates top-level ScreenWidget fields (name, position, locked, visible, permissions). */
  onWidgetUpdate?: (widgetId: string, updates: Partial<ScreenWidget>) => void;
  alarmRules?: AlarmRule[];
  onAlarmRulesChange?: (rules: AlarmRule[]) => void;
  controlSecurity?: ControlSecurityConfig;
  onControlSecurityChange?: (config: ControlSecurityConfig) => void;
  emergencyStop?: EmergencyStopConfig;
  onEmergencyStopChange?: (config: EmergencyStopConfig) => void;
  trendConfig?: TrendConfig;
  onTrendConfigChange?: (config: TrendConfig) => void;
  deviceId?: string | null;
  selectedEdge?: ScadaEdge | null;
  onEdgeDataChange?: (edgeId: string, updates: Partial<ScadaEdgeData>) => void;
  onEdgeTypeChange?: (edgeId: string, type: ScadaEdgeType) => void;
  onEdgeDelete?: (edgeId: string) => void;
  onWidgetEventsChange?: (widgetId: string, events: WidgetEventDef[]) => void;
  onWidgetAnimationsChange?: (widgetId: string, animations: AnimationRule[]) => void;
  /** Package-level scripts for the Scripts tab and runScript action selector. */
  scripts?: ScadaScript[];
  onScriptsChange?: (scripts: ScadaScript[]) => void;
  onTestScript?: (scriptId: string) => void;
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

type TabId = 'widget' | 'alarms' | 'control' | 'trend' | 'automation' | 'events' | 'animations' | 'scripts';

const TABS: { id: TabId; label: string }[] = [
  { id: 'widget', label: 'Widget' },
  { id: 'alarms', label: 'Alarms' },
  { id: 'control', label: 'Control' },
  { id: 'trend', label: 'Trend' },
  { id: 'automation', label: 'Auto' },
  { id: 'events', label: 'Events' },
  { id: 'animations', label: 'Anim' },
  { id: 'scripts', label: 'Scripts' },
];

const CONDITIONS = ['>', '<', '>=', '<=', '==', '!='];
const SEVERITIES = ['critical', 'high', 'warning', 'info'];

const DEFAULT_ALARM_RULES: AlarmRule[] = [];
const DEFAULT_CONTROL_SECURITY: ControlSecurityConfig = { none: [], confirm: [], pin: [] };
const DEFAULT_EMERGENCY_STOP: EmergencyStopConfig = { holdDuration: 3000, affectedTags: [], resetRequiresPin: false };
const DEFAULT_TREND_CONFIG: TrendConfig = { retentionDays: 30, sampleIntervalSec: 60, tags: [] };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PropertiesPanel: React.FC<PropertiesPanelProps> = ({
  selectedWidget = null,
  onWidgetConfigChange,
  onWidgetUpdate,
  alarmRules = DEFAULT_ALARM_RULES,
  onAlarmRulesChange,
  controlSecurity = DEFAULT_CONTROL_SECURITY,
  onControlSecurityChange,
  emergencyStop = DEFAULT_EMERGENCY_STOP,
  onEmergencyStopChange,
  trendConfig = DEFAULT_TREND_CONFIG,
  onTrendConfigChange,
  deviceId,
  selectedEdge,
  onEdgeDataChange,
  onEdgeTypeChange,
  onEdgeDelete,
  onWidgetEventsChange,
  onWidgetAnimationsChange,
  scripts = [],
  onScriptsChange,
  onTestScript,
}) => {
  const [activeTab, setActiveTab] = useState<TabId>('widget');

  // --- Alarm helpers -------------------------------------------------------
  const addAlarmRule = () => {
    const rule: AlarmRule = {
      id: crypto.randomUUID(),
      tag: '',
      condition: '>',
      value: 0,
      severity: 'warning',
      message: '',
    };
    onAlarmRulesChange?.([...alarmRules, rule]);
  };

  const updateAlarmRule = (id: string, field: string, value: string | number | undefined) => {
    onAlarmRulesChange?.(
      alarmRules.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
    );
  };

  const removeAlarmRule = (id: string) => {
    onAlarmRulesChange?.(alarmRules.filter((r) => r.id !== id));
  };

  // --- Control helpers -----------------------------------------------------
  const addTagToLevel = (level: keyof ControlSecurityConfig) => {
    onControlSecurityChange?.({
      ...controlSecurity,
      [level]: [...controlSecurity[level], ''],
    });
  };

  const updateTagInLevel = (level: keyof ControlSecurityConfig, index: number, value: string) => {
    const updated = controlSecurity[level].map((t, i) => (i === index ? value : t));
    onControlSecurityChange?.({ ...controlSecurity, [level]: updated });
  };

  const removeTagFromLevel = (level: keyof ControlSecurityConfig, index: number) => {
    onControlSecurityChange?.({
      ...controlSecurity,
      [level]: controlSecurity[level].filter((_, i) => i !== index),
    });
  };

  // --- Emergency stop helpers ----------------------------------------------
  const addAffectedTag = () => {
    onEmergencyStopChange?.({
      ...emergencyStop,
      affectedTags: [...emergencyStop.affectedTags, ''],
    });
  };

  const updateAffectedTag = (index: number, value: string) => {
    const updated = emergencyStop.affectedTags.map((t, i) => (i === index ? value : t));
    onEmergencyStopChange?.({ ...emergencyStop, affectedTags: updated });
  };

  const removeAffectedTag = (index: number) => {
    onEmergencyStopChange?.({
      ...emergencyStop,
      affectedTags: emergencyStop.affectedTags.filter((_, i) => i !== index),
    });
  };

  // --- Trend tag helpers ---------------------------------------------------
  const addTrendTag = () => {
    onTrendConfigChange?.({ ...trendConfig, tags: [...trendConfig.tags, ''] });
  };

  const updateTrendTag = (index: number, value: string) => {
    const updated = trendConfig.tags.map((t, i) => (i === index ? value : t));
    onTrendConfigChange?.({ ...trendConfig, tags: updated });
  };

  const removeTrendTag = (index: number) => {
    onTrendConfigChange?.({
      ...trendConfig,
      tags: trendConfig.tags.filter((_, i) => i !== index),
    });
  };

  // --- Render helpers ------------------------------------------------------
  const ConfigComponent = selectedWidget ? widgetConfigMap[selectedWidget.type] : null;

  return (
    <div className="w-80 bg-white border-l border-gray-200 flex flex-col h-full">
      {/* Tab Header */}
      <div className="flex border-b border-gray-200 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 px-1.5 py-2.5 text-[10px] font-medium transition-colors whitespace-nowrap ${
              activeTab === tab.id
                ? 'text-cyan-700 border-b-2 border-cyan-600 bg-cyan-50'
                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* ===== Widget Tab =====
         *
         * The Widget tab now has a 3-layer sandwich structure:
         * 1. GeneralPropertiesSection (name, position, size, lock, visible)
         * 2. Per-widget ConfigComponent (from widgetConfigMap)
         * 3. WidgetPermissionsSection (role-based show/enable)
         *
         * This ensures every widget type gets general + permission controls
         * without modifying any individual config component.
         */}
        {activeTab === 'widget' && (
          <>
            {selectedWidget && ConfigComponent && onWidgetConfigChange ? (
              <div>
                {/* Layer 1: General properties (identity + spatial) */}
                {onWidgetUpdate && (
                  <GeneralPropertiesSection
                    widgetId={selectedWidget.id}
                    widgetType={selectedWidget.type}
                    name={selectedWidget.name ?? ''}
                    x={selectedWidget.position.col}
                    y={selectedWidget.position.row}
                    w={selectedWidget.position.w}
                    h={selectedWidget.position.h}
                    locked={selectedWidget.locked ?? false}
                    visible={selectedWidget.visible ?? true}
                    onUpdate={(updates) => onWidgetUpdate(selectedWidget.id, updates)}
                  />
                )}

                {/* Layer 2: Per-widget type-specific config */}
                <ConfigComponent
                  config={selectedWidget.config}
                  onChange={(updates: Record<string, unknown>) => onWidgetConfigChange(selectedWidget.id, updates)}
                  deviceId={deviceId}
                />

                {/* Layer 3: Per-widget permissions (ISA-101 RBAC) */}
                {onWidgetUpdate && (
                  <WidgetPermissionsSection
                    permissions={selectedWidget.permissions ?? { showRoles: [], enableRoles: [] }}
                    onChange={(permissions) => onWidgetUpdate(selectedWidget.id, { permissions })}
                  />
                )}
              </div>
            ) : selectedEdge && onEdgeDataChange ? (
              <div className="space-y-4">
                <h4 className="text-sm font-medium text-gray-700">Connection Properties</h4>

                {/* Connection Type */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Connection Type</label>
                  <select
                    value={selectedEdge.data.connectionType}
                    onChange={(e) => onEdgeDataChange(selectedEdge.id, { connectionType: e.target.value as ConnectionType })}
                    className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  >
                    {CONNECTION_TYPES.map((ct) => (
                      <option key={ct.id} value={ct.id}>{ct.label}</option>
                    ))}
                  </select>
                </div>

                {/* Edge Type */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Line Type</label>
                  <div className="flex gap-1">
                    {([
                      { type: 'orthogonal' as const, label: 'Orthogonal' },
                      { type: 'multiHandle' as const, label: 'Polyline' },
                      { type: 'draggable' as const, label: 'Bezier' },
                    ]).map((opt) => (
                      <button
                        key={opt.type}
                        onClick={() => onEdgeTypeChange?.(selectedEdge.id, opt.type)}
                        className={`flex-1 px-2 py-1.5 text-xs rounded border transition-colors ${
                          selectedEdge.type === opt.type
                            ? 'bg-cyan-50 border-cyan-300 text-cyan-700 font-medium'
                            : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Label */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Label</label>
                  <input
                    type="text"
                    value={selectedEdge.data.label || ''}
                    onChange={(e) => onEdgeDataChange(selectedEdge.id, { label: e.target.value || undefined })}
                    placeholder="Connection label"
                    className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  />
                </div>

                {/* Animated Flow Toggle */}
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="edgeAnimated"
                    checked={!!selectedEdge.data.animated}
                    onChange={(e) => onEdgeDataChange(selectedEdge.id, { animated: e.target.checked })}
                    className="text-cyan-600 rounded focus:ring-cyan-500"
                  />
                  <label htmlFor="edgeAnimated" className="text-xs text-gray-700">
                    Animated flow
                  </label>
                </div>

                {/* Connection Info */}
                <div className="pt-3 border-t border-gray-200">
                  <p className="text-[10px] text-gray-500">
                    Source: {selectedEdge.source} ({selectedEdge.sourceHandle})
                  </p>
                  <p className="text-[10px] text-gray-500">
                    Target: {selectedEdge.target} ({selectedEdge.targetHandle})
                  </p>
                </div>

                {/* Delete Button */}
                <button
                  onClick={() => onEdgeDelete?.(selectedEdge.id)}
                  className="w-full mt-2 px-3 py-2 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors flex items-center justify-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete Connection
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center text-gray-500 py-12">
                <Settings className="w-10 h-10 mb-3 text-gray-500" />
                <p className="text-sm">Select a widget</p>
                <p className="text-xs mt-1">Select a widget from the canvas</p>
              </div>
            )}
          </>
        )}

        {/* ===== Alarms Tab ===== */}
        {activeTab === 'alarms' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-gray-700">Alarm Rules</h4>
              <button
                onClick={addAlarmRule}
                className="flex items-center gap-1 text-xs text-cyan-600 hover:text-cyan-700"
              >
                <Plus className="w-3 h-3" />
                Add Alarm
              </button>
            </div>

            {alarmRules.length === 0 && (
              <p className="text-xs text-gray-500 py-4 text-center">No alarm rules yet</p>
            )}

            {alarmRules.map((rule) => (
              <div key={rule.id} className="p-3 bg-gray-50 rounded-lg space-y-2 border border-gray-100">
                <div className="flex items-center justify-between">
                  <select
                    value={rule.severity}
                    onChange={(e) => updateAlarmRule(rule.id, 'severity', e.target.value)}
                    className={`text-xs font-medium rounded px-2 py-1 border-0 ${
                      rule.severity === 'critical' ? 'bg-red-100 text-red-700' :
                      rule.severity === 'high' ? 'bg-orange-100 text-orange-700' :
                      rule.severity === 'warning' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-blue-100 text-blue-700'
                    }`}
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => removeAlarmRule(rule.id)}
                    className="text-red-400 hover:text-red-600"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <input
                  type="text"
                  value={rule.tag}
                  onChange={(e) => updateAlarmRule(rule.id, 'tag', e.target.value)}
                  placeholder="Tag"
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
                <div className="flex gap-1">
                  <select
                    value={rule.condition}
                    onChange={(e) => updateAlarmRule(rule.id, 'condition', e.target.value)}
                    className="w-16 px-1 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  >
                    {CONDITIONS.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    value={rule.value}
                    onChange={(e) => updateAlarmRule(rule.id, 'value', Number(e.target.value))}
                    className="flex-1 px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  />
                </div>
                <input
                  type="text"
                  value={rule.message}
                  onChange={(e) => updateAlarmRule(rule.id, 'message', e.target.value)}
                  placeholder="Alarm message"
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
                <div className="flex gap-1">
                  <div className="flex-1">
                    <label className="block text-[10px] text-gray-500 mb-0.5">Deadband</label>
                    <input
                      type="number"
                      value={rule.deadband ?? ''}
                      onChange={(e) => updateAlarmRule(rule.id, 'deadband', e.target.value === '' ? undefined : Number(e.target.value))}
                      placeholder="Hysteresis value"
                      min={0}
                      step={0.1}
                      className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-[10px] text-gray-500 mb-0.5">Delay (sec)</label>
                    <input
                      type="number"
                      value={rule.delay ?? ''}
                      onChange={(e) => updateAlarmRule(rule.id, 'delay', e.target.value === '' ? undefined : Number(e.target.value))}
                      placeholder="Seconds"
                      min={0}
                      step={1}
                      className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ===== Control Tab ===== */}
        {activeTab === 'control' && (
          <div className="space-y-4">
            <h4 className="text-sm font-medium text-gray-700">Security Levels</h4>

            {(['none', 'confirm', 'pin'] as const).map((level) => (
              <div key={level} className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-gray-600 capitalize">
                    {level === 'none' ? 'No Security' : level === 'confirm' ? 'Confirmation Required' : 'PIN Required'}
                  </label>
                  <button
                    onClick={() => addTagToLevel(level)}
                    className="text-xs text-cyan-600 hover:text-cyan-700"
                  >
                    + Add
                  </button>
                </div>
                {controlSecurity[level].map((tag, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <input
                      type="text"
                      value={tag}
                      onChange={(e) => updateTagInLevel(level, i, e.target.value)}
                      placeholder="tag.name"
                      className="flex-1 px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    />
                    <button
                      onClick={() => removeTagFromLevel(level, i)}
                      className="text-red-400 hover:text-red-600 text-xs px-1"
                    >
                      X
                    </button>
                  </div>
                ))}
              </div>
            ))}

            {/* Emergency Stop Config */}
            <div className="pt-3 border-t border-gray-200 space-y-2">
              <h5 className="text-xs font-medium text-gray-600">Emergency Stop</h5>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Hold Duration (ms)</label>
                <input
                  type="number"
                  min={500}
                  step={100}
                  value={emergencyStop.holdDuration}
                  onChange={(e) => onEmergencyStopChange?.({ ...emergencyStop, holdDuration: Number(e.target.value) })}
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-gray-500">Affected Tags</label>
                  <button onClick={addAffectedTag} className="text-xs text-cyan-600 hover:text-cyan-700">
                    + Add
                  </button>
                </div>
                {emergencyStop.affectedTags.map((tag, i) => (
                  <div key={i} className="flex items-center gap-1 mb-1">
                    <input
                      type="text"
                      value={tag}
                      onChange={(e) => updateAffectedTag(i, e.target.value)}
                      placeholder="tag.name"
                      className="flex-1 px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    />
                    <button
                      onClick={() => removeAffectedTag(i)}
                      className="text-red-400 hover:text-red-600 text-xs px-1"
                    >
                      X
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="resetRequiresPin"
                  checked={emergencyStop.resetRequiresPin}
                  onChange={(e) => onEmergencyStopChange?.({ ...emergencyStop, resetRequiresPin: e.target.checked })}
                  className="text-cyan-600 rounded focus:ring-cyan-500"
                />
                <label htmlFor="resetRequiresPin" className="text-xs text-gray-700">
                  PIN required for reset
                </label>
              </div>
            </div>
          </div>
        )}

        {/* ===== Trend Tab ===== */}
        {activeTab === 'trend' && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-gray-700">Trend Settings</h4>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Retention Period (days)</label>
              <input
                type="number"
                min={1}
                value={trendConfig.retentionDays}
                onChange={(e) => onTrendConfigChange?.({ ...trendConfig, retentionDays: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Sampling Interval (sec)</label>
              <input
                type="number"
                min={1}
                value={trendConfig.sampleIntervalSec}
                onChange={(e) => onTrendConfigChange?.({ ...trendConfig, sampleIntervalSec: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-gray-500">Tags</label>
                <button onClick={addTrendTag} className="text-xs text-cyan-600 hover:text-cyan-700">
                  + Add Tag
                </button>
              </div>
              <div className="space-y-1">
                {trendConfig.tags.map((tag, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <input
                      type="text"
                      value={tag}
                      onChange={(e) => updateTrendTag(i, e.target.value)}
                      placeholder="sensor.temperature"
                      className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    />
                    <button
                      onClick={() => removeTrendTag(i)}
                      className="text-red-400 hover:text-red-600 text-xs px-1"
                    >
                      X
                    </button>
                  </div>
                ))}
                {trendConfig.tags.length === 0 && (
                  <p className="text-xs text-gray-500 text-center py-2">No tags added yet</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ===== Automation Tab ===== */}
        {activeTab === 'automation' && <AutomationBindingPanel />}

        {/* ===== Events Tab ===== */}
        {activeTab === 'events' && (
          selectedWidget && onWidgetEventsChange ? (
            <EventsPanel
              events={selectedWidget.events ?? []}
              onChange={(events) => onWidgetEventsChange(selectedWidget.id, events)}
              deviceId={deviceId}
              scripts={scripts}
            />
          ) : (
            <div className="flex flex-col items-center justify-center text-center text-gray-500 py-12">
              <Settings className="w-10 h-10 mb-3 text-gray-500" />
              <p className="text-sm">Select a widget</p>
              <p className="text-xs mt-1">Select a widget to configure events</p>
            </div>
          )
        )}

        {/* ===== Animations Tab ===== */}
        {activeTab === 'animations' && (
          selectedWidget && onWidgetAnimationsChange ? (
            <AnimationsPanel
              animations={selectedWidget.animations ?? []}
              onChange={(animations) => onWidgetAnimationsChange(selectedWidget.id, animations)}
              deviceId={deviceId}
            />
          ) : (
            <div className="flex flex-col items-center justify-center text-center text-gray-500 py-12">
              <Settings className="w-10 h-10 mb-3 text-gray-500" />
              <p className="text-sm">Select a widget</p>
              <p className="text-xs mt-1">Select a widget to configure animations</p>
            </div>
          )
        )}

        {/* ===== Scripts Tab =====
         *
         * Package-level script management. Unlike widget-scoped tabs,
         * scripts belong to the entire SCADA package and can be referenced
         * by any widget's runScript event action. No widget selection required.
         */}
        {activeTab === 'scripts' && onScriptsChange && (
          <ScriptsPanel
            scripts={scripts}
            onChange={onScriptsChange}
            onTestScript={onTestScript ?? (() => {})}
            deviceId={deviceId}
          />
        )}
      </div>
    </div>
  );
};

export default PropertiesPanel;
