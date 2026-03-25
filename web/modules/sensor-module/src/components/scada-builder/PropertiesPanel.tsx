/**
 * SCADA Builder Properties Panel
 * Right sidebar with 2-tier tabbed interface:
 *   Tier 1 — Group toggle: Widget (widget-scoped) vs Package (package-scoped)
 *   Tier 2 — Tabs within the active group
 *
 * Widget-scoped: Properties | Events | Animations
 * Package-scoped: Alarms | Control | Trends | Auto | Scripts
 */

import React, { useState, useEffect } from 'react';
import { Settings, Trash2 } from 'lucide-react';
import { widgetConfigMap } from './widget-configs';
import { GeneralPropertiesSection } from './widget-configs/GeneralPropertiesSection';
import { WidgetPermissionsSection } from './widget-configs/WidgetPermissionsSection';
import { EventsPanel } from './widget-configs/EventsPanel';
import { AnimationsPanel } from './widget-configs/AnimationsPanel';
import { ScriptsPanel } from './widget-configs/ScriptsPanel';
import { AutomationBindingPanel } from './AutomationBindingPanel';
import { PropertiesTabNav, groupForTab, type TabGroup, type TabId } from './PropertiesTabNav';
import { PropertiesAlarmTab, type AlarmRule } from './PropertiesAlarmTab';
import { PropertiesControlTab, type ControlSecurityConfig, type EmergencyStopConfig } from './PropertiesControlTab';
import { PropertiesTrendsTab, type TrendConfig } from './PropertiesTrendsTab';
import { CONNECTION_TYPES, type ConnectionType } from '../../config/connectionTypes';
import type { ScadaEdge, ScadaEdgeType, ScadaEdgeData } from '../../types/scada-edge.types';
import type { WidgetEventDef, ScadaScript } from '../../engine/events/types';
import type { AnimationRule } from '../../engine/animation/types';
import type { ScreenWidget, WidgetPosition } from '../../types/scada-package.types';
import type { WidgetPermissions } from '../../types/scada-widget.types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SelectedWidget {
  id: string;
  type: string;
  config: Record<string, unknown>;
  name?: string;
  position: WidgetPosition;
  locked?: boolean;
  visible?: boolean;
  permissions?: WidgetPermissions;
  events?: WidgetEventDef[];
  animations?: AnimationRule[];
}

interface PropertiesPanelProps {
  selectedWidget?: SelectedWidget | null;
  onWidgetConfigChange?: (widgetId: string, updates: Record<string, unknown>) => void;
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
  scripts?: ScadaScript[];
  onScriptsChange?: (scripts: ScadaScript[]) => void;
  onTestScript?: (scriptId: string) => void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

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
  const [activeGroup, setActiveGroup] = useState<TabGroup>('widget-scoped');
  const [activeTab, setActiveTab] = useState<TabId>('properties');

  const hasEdgeSelected = !!selectedEdge;
  const hasWidgetSelected = !!selectedWidget;

  // When an edge is selected, auto-switch to widget-scoped group + properties tab
  useEffect(() => {
    if (hasEdgeSelected) {
      setActiveGroup('widget-scoped');
      setActiveTab('properties');
    }
  }, [hasEdgeSelected]);

  const handleGroupChange = (group: TabGroup) => {
    setActiveGroup(group);
    setActiveTab(group === 'widget-scoped' ? 'properties' : 'alarms');
  };

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab);
    setActiveGroup(groupForTab(tab));
  };

  const ConfigComponent = selectedWidget ? widgetConfigMap[selectedWidget.type] : null;

  return (
    <div className="w-80 bg-white border-l border-gray-200 flex flex-col h-full">
      {/* 2-tier tab navigation */}
      <PropertiesTabNav
        activeGroup={activeGroup}
        activeTab={activeTab}
        onGroupChange={handleGroupChange}
        onTabChange={handleTabChange}
        hasWidgetSelected={hasWidgetSelected}
        hasEdgeSelected={hasEdgeSelected}
      />

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4">

        {/* ===== Properties Tab (widget-scoped) ===== */}
        {activeTab === 'properties' && (
          <>
            {selectedWidget && ConfigComponent && onWidgetConfigChange ? (
              <div>
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
                <ConfigComponent
                  config={selectedWidget.config}
                  onChange={(updates: Record<string, unknown>) => onWidgetConfigChange(selectedWidget.id, updates)}
                  deviceId={deviceId}
                />
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
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="edgeAnimated"
                    checked={!!selectedEdge.data.animated}
                    onChange={(e) => onEdgeDataChange(selectedEdge.id, { animated: e.target.checked })}
                    className="text-cyan-600 rounded focus:ring-cyan-500"
                  />
                  <label htmlFor="edgeAnimated" className="text-xs text-gray-700">Animated flow</label>
                </div>
                <div className="pt-3 border-t border-gray-200">
                  <p className="text-[11px] text-gray-500">
                    Source: {selectedEdge.source} ({selectedEdge.sourceHandle})
                  </p>
                  <p className="text-[11px] text-gray-500">
                    Target: {selectedEdge.target} ({selectedEdge.targetHandle})
                  </p>
                </div>
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

        {/* ===== Events Tab (widget-scoped) ===== */}
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

        {/* ===== Animations Tab (widget-scoped) ===== */}
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

        {/* ===== Alarms Tab (package-scoped) ===== */}
        {activeTab === 'alarms' && (
          <PropertiesAlarmTab alarmRules={alarmRules} onAlarmRulesChange={onAlarmRulesChange} />
        )}

        {/* ===== Control Tab (package-scoped) ===== */}
        {activeTab === 'control' && (
          <PropertiesControlTab
            controlSecurity={controlSecurity}
            onControlSecurityChange={onControlSecurityChange}
            emergencyStop={emergencyStop}
            onEmergencyStopChange={onEmergencyStopChange}
          />
        )}

        {/* ===== Trends Tab (package-scoped) ===== */}
        {activeTab === 'trends' && (
          <PropertiesTrendsTab trendConfig={trendConfig} onTrendConfigChange={onTrendConfigChange} />
        )}

        {/* ===== Automation Tab (package-scoped) ===== */}
        {activeTab === 'automation' && <AutomationBindingPanel />}

        {/* ===== Scripts Tab (package-scoped) ===== */}
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
