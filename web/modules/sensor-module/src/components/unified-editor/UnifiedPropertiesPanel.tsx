/**
 * UnifiedPropertiesPanel - Mode-aware right panel for the Unified SCADA Editor.
 *
 * Displays different content based on the active editor mode and selected node type:
 *
 * P&ID Mode  -> Process-editor PropertiesPanel (equipment link, sensor link, I/O binding, DO controls)
 * HMI Mode   -> Widget config tabs (Config, Tag Binding, Alarms, Trend) for scadaWidget nodes
 * PLC Mode   -> Variable list / I/O mapping placeholders
 * Runtime    -> Live tag values / active alarms placeholders
 * Debug      -> Watch variables / force value placeholders
 */

import React, { useState, useCallback } from 'react';
import {
  Settings,
  Tag,
  AlertTriangle,
  TrendingUp,
  Cpu,
  Activity,
  Radio,
  Eye,
  Bug,
  Plus,
  Trash2,
  Info,
} from 'lucide-react';
import { useEditorModeStore, EditorMode } from '../../store/editorModeStore';
import { useProcessStore } from '../../store/processStore';
import { useScadaPackageStore } from '../../store/scada';
import { PropertiesPanel as PidPropertiesPanel } from '../process-editor/panels/PropertiesPanel';
import { widgetConfigMap } from '../scada-builder/widget-configs';
import { TagBrowser } from '../scada-builder/TagBrowser';

// ---------------------------------------------------------------------------
// HMI Tab definitions
// ---------------------------------------------------------------------------

type HmiTabId = 'config' | 'tags' | 'alarms' | 'trend';

const HMI_TABS: { id: HmiTabId; label: string; icon: React.FC<{ className?: string }> }[] = [
  { id: 'config', label: 'Config', icon: Settings },
  { id: 'tags', label: 'Tag', icon: Tag },
  { id: 'alarms', label: 'Alarm', icon: AlertTriangle },
  { id: 'trend', label: 'Trend', icon: TrendingUp },
];

const CONDITIONS = ['>', '<', '>=', '<=', '==', '!='];
const SEVERITIES = ['critical', 'high', 'warning', 'info'] as const;

// ---------------------------------------------------------------------------
// HMI Widget Config Panel
// ---------------------------------------------------------------------------

const HmiWidgetPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<HmiTabId>('config');

  const selectedNode = useProcessStore((s) => s.selectedNode);
  const updateNodeData = useProcessStore((s) => s.updateNodeData);

  const targetDeviceId = useScadaPackageStore((s) => s.targetDeviceId);
  const alarmRules = useScadaPackageStore((s) => s.alarmRules);
  const addAlarmRule = useScadaPackageStore((s) => s.addAlarmRule);
  const removeAlarmRule = useScadaPackageStore((s) => s.removeAlarmRule);
  const storeUpdateAlarmRule = useScadaPackageStore((s) => s.updateAlarmRule);
  const trendConfig = useScadaPackageStore((s) => s.trendConfig);
  const updateTrendConfig = useScadaPackageStore((s) => s.updateTrendConfig);

  // Widget data from the selected scadaWidget node
  const widgetType = selectedNode?.data?.widgetType as string | undefined;
  const widgetConfig = (selectedNode?.data?.config as Record<string, any>) || {};

  const ConfigComponent = widgetType ? widgetConfigMap[widgetType] : null;

  // Handle widget config change -> update node data
  const handleConfigChange = useCallback(
    (updates: Record<string, any>) => {
      if (!selectedNode) return;
      const newConfig = { ...widgetConfig, ...updates };
      updateNodeData(selectedNode.id, { config: newConfig });
    },
    [selectedNode, widgetConfig, updateNodeData],
  );

  // Handle tag selection -> set tagName in config
  const handleTagSelect = useCallback(
    (tagName: string) => {
      if (!selectedNode) return;
      const newConfig = { ...widgetConfig, tagName };
      updateNodeData(selectedNode.id, {
        config: newConfig,
        tagName,
      });
    },
    [selectedNode, widgetConfig, updateNodeData],
  );

  // Handle add alarm rule
  const handleAddAlarm = useCallback(() => {
    addAlarmRule({
      id: crypto.randomUUID(),
      tag: widgetConfig.tagName || '',
      condition: '>',
      value: 0,
      severity: 'warning',
      message: '',
    });
  }, [addAlarmRule, widgetConfig.tagName]);

  // Trend tag helpers
  const handleAddTrendTag = useCallback(() => {
    updateTrendConfig({
      ...trendConfig,
      tags: [...trendConfig.tags, widgetConfig.tagName || ''],
    });
  }, [updateTrendConfig, trendConfig, widgetConfig.tagName]);

  const handleUpdateTrendTag = useCallback(
    (index: number, value: string) => {
      const updated = trendConfig.tags.map((t, i) => (i === index ? value : t));
      updateTrendConfig({ ...trendConfig, tags: updated });
    },
    [updateTrendConfig, trendConfig],
  );

  const handleRemoveTrendTag = useCallback(
    (index: number) => {
      updateTrendConfig({
        ...trendConfig,
        tags: trendConfig.tags.filter((_, i) => i !== index),
      });
    },
    [updateTrendConfig, trendConfig],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Tab Header */}
      <div className="flex border-b border-gray-200">
        {HMI_TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex items-center justify-center gap-1 px-2 py-2.5 text-xs font-medium transition-colors ${
                activeTab === tab.id
                  ? 'text-cyan-700 border-b-2 border-cyan-600 bg-cyan-50'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* ===== Config Tab ===== */}
        {activeTab === 'config' && (
          <>
            {ConfigComponent ? (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-3 capitalize">
                  {(widgetType || '').replace(/([A-Z])/g, ' $1').trim()}
                </h4>
                <ConfigComponent
                  config={widgetConfig}
                  onChange={handleConfigChange}
                  deviceId={targetDeviceId}
                />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center text-gray-500 py-12">
                <Settings className="w-10 h-10 mb-3 text-gray-500" />
                <p className="text-sm">Bilinmeyen widget tipi</p>
                <p className="text-xs mt-1">{widgetType || 'Tip belirtilmemis'}</p>
              </div>
            )}
          </>
        )}

        {/* ===== Tag Binding Tab ===== */}
        {activeTab === 'tags' && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-gray-700">Tag Baglama</h4>
            <p className="text-xs text-gray-500">
              Widget'a veri kaynagi olarak bir tag secin.
            </p>
            <TagBrowser
              deviceId={targetDeviceId}
              value={widgetConfig.tagName || ''}
              onChange={handleTagSelect}
              placeholder="Tag sec..."
            />
            {widgetConfig.tagName && (
              <div className="p-2 bg-cyan-50 rounded-lg border border-cyan-200">
                <p className="text-xs text-cyan-700 font-medium">Bagli Tag:</p>
                <p className="text-sm text-cyan-900 font-mono mt-0.5">{widgetConfig.tagName}</p>
              </div>
            )}
          </div>
        )}

        {/* ===== Alarms Tab ===== */}
        {activeTab === 'alarms' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-gray-700">Alarm Kurallari</h4>
              <button
                onClick={handleAddAlarm}
                className="flex items-center gap-1 text-xs text-cyan-600 hover:text-cyan-700"
              >
                <Plus className="w-3 h-3" />
                Alarm Ekle
              </button>
            </div>

            {alarmRules.length === 0 && (
              <p className="text-xs text-gray-500 py-4 text-center">Henuz alarm kurali yok</p>
            )}

            {alarmRules.map((rule) => (
              <div key={rule.id} className="p-3 bg-gray-50 rounded-lg space-y-2 border border-gray-100">
                <div className="flex items-center justify-between">
                  <select
                    value={rule.severity}
                    onChange={(e) =>
                      storeUpdateAlarmRule(rule.id, { severity: e.target.value as typeof SEVERITIES[number] })
                    }
                    className={`text-xs font-medium rounded px-2 py-1 border-0 ${
                      rule.severity === 'critical'
                        ? 'bg-red-100 text-red-700'
                        : rule.severity === 'high'
                        ? 'bg-orange-100 text-orange-700'
                        : rule.severity === 'warning'
                        ? 'bg-yellow-100 text-yellow-700'
                        : 'bg-blue-100 text-blue-700'
                    }`}
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
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
                  onChange={(e) => storeUpdateAlarmRule(rule.id, { tag: e.target.value })}
                  placeholder="Tag"
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
                <div className="flex gap-1">
                  <select
                    value={rule.condition}
                    onChange={(e) => storeUpdateAlarmRule(rule.id, { condition: e.target.value })}
                    className="w-16 px-1 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  >
                    {CONDITIONS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    value={rule.value}
                    onChange={(e) => storeUpdateAlarmRule(rule.id, { value: Number(e.target.value) })}
                    className="flex-1 px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  />
                </div>
                <input
                  type="text"
                  value={rule.message}
                  onChange={(e) => storeUpdateAlarmRule(rule.id, { message: e.target.value })}
                  placeholder="Alarm mesaji"
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
              </div>
            ))}
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
                onChange={(e) =>
                  updateTrendConfig({ ...trendConfig, retentionDays: Number(e.target.value) })
                }
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Ornekleme Araligi (sn)</label>
              <input
                type="number"
                min={1}
                value={trendConfig.sampleIntervalSec}
                onChange={(e) =>
                  updateTrendConfig({ ...trendConfig, sampleIntervalSec: Number(e.target.value) })
                }
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-gray-500">Tag'ler</label>
                <button
                  onClick={handleAddTrendTag}
                  className="text-xs text-cyan-600 hover:text-cyan-700"
                >
                  + Tag Ekle
                </button>
              </div>
              <div className="space-y-1">
                {trendConfig.tags.map((tag, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <input
                      type="text"
                      value={tag}
                      onChange={(e) => handleUpdateTrendTag(i, e.target.value)}
                      placeholder="sensor.temperature"
                      className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    />
                    <button
                      onClick={() => handleRemoveTrendTag(i)}
                      className="text-red-400 hover:text-red-600 text-xs px-1"
                    >
                      X
                    </button>
                  </div>
                ))}
                {trendConfig.tags.length === 0 && (
                  <p className="text-xs text-gray-500 text-center py-2">Henuz tag eklenmedi</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Placeholder panels for other modes
// ---------------------------------------------------------------------------

const PlcPanel: React.FC = () => (
  <div className="p-4 space-y-4">
    <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
      <Cpu className="w-4 h-4" />
      PLC Degiskenleri
    </h3>
    <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
      <p className="text-xs text-gray-500 font-medium mb-2">Variable Listesi</p>
      <p className="text-xs text-gray-500">PLC degisken tarayici burada gorunecek.</p>
    </div>
    <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
      <p className="text-xs text-gray-500 font-medium mb-2">I/O Mapping</p>
      <p className="text-xs text-gray-500">Fiziksel I/O eslemesi burada yapilacak.</p>
    </div>
  </div>
);

const RuntimePanel: React.FC = () => (
  <div className="p-4 space-y-4">
    <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
      <Eye className="w-4 h-4" />
      Canli Degerler
    </h3>
    <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
      <p className="text-xs text-gray-500 font-medium mb-2">Tag Degerleri</p>
      <p className="text-xs text-gray-500">Canli tag degerleri tablosu burada gorunecek.</p>
    </div>
    <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
      <p className="text-xs text-gray-500 font-medium mb-2">Aktif Alarmlar</p>
      <p className="text-xs text-gray-500">Aktif alarm listesi burada gorunecek.</p>
    </div>
  </div>
);

const DebugPanel: React.FC = () => (
  <div className="p-4 space-y-4">
    <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
      <Bug className="w-4 h-4" />
      Debug
    </h3>
    <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
      <p className="text-xs text-gray-500 font-medium mb-2">Watch Degiskenleri</p>
      <p className="text-xs text-gray-500">Izlenen degiskenler burada gorunecek.</p>
    </div>
    <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
      <p className="text-xs text-gray-500 font-medium mb-2">Force Value</p>
      <p className="text-xs text-gray-500">Degisken zorla atama dialogu burada olacak.</p>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Empty / info states
// ---------------------------------------------------------------------------

const EmptyState: React.FC<{ icon: React.FC<{ className?: string }>; title: string; subtitle: string }> = ({
  icon: Icon,
  title,
  subtitle,
}) => (
  <div className="flex flex-col items-center justify-center h-full text-center text-gray-500 p-6">
    <Icon className="w-10 h-10 mb-3 text-gray-500" />
    <p className="text-sm font-medium">{title}</p>
    <p className="text-xs mt-1">{subtitle}</p>
  </div>
);

const HmiPidWarning: React.FC = () => (
  <div className="flex flex-col items-center justify-center h-full text-center p-6">
    <Info className="w-10 h-10 mb-3 text-amber-400" />
    <p className="text-sm font-medium text-amber-700">HMI modunda ekipman duzenlenemez</p>
    <p className="text-xs mt-1 text-amber-600">P&ID moduna gecis yaparak ekipmanlari duzenleyebilirsiniz.</p>
  </div>
);

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export const UnifiedPropertiesPanel: React.FC = () => {
  const mode = useEditorModeStore((s) => s.mode);
  const selectedNode = useProcessStore((s) => s.selectedNode);

  // Determine node classification
  const isScadaWidget = selectedNode?.type === 'scadaWidget';
  const isPidNode = selectedNode != null && !isScadaWidget;

  return (
    <div className="flex flex-col h-full bg-white">
      {/* ===== P&ID Mode ===== */}
      {mode === 'pid' && <PidPropertiesPanel />}

      {/* ===== HMI Mode ===== */}
      {mode === 'hmi' && (
        <>
          {isScadaWidget && <HmiWidgetPanel />}
          {isPidNode && <HmiPidWarning />}
          {!selectedNode && (
            <EmptyState
              icon={Radio}
              title="Bir widget secin"
              subtitle="Canvas uzerinden bir widget secin veya palette'den surukleyin"
            />
          )}
        </>
      )}

      {/* ===== PLC Mode ===== */}
      {mode === 'plc' && <PlcPanel />}

      {/* ===== Runtime Mode ===== */}
      {mode === 'runtime' && <RuntimePanel />}

      {/* ===== Debug Mode ===== */}
      {mode === 'debug' && <DebugPanel />}
    </div>
  );
};

export default UnifiedPropertiesPanel;
