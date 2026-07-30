/**
 * ChannelManagerPanel
 *
 * Displays a table of sensor data channels with management actions
 * (add, edit, delete). Uses the ChannelEditorModal for create/edit flows.
 */

import React, { useState, useCallback } from 'react';
import { Plus, Edit, Trash2, Loader2, AlertCircle, Sparkles } from 'lucide-react';
import { useChannelManagement, SensorDataChannel, CreateChannelInput, UpdateChannelInput } from '../../hooks/useChannelManagement';
import { ChannelEditorModal } from '../registration/ChannelEditorModal';
import { AIDetectionPanel } from './AIDetectionPanel';
import { DataChannelConfig, ChannelDataType } from '../../types/registration.types';

// ============================================================================
// Props
// ============================================================================

interface ChannelManagerPanelProps {
  sensorId: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Map API channel to the DataChannelConfig shape expected by ChannelEditorModal */
function toEditorChannel(ch: SensorDataChannel): DataChannelConfig {
  return {
    id: ch.id,
    channelKey: ch.channelKey,
    displayLabel: ch.displayLabel,
    dataType: (ch.dataType as ChannelDataType) || ChannelDataType.NUMBER,
    unit: ch.unit,
    minValue: ch.minValue,
    maxValue: ch.maxValue,
    calibrationEnabled: ch.calibrationEnabled ?? false,
    calibrationMultiplier: ch.calibrationMultiplier ?? 1,
    calibrationOffset: ch.calibrationOffset ?? 0,
    alertThresholds: ch.alertThresholds as DataChannelConfig['alertThresholds'],
    displaySettings: ch.displaySettings as DataChannelConfig['displaySettings'],
    isEnabled: ch.isEnabled ?? true,
    displayOrder: ch.displayOrder ?? 0,
    discoverySource: ch.discoverySource as DataChannelConfig['discoverySource'],
  };
}

/** Map ChannelEditorModal output back to API create input */
function toCreateInput(cfg: DataChannelConfig): CreateChannelInput {
  return {
    channelKey: cfg.channelKey,
    displayLabel: cfg.displayLabel,
    dataType: cfg.dataType,
    unit: cfg.unit,
    unitSymbol: cfg.unit,
    operationalMin: cfg.minValue,
    operationalMax: cfg.maxValue,
    calibrationEnabled: cfg.calibrationEnabled,
    calibrationMultiplier: cfg.calibrationMultiplier,
    calibrationOffset: cfg.calibrationOffset,
    alertThresholds: cfg.alertThresholds as Record<string, unknown> | undefined,
    displaySettings: cfg.displaySettings as Record<string, unknown> | undefined,
    discoverySource: 'manual',
    isEnabled: cfg.isEnabled,
    displayOrder: cfg.displayOrder,
  };
}

/**
 * Map ChannelEditorModal output back to API update input.
 *
 * SENSOR-HIGH-083: calibration coefficients (multiplier/offset) and the enable
 * toggle are intentionally NOT sent here. Calibration is owned by the calibration
 * aggregate (Calibration page → recordCalibration), which stamps
 * lastCalibratedAt/nextCalibrationDue; the channel editor no longer writes those
 * coefficients (its calibration tab is read-only).
 */
function toUpdateInput(cfg: DataChannelConfig): UpdateChannelInput {
  return {
    displayLabel: cfg.displayLabel,
    dataType: cfg.dataType,
    unit: cfg.unit,
    unitSymbol: cfg.unit,
    operationalMin: cfg.minValue,
    operationalMax: cfg.maxValue,
    alertThresholds: cfg.alertThresholds as Record<string, unknown> | undefined,
    displaySettings: cfg.displaySettings as Record<string, unknown> | undefined,
    isEnabled: cfg.isEnabled,
    displayOrder: cfg.displayOrder,
  };
}

function getSourceBadge(source?: string) {
  switch (source) {
    case 'template':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
          Sablon
        </span>
      );
    case 'manual':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
          Manuel
        </span>
      );
    case 'auto':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800">
          Otomatik
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
          Bilinmiyor
        </span>
      );
  }
}

// ============================================================================
// Component
// ============================================================================

