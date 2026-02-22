/**
 * AIChannelProposalCard
 *
 * Compact card displaying a single AI-proposed channel with
 * approve, edit, and reject actions.
 */

import React from 'react';
import { Check, X, Edit, AlertTriangle } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

export interface AIChannelProposal {
  channelKey: string;
  displayLabel: string;
  dataType: string;
  unit?: string;
  operationalMin?: number;
  operationalMax?: number;
  widgetType?: string;
  confidence: 'high' | 'medium' | 'low';
  alertThresholds?: {
    warning?: { low?: number; high?: number };
    critical?: { low?: number; high?: number };
  };
}

interface AIChannelProposalCardProps {
  proposal: AIChannelProposal;
  onApprove: () => void;
  onReject: () => void;
  onEdit: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

const confidenceConfig = {
  high: {
    bgColor: 'bg-green-100',
    textColor: 'text-green-800',
    label: 'Yuksek',
  },
  medium: {
    bgColor: 'bg-yellow-100',
    textColor: 'text-yellow-800',
    label: 'Orta',
  },
  low: {
    bgColor: 'bg-red-100',
    textColor: 'text-red-800',
    label: 'Dusuk',
  },
};

const dataTypeBadgeColor: Record<string, string> = {
  number: 'bg-blue-100 text-blue-800',
  boolean: 'bg-purple-100 text-purple-800',
  string: 'bg-gray-100 text-gray-700',
  enum: 'bg-orange-100 text-orange-800',
};

// ============================================================================
// Component
// ============================================================================

export const AIChannelProposalCard: React.FC<AIChannelProposalCardProps> = ({
  proposal,
  onApprove,
  onReject,
  onEdit,
}) => {
  const conf = confidenceConfig[proposal.confidence] || confidenceConfig.medium;
  const typeBadge = dataTypeBadgeColor[proposal.dataType] || 'bg-gray-100 text-gray-700';

  const hasRange =
    proposal.operationalMin != null || proposal.operationalMax != null;

  const hasThresholds =
    proposal.alertThresholds?.warning || proposal.alertThresholds?.critical;

  return (
    <div className="border border-gray-200 rounded-lg p-4 hover:border-gray-300 transition-colors bg-white">
      {/* Top row: channel key, type badge, confidence */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-gray-500">{proposal.channelKey}</span>
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${typeBadge}`}
          >
            {proposal.dataType}
          </span>
        </div>
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${conf.bgColor} ${conf.textColor}`}
        >
          {conf.label}
        </span>
      </div>

      {/* Label */}
      <p className="text-sm font-medium text-gray-900 mb-1">{proposal.displayLabel}</p>

      {/* Details row */}
      <div className="flex items-center gap-3 text-xs text-gray-500 mb-3">
        {proposal.unit && (
          <span>
            Birim: <span className="text-gray-700 font-medium">{proposal.unit}</span>
          </span>
        )}
        {hasRange && (
          <span>
            Aralik: {proposal.operationalMin ?? '...'} - {proposal.operationalMax ?? '...'}
          </span>
        )}
        {proposal.widgetType && (
          <span>
            Widget: <span className="text-gray-700">{proposal.widgetType}</span>
          </span>
        )}
      </div>

      {/* Alert thresholds (if present) */}
      {hasThresholds && (
        <div className="flex items-center gap-2 text-xs text-gray-500 mb-3">
          <AlertTriangle className="w-3 h-3 text-yellow-500" />
          {proposal.alertThresholds?.warning && (
            <span>
              Uyari: {proposal.alertThresholds.warning.low ?? '...'} -{' '}
              {proposal.alertThresholds.warning.high ?? '...'}
            </span>
          )}
          {proposal.alertThresholds?.critical && (
            <span>
              Kritik: {proposal.alertThresholds.critical.low ?? '...'} -{' '}
              {proposal.alertThresholds.critical.high ?? '...'}
            </span>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={onApprove}
          className="flex items-center gap-1 px-3 py-1.5 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors text-xs font-medium"
        >
          <Check className="w-3.5 h-3.5" />
          Onayla
        </button>
        <button
          onClick={onEdit}
          className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors text-xs font-medium"
        >
          <Edit className="w-3.5 h-3.5" />
          Duzenle
        </button>
        <button
          onClick={onReject}
          className="flex items-center gap-1 px-3 py-1.5 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors text-xs font-medium"
        >
          <X className="w-3.5 h-3.5" />
          Reddet
        </button>
      </div>
    </div>
  );
};

export default AIChannelProposalCard;
