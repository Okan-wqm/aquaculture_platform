/**
 * AIDetectionPanel
 *
 * Panel component for AI-powered channel detection flow.
 * Allows users to submit sample data and review/approve AI-proposed channels.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Sparkles, CheckCheck, XCircle, AlertCircle, FileJson } from 'lucide-react';
import { useChannelDetection, ProposedChannel } from '../../hooks/useChannelDetection';
import { AIChannelProposalCard } from './AIChannelProposalCard';
import { Spinner, Button, Input, Textarea } from '@aquaculture/shared-ui';

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
      setParseError('Geçersiz JSON formatı. Örnek veriyi JSON olarak yapıştırın.');
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
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">AI Kanal Tespiti</h3>
      </div>

      {/* Success state */}
      {allProcessed && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-3">
          <CheckCheck className="w-5 h-5 text-green-600 flex-shrink-0" />
          <p className="text-green-800 text-sm font-medium">
            Tüm kanallar başarıyla işlendi.
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
          <Spinner size="md" />
          <p className="text-purple-700 text-sm">Bekleyen teklifler yükleniyor...</p>
        </div>
      )}

      {/* M3: Inline edit form */}
      {editingProposalId && (
        <div className="bg-white dark:bg-gray-900 border border-blue-200 rounded-lg p-4 mb-4 space-y-3">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Kanal etiketini düzenleyin</p>
          <Input fullWidth type="text" value={editLabel} onChange={(e) => setEditLabel(e.target.value)} autoFocus />
          <div className="flex items-center gap-2">
            <Button variant="primary" size="xs" onClick={handleEditSave} disabled={!editLabel.trim()}>Kaydet</Button>
            <Button variant="secondary" size="xs" onClick={handleEditCancel}>İptal</Button>
          </div>
        </div>
      )}

      {/* Input area (show when no proposals and not all processed) */}
      {!allProcessed && allChannels.length === 0 && !detecting && !loadingPending && (
        <div className="space-y-3">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Sensor verilerinizi JSON formatinda yapistirin veya ornek verileri kullanin.
            AI, veri kanallarini otomatik olarak tespit edecektir.
          </p>

          <Textarea className="font-mono resize-y" fullWidth value={sampleInput} onChange={(e) => {
       setSampleInput(e.target.value);
       setParseError(null);
      }} placeholder='{"temperature": 24.5, "ph": 7.2, "dissolved_oxygen": 6.8}' />

          {parseError && (
            <p className="text-red-600 text-xs">{parseError}</p>
          )}

          <div className="flex items-center gap-3">
            <Button variant="primary" leftIcon={<Sparkles className="w-4 h-4" />} onClick={handleDetect} disabled={!sampleInput.trim()}>Otomatik Kanal Tespiti</Button>

            <Button variant="secondary" leftIcon={<FileJson className="w-4 h-4" />} onClick={handleUseSampleData}>Son Verileri Kullan</Button>
          </div>
        </div>
      )}

      {/* Loading state */}
      {detecting && (
        <div className="flex items-center gap-3 py-8 justify-center">
          <Spinner size="md" />
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
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {allChannels.length} kanal tespit edildi
            </p>
            <div className="flex items-center gap-2">
              <Button variant="primary" size="xs" onClick={handleApproveAll} disabled={bulkProcessing}>{bulkProcessing ? (
                  <Spinner size="sm" color="inherit" />
                ) : (
                  <CheckCheck className="w-3.5 h-3.5" />
                )}
                Tümünü Onayla</Button>
              <Button variant="danger" size="xs" onClick={handleRejectAll} disabled={bulkProcessing}>{bulkProcessing ? (
                  <Spinner size="sm" color="inherit" />
                ) : (
                  <XCircle className="w-3.5 h-3.5" />
                )}
                Tümünü Reddet</Button>
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