export const ChannelManagerPanel: React.FC<ChannelManagerPanelProps> = ({ sensorId }) => {
  const {
    channels,
    fetchLoading,
    error,
    mutationError,
    createChannel,
    updateChannel,
    deleteChannel,
    refetch,
  } = useChannelManagement(sensorId);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<DataChannelConfig | undefined>(undefined);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showAIDetection, setShowAIDetection] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // --- Add Channel ---
  const handleAddChannel = useCallback(() => {
    setEditingChannel(undefined);
    setEditorOpen(true);
  }, []);

  // --- Edit Channel ---
  const handleEditChannel = useCallback((ch: SensorDataChannel) => {
    setEditingChannel(toEditorChannel(ch));
    setEditorOpen(true);
  }, []);

  // --- Save (create or update) - H4: only close on success ---
  const handleSave = useCallback(
    async (cfg: DataChannelConfig) => {
      const result = cfg.id
        ? await updateChannel(cfg.id, toUpdateInput(cfg))
        : await createChannel(toCreateInput(cfg));

      if (result) {
        setEditorOpen(false);
        setEditingChannel(undefined);
      }
    },
    [createChannel, updateChannel],
  );

  // --- Delete Channel (L2: Turkish confirm, M6: specific error feedback) ---
  const handleDeleteChannel = useCallback(
    async (channelId: string, channelKey: string) => {
      if (!window.confirm(`"${channelKey}" kanalini silmek istediginizden emin misiniz?`)) {
        return;
      }
      setDeletingId(channelId);
      setDeleteError(null);
      const success = await deleteChannel(channelId);
      if (!success) {
        setDeleteError(`"${channelKey}" kanali silinemedi. Lutfen tekrar deneyin.`);
      }
      setDeletingId(null);
    },
    [deleteChannel],
  );

  // ---- Loading skeleton ----
  if (fetchLoading && channels.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="h-6 w-40 bg-gray-200 rounded animate-pulse" />
          <div className="h-9 w-32 bg-gray-200 rounded animate-pulse" />
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center space-x-4">
              <div className="h-4 w-24 bg-gray-200 rounded animate-pulse" />
              <div className="h-4 w-32 bg-gray-200 rounded animate-pulse" />
              <div className="h-4 w-16 bg-gray-200 rounded animate-pulse" />
              <div className="h-4 w-16 bg-gray-200 rounded animate-pulse" />
              <div className="h-4 w-20 bg-gray-200 rounded animate-pulse" />
              <div className="h-4 w-16 bg-gray-200 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ---- Error state ----
  if (error) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
          <div>
            <p className="text-red-800 font-medium">Kanallar yuklenemedi</p>
            <p className="text-red-600 text-sm">{error.message}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-semibold text-gray-900">Veri Kanallari</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAIDetection((prev) => !prev)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors text-sm font-medium ${
              showAIDetection
                ? 'bg-purple-100 text-purple-700 border border-purple-300'
                : 'bg-purple-600 text-white hover:bg-purple-700'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            AI Tespit
          </button>
          <button
            onClick={handleAddChannel}
            className="flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            Kanal Ekle
          </button>
        </div>
      </div>

      {/* AI Detection Panel */}
      {showAIDetection && (
        <AIDetectionPanel
          sensorId={sensorId}
          onChannelsCreated={() => {
            refetch();
          }}
        />
      )}

      {/* M6: Mutation error feedback (separate from fetch error) */}
      {(mutationError || deleteError) && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2 mb-4">
          <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0" />
          <p className="text-red-700 text-sm">
            {deleteError || mutationError?.message || 'Islem basarisiz oldu'}
          </p>
        </div>
      )}

      {/* Empty state */}
      {channels.length === 0 ? (
        <div className="text-center py-12">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gray-100 flex items-center justify-center">
            <AlertCircle className="w-8 h-8 text-gray-500" />
          </div>
          <p className="text-gray-500 text-sm">
            Henuz kanal yapilandirilmadi. Kanal ekleyin veya AI tespiti kullanin.
          </p>
        </div>
      ) : (
        /* Channel table */
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-3 px-2 font-medium text-gray-500">Kanal Anahtari</th>
                <th className="text-left py-3 px-2 font-medium text-gray-500">Etiket</th>
                <th className="text-left py-3 px-2 font-medium text-gray-500">Tip</th>
                <th className="text-left py-3 px-2 font-medium text-gray-500">Birim</th>
                <th className="text-left py-3 px-2 font-medium text-gray-500">Aralik</th>
                <th className="text-left py-3 px-2 font-medium text-gray-500">Durum</th>
                <th className="text-left py-3 px-2 font-medium text-gray-500">Kaynak</th>
                <th className="text-right py-3 px-2 font-medium text-gray-500">Islemler</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((ch) => (
                <tr
                  key={ch.id}
                  className="border-b border-gray-50 hover:bg-gray-50 transition-colors"
                >
                  <td className="py-3 px-2 font-mono text-xs text-gray-800">{ch.channelKey}</td>
                  <td className="py-3 px-2 text-gray-900">{ch.displayLabel}</td>
                  <td className="py-3 px-2 text-gray-600 capitalize">{ch.dataType}</td>
                  <td className="py-3 px-2 text-gray-600">{ch.unit || '-'}</td>
                  <td className="py-3 px-2 text-gray-600">
                    {ch.minValue != null || ch.maxValue != null
                      ? `${ch.minValue ?? '...'} - ${ch.maxValue ?? '...'}`
                      : '-'}
                  </td>
                  <td className="py-3 px-2">
                    {ch.isEnabled ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                        Aktif
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                        Devre Disi
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-2">{getSourceBadge(ch.discoverySource)}</td>
                  <td className="py-3 px-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {/* L3: aria-label */}
                      <button
                        onClick={() => handleEditChannel(ch)}
                        className="p-1.5 text-gray-500 hover:text-cyan-600 hover:bg-cyan-50 rounded transition-colors"
                        aria-label="Kanali duzenle"
                        title="Kanali duzenle"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      {/* L3: aria-label */}
                      <button
                        onClick={() => handleDeleteChannel(ch.id, ch.channelKey)}
                        disabled={deletingId === ch.id}
                        className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
                        aria-label="Kanali sil"
                        title="Kanali sil"
                      >
                        {deletingId === ch.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Channel Editor Modal (L6: onSave accepts async) */}
      <ChannelEditorModal
        isOpen={editorOpen}
        channel={editingChannel}
        onClose={() => {
          setEditorOpen(false);
          setEditingChannel(undefined);
        }}
        onSave={handleSave}
      />
    </div>
  );
};

export default ChannelManagerPanel;
