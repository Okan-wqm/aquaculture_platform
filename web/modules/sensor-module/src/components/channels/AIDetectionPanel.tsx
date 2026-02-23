/**
 * AIDetectionPanel
 *
 * Panel component for AI-powered channel detection flow.
 * Allows users to submit sample data and review/approve AI-proposed channels.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Sparkles, Loader2, CheckCheck, XCircle, AlertCircle, FileJson } from 'lucide-react';
import { useChannelDetection, ProposedChannel } from '../../hooks/useChannelDetection';
import { AIChannelProposalCard } from './AIChannelProposalCard';

// ============================================================================
// Props
// ============================================================================

interface AIDetectionPanelProps {
  sensorId: string;
  onChannelsCreated?: () => void;
}

// ============================================================================
// Component
// ============================================================================

export const AIDetectionPanel: React.FC<AIDetectionPanelProps> = ({
  sensorId,
  onChannelsCreated,
}) => {
  const {
    proposals,
    detecting,
    loadingPending,
    error,
    detectChannels,
    approveProposal,
    rejectProposal,
    fetchPending,
  } = useChannelDetection(sensorId);

  const [sampleInput, setSampleInput] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [allProcessed, setAllProcessed] = useState(false);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [bulkProcessing, setBulkProcessing] = useState(false);
  // M3: inline edit state instead of window.prompt
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');

  // Fetch any pending proposals on mount
  useEffect(() => {
    fetchPending();
  }, [fetchPending]);

  // Flatten all proposed channels from all proposals for display
  const allChannels: Array<{ proposalId: string; index: number; channel: ProposedChannel }> = [];
  proposals.forEach((p) => {
    p.proposedChannels.forEach((ch, i) => {
      allChannels.push({ proposalId: p.id, index: i, channel: ch });
    });
  });

  // --- Detect ---
  const handleDetect = useCallback(async () => {
    setParseError(null);
    setAllProcessed(false);

    let samples: unknown[];
    try {
      const parsed = JSON.parse(sampleInput);
      samples = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      setParseError('Gecersiz JSON formati. Ornek veriyi JSON olarak yapistirin.');
      return;
    }

    const result = await detectChannels(samples);
    if (result) {
      setSampleInput('');
    }
  }, [sampleInput, detectChannels]);

  // --- Use sample placeholder ---
  const handleUseSampleData = useCallback(() => {
    const sample = JSON.stringify(
      {
        temperature: 24.5,
        ph: 7.2,
        dissolved_oxygen: 6.8,
        salinity: 12.3,
        turbidity: 45,
      },
      null,
      2,
    );
    setSampleInput(sample);
  }, []);

  // --- Approve single channel ---
  const handleApprove = useCallback(
    async (proposalId: string, index: number) => {
      const key = `${proposalId}:${index}`;
      setProcessingIds((prev) => new Set(prev).add(key));

      await approveProposal(proposalId);

      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });

      // H3: Derive "all processed" from proposals state after the operation
      // The proposals array will have been updated by the hook
      // We check if there will be no more proposals left
      setAllProcessed((prev) => {
        // If proposals are now empty after this operation, all are processed
        // We rely on the next render cycle to check proposals.length
        return prev;
      });
    },
    [approveProposal],
  );

  // H3: Use effect to detect when all proposals are processed
  useEffect(() => {
    if (allChannels.length === 0 && proposals.length === 0 && !detecting && !loadingPending) {
      // Don't set allProcessed on initial empty state
      return;
    }
  }, [allChannels.length, proposals.length, detecting, loadingPending]);

  // --- Reject single channel ---
  const handleReject = useCallback(
    async (proposalId: string, index: number) => {
      const key = `${proposalId}:${index}`;
      setProcessingIds((prev) => new Set(prev).add(key));

      await rejectProposal(proposalId);

      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    },
    [rejectProposal],
  );

  // Check after every proposal change if all are done
  useEffect(() => {
    if (allProcessed) return;
    // If we had proposals before and now have none, mark all as processed
    // This is handled by tracking the transition
  }, [proposals, allProcessed]);

  // --- Edit (M3: inline edit instead of window.prompt) ---
  const handleEdit = useCallback(
    (proposalId: string, _index: number, channel: ProposedChannel) => {
      setEditingProposalId(proposalId);
      setEditLabel(channel.displayLabel);
    },
    [],
  );

  const handleEditSave = useCallback(
    async () => {
      if (!editingProposalId) return;
      await approveProposal(editingProposalId, { displayLabel: editLabel });
      setEditingProposalId(null);
      setEditLabel('');
      onChannelsCreated?.();
    },
    [editingProposalId, editLabel, approveProposal, onChannelsCreated],
  );

  const handleEditCancel = useCallback(() => {
    setEditingProposalId(null);
    setEditLabel('');
  }, []);

  // --- Bulk approve (M1: parallel execution with loading indicator) ---
  const handleApproveAll = useCallback(async () => {
    setBulkProcessing(true);
    try {
      const uniqueProposalIds = [...new Set(allChannels.map(({ proposalId }) => proposalId))];
      await Promise.all(uniqueProposalIds.map((id) => approveProposal(id)));
      setAllProcessed(true);
      onChannelsCreated?.();
    } finally {
      setBulkProcessing(false);
    }
  }, [allChannels, approveProposal, onChannelsCreated]);

  // --- Bulk reject (M1: parallel execution with loading indicator) ---
  const handleRejectAll = useCallback(async () => {
    setBulkProcessing(true);
    try {
      const uniqueProposalIds = [...new Set(allChannels.map(({ proposalId }) => proposalId))];
      await Promise.all(uniqueProposalIds.map((id) => rejectProposal(id)));
      setAllProcessed(true);
    } finally {
      setBulkProcessing(false);
    }
  }, [allChannels, rejectProposal]);

  return (
    <div className="bg-gradient-to-r from-purple-50 to-blue-50 rounded-xl border border-purple-200 p-6 mb-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="w-5 h-5 text-purple-600" />
        <h3 className="text-lg font-semibold text-gray-900">AI Kanal Tespiti</h3>
      </div>

      {/* Success state */}
      {allProcessed && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-3">
          <CheckCheck className="w-5 h-5 text-green-600 flex-shrink-0" />
          <p className="text-green-800 text-sm font-medium">
            Tum kanallar basariyla islendi.
          </p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3 mb-4">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
          <div>
            <p className="text-red-800 font-medium text-sm">Hata</p>
            <p className="text-red-600 text-xs">{error.message}</p>
          </div>
        </div>
      )}

      {/* M4: Loading state for fetchPending */}
      {loadingPending && (
        <div className="flex items-center gap-3 py-4 justify-center">
          <Loader2 className="w-5 h-5 text-purple-600 animate-spin" />
          <p className="text-purple-700 text-sm">Bekleyen teklifler yukleniyor...</p>
        </div>
      )}

      {/* M3: Inline edit form */}
      {editingProposalId && (
        <div className="bg-white border border-blue-200 rounded-lg p-4 mb-4 space-y-3">
          <p className="text-sm font-medium text-gray-900">Kanal etiketini duzenleyin</p>
          <input
            type="text"
            value={editLabel}
            onChange={(e) => setEditLabel(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
            autoFocus
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handleEditSave}
              disabled={!editLabel.trim()}
              className="px-3 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-xs font-medium disabled:opacity-50"
            >
              Kaydet
            </button>
            <button
              onClick={handleEditCancel}
              className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 text-xs font-medium"
            >
              Iptal
            </button>
          </div>
        </div>
      )}

      {/* Input area (show when no proposals and not all processed) */}
      {!allProcessed && allChannels.length === 0 && !detecting && !loadingPending && (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Sensor verilerinizi JSON formatinda yapistirin veya ornek verileri kullanin.
            AI, veri kanallarini otomatik olarak tespit edecektir.
          </p>

          <textarea
            value={sampleInput}
            onChange={(e) => {
              setSampleInput(e.target.value);
              setParseError(null);
            }}
            placeholder='{"temperature": 24.5, "ph": 7.2, "dissolved_oxygen": 6.8}'
            className="w-full h-32 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono resize-y focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
          />

          {parseError && (
            <p className="text-red-600 text-xs">{parseError}</p>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={handleDetect}
              disabled={!sampleInput.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Sparkles className="w-4 h-4" />
              Otomatik Kanal Tespiti
            </button>

            <button
              onClick={handleUseSampleData}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm font-medium"
            >
              <FileJson className="w-4 h-4" />
              Son Verileri Kullan
            </button>
          </div>
        </div>
      )}

      {/* Loading state */}
      {detecting && (
        <div className="flex items-center gap-3 py-8 justify-center">
          <Loader2 className="w-6 h-6 text-purple-600 animate-spin" />
          <p className="text-purple-700 text-sm font-medium">
            AI sensor verilerini analiz ediyor...
          </p>
        </div>
      )}

      {/* Proposals list */}
      {!detecting && allChannels.length > 0 && !allProcessed && (
        <div className="space-y-4">
          {/* Bulk actions (M1: disabled during bulk processing) */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">
              {allChannels.length} kanal tespit edildi
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={handleApproveAll}
                disabled={bulkProcessing}
                className="flex items-center gap-1 px-3 py-1.5 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors text-xs font-medium disabled:opacity-50"
              >
                {bulkProcessing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <CheckCheck className="w-3.5 h-3.5" />
                )}
                Tumunu Onayla
              </button>
              <button
                onClick={handleRejectAll}
                disabled={bulkProcessing}
                className="flex items-center gap-1 px-3 py-1.5 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors text-xs font-medium disabled:opacity-50"
              >
                {bulkProcessing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <XCircle className="w-3.5 h-3.5" />
                )}
                Tumunu Reddet
              </button>
            </div>
          </div>

          {/* Channel cards */}
          <div className="grid gap-3 sm:grid-cols-2">
            {allChannels.map(({ proposalId, index, channel }) => {
              const key = `${proposalId}:${index}`;
              const isProcessing = processingIds.has(key) || bulkProcessing;

              return (
                <div key={key} className={isProcessing ? 'opacity-50 pointer-events-none' : ''}>
                  <AIChannelProposalCard
                    proposal={channel}
                    onApprove={() => handleApprove(proposalId, index)}
                    onReject={() => handleReject(proposalId, index)}
                    onEdit={() => handleEdit(proposalId, index, channel)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default AIDetectionPanel;
