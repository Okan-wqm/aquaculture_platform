/**
 * SCADA Builder Properties Panel
 * Right sidebar with tabbed interface for widget config, alarms, controls, and trends.
 */

import React, { useState } from 'react';
import { Settings, Plus, Trash2 } from 'lucide-react';
import { widgetConfigMap } from './widget-configs';
import { CONNECTION_TYPES, type ConnectionType } from '../../config/connectionTypes';
import type { ScadaEdge, ScadaEdgeType, ScadaEdgeData } from '../../types/scada-edge.types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AlarmRule {
  id: string;
  tag: string;
  condition: string;
  value: number;
  severity: string;
  message: string;
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
  config: Record<string, any>;
}

interface PropertiesPanelProps {
  selectedWidget: SelectedWidget | null;
  onWidgetConfigChange: (widgetId: string, updates: Record<string, any>) => void;
  alarmRules: AlarmRule[];
  onAlarmRulesChange: (rules: AlarmRule[]) => void;
  controlSecurity: ControlSecurityConfig;
  onControlSecurityChange: (config: ControlSecurityConfig) => void;
  emergencyStop: EmergencyStopConfig;
  onEmergencyStopChange: (config: EmergencyStopConfig) => void;
  trendConfig: TrendConfig;
  onTrendConfigChange: (config: TrendConfig) => void;
  deviceId?: string | null;
  selectedEdge?: ScadaEdge | null;
  onEdgeDataChange?: (edgeId: string, updates: Partial<ScadaEdgeData>) => void;
  onEdgeTypeChange?: (edgeId: string, type: ScadaEdgeType) => void;
  onEdgeDelete?: (edgeId: string) => void;
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

type TabId = 'widget' | 'alarms' | 'control' | 'trend';

const TABS: { id: TabId; label: string }[] = [
  { id: 'widget', label: 'Widget' },
  { id: 'alarms', label: 'Alarmlar' },
  { id: 'control', label: 'Kontrol' },
  { id: 'trend', label: 'Trend' },
];

const CONDITIONS = ['>', '<', '>=', '<=', '==', '!='];
const SEVERITIES = ['critical', 'high', 'warning', 'info'];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PropertiesPanel: React.FC<PropertiesPanelProps> = ({
  selectedWidget,
  onWidgetConfigChange,
  alarmRules,
  onAlarmRulesChange,
  controlSecurity,
  onControlSecurityChange,
  emergencyStop,
  onEmergencyStopChange,
  trendConfig,
  onTrendConfigChange,
  deviceId,
  selectedEdge,
  onEdgeDataChange,
  onEdgeTypeChange,
  onEdgeDelete,
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
    onAlarmRulesChange([...alarmRules, rule]);
  };

  const updateAlarmRule = (id: string, field: string, value: any) => {
    onAlarmRulesChange(
      alarmRules.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
    );
  };

  const removeAlarmRule = (id: string) => {
    onAlarmRulesChange(alarmRules.filter((r) => r.id !== id));
  };

  // --- Control helpers -----------------------------------------------------
  const addTagToLevel = (level: keyof ControlSecurityConfig) => {
    onControlSecurityChange({
      ...controlSecurity,
      [level]: [...controlSecurity[level], ''],
    });
  };

  const updateTagInLevel = (level: keyof ControlSecurityConfig, index: number, value: string) => {
    const updated = controlSecurity[level].map((t, i) => (i === index ? value : t));
    onControlSecurityChange({ ...controlSecurity, [level]: updated });
  };

  const removeTagFromLevel = (level: keyof ControlSecurityConfig, index: number) => {
    onControlSecurityChange({
      ...controlSecurity,
      [level]: controlSecurity[level].filter((_, i) => i !== index),
    });
  };

  // --- Emergency stop helpers ----------------------------------------------
  const addAffectedTag = () => {
    onEmergencyStopChange({
      ...emergencyStop,
      affectedTags: [...emergencyStop.affectedTags, ''],
    });
  };

  const updateAffectedTag = (index: number, value: string) => {
    const updated = emergencyStop.affectedTags.map((t, i) => (i === index ? value : t));
    onEmergencyStopChange({ ...emergencyStop, affectedTags: updated });
  };

  const removeAffectedTag = (index: number) => {
    onEmergencyStopChange({
      ...emergencyStop,
      affectedTags: emergencyStop.affectedTags.filter((_, i) => i !== index),
    });
  };

  // --- Trend tag helpers ---------------------------------------------------
  const addTrendTag = () => {
    onTrendConfigChange({ ...trendConfig, tags: [...trendConfig.tags, ''] });
  };

  const updateTrendTag = (index: number, value: string) => {
    const updated = trendConfig.tags.map((t, i) => (i === index ? value : t));
    onTrendConfigChange({ ...trendConfig, tags: updated });
  };

  const removeTrendTag = (index: number) => {
    onTrendConfigChange({
      ...trendConfig,
      tags: trendConfig.tags.filter((_, i) => i !== index),
    });
  };

  // --- Render helpers ------------------------------------------------------
  const ConfigComponent = selectedWidget ? widgetConfigMap[selectedWidget.type] : null;

  return (
    <div className="w-80 bg-white border-l border-gray-200 flex flex-col h-full">
      {/* Tab Header */}
      <div className="flex border-b border-gray-200">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 px-2 py-2.5 text-xs font-medium transition-colors ${
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
        {/* ===== Widget Tab ===== */}
        {activeTab === 'widget' && (
          <>
            {selectedWidget && ConfigComponent ? (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-3 capitalize">
                  {selectedWidget.type.replace(/([A-Z])/g, ' $1').trim()}
                </h4>
                <ConfigComponent
                  config={selectedWidget.config}
                  onChange={(updates) => onWidgetConfigChange(selectedWidget.id, updates)}
                  deviceId={deviceId}
                />
              </div>
            ) : selectedEdge && onEdgeDataChange ? (
              <div className="space-y-4">
                <h4 className="text-sm font-medium text-gray-700">Baglanti Ozellikleri</h4>

                {/* Connection Type */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Baglanti Tipi</label>
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
                  <label className="block text-xs text-gray-500 mb-1">Cizgi Tipi</label>
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
                  <label className="block text-xs text-gray-500 mb-1">Etiket</label>
                  <input
                    type="text"
                    value={selectedEdge.data.label || ''}
                    onChange={(e) => onEdgeDataChange(selectedEdge.id, { label: e.target.value || undefined })}
                    placeholder="Baglanti etiketi"
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
                    Animasyonlu akis
                  </label>
                </div>

                {/* Connection Info */}
                <div className="pt-3 border-t border-gray-200">
                  <p className="text-[10px] text-gray-400">
                    Kaynak: {selectedEdge.source} ({selectedEdge.sourceHandle})
                  </p>
                  <p className="text-[10px] text-gray-400">
                    Hedef: {selectedEdge.target} ({selectedEdge.targetHandle})
                  </p>
                </div>

                {/* Delete Button */}
                <button
                  onClick={() => onEdgeDelete?.(selectedEdge.id)}
                  className="w-full mt-2 px-3 py-2 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors flex items-center justify-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Baglantiyi Sil
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center text-gray-400 py-12">
                <Settings className="w-10 h-10 mb-3 text-gray-300" />
                <p className="text-sm">Widget seciniz</p>
                <p className="text-xs mt-1">Canvas uzerinden bir widget secin</p>
              </div>
            )}
          </>
        )}

        {/* ===== Alarmlar Tab ===== */}
        {activeTab === 'alarms' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-gray-700">Alarm Kurallari</h4>
              <button
                onClick={addAlarmRule}
                className="flex items-center gap-1 text-xs text-cyan-600 hover:text-cyan-700"
              >
                <Plus className="w-3 h-3" />
                Alarm Ekle
              </button>
            </div>

            {alarmRules.length === 0 && (
              <p className="text-xs text-gray-400 py-4 text-center">Henuz alarm kurali yok</p>
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
                  placeholder="Alarm mesaji"
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
              </div>
            ))}
          </div>
        )}

        {/* ===== Kontrol Tab ===== */}
        {activeTab === 'control' && (
          <div className="space-y-4">
            <h4 className="text-sm font-medium text-gray-700">Guvenlik Seviyeleri</h4>

            {(['none', 'confirm', 'pin'] as const).map((level) => (
              <div key={level} className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-gray-600 capitalize">
                    {level === 'none' ? 'Guvenlik Yok' : level === 'confirm' ? 'Onay Gerekli' : 'PIN Gerekli'}
                  </label>
                  <button
                    onClick={() => addTagToLevel(level)}
                    className="text-xs text-cyan-600 hover:text-cyan-700"
                  >
                    + Ekle
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
              <h5 className="text-xs font-medium text-gray-600">Acil Durdurma</h5>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Basili Tutma (ms)</label>
                <input
                  type="number"
                  min={500}
                  step={100}
                  value={emergencyStop.holdDuration}
                  onChange={(e) => onEmergencyStopChange({ ...emergencyStop, holdDuration: Number(e.target.value) })}
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-gray-500">Etkilenen Tag'ler</label>
                  <button onClick={addAffectedTag} className="text-xs text-cyan-600 hover:text-cyan-700">
                    + Ekle
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
                  onChange={(e) => onEmergencyStopChange({ ...emergencyStop, resetRequiresPin: e.target.checked })}
                  className="text-cyan-600 rounded focus:ring-cyan-500"
                />
                <label htmlFor="resetRequiresPin" className="text-xs text-gray-700">
                  Reset icin PIN gerekli
                </label>
              </div>
            </div>
          </div>
        )}

        {/* ===== Trend Tab ===== */}
        {activeTab === 'trend' && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-gray-700">Trend Ayarlari</h4>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Saklama Suresi (gun)</label>
              <input
                type="number"
                min={1}
                value={trendConfig.retentionDays}
                onChange={(e) => onTrendConfigChange({ ...trendConfig, retentionDays: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Ornekleme Araligi (sn)</label>
              <input
                type="number"
                min={1}
                value={trendConfig.sampleIntervalSec}
                onChange={(e) => onTrendConfigChange({ ...trendConfig, sampleIntervalSec: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-gray-500">Tag'ler</label>
                <button onClick={addTrendTag} className="text-xs text-cyan-600 hover:text-cyan-700">
                  + Tag Ekle
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
                  <p className="text-xs text-gray-400 text-center py-2">Henuz tag eklenmedi</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PropertiesPanel;
