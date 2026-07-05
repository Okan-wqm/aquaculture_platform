/**
 * VfdChangeSetList
 *
 * Tab 2 content: List VFD change sets with status filters,
 * action buttons, and expandable item details.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Check,
  X,
  Clock,
  RotateCcw,
  Play,
  Loader2,
  AlertTriangle,
  FileText,
  Plus,
  Filter,
  Ban,
} from 'lucide-react';
import {
  VfdChangeSet,
  VfdChangeSetStatus,
  VfdRiskLevel,
} from '../../types/vfd.types';
import { useVfdProgrammingStore } from '../../store/vfdProgrammingStore';
import { VfdChangeSetDetail } from './VfdChangeSetDetail';

// ============================================================================
// Constants
// ============================================================================

const STATUS_OPTIONS: { value: VfdChangeSetStatus | ''; label: string }[] = [
  { value: '', label: 'All Statuses' },
  { value: VfdChangeSetStatus.DRAFT, label: 'Draft' },
  { value: VfdChangeSetStatus.PENDING_APPROVAL, label: 'Pending Approval' },
  { value: VfdChangeSetStatus.APPROVED, label: 'Approved' },
  { value: VfdChangeSetStatus.APPLIED, label: 'Applied' },
  { value: VfdChangeSetStatus.REJECTED, label: 'Rejected' },
  { value: VfdChangeSetStatus.ROLLED_BACK, label: 'Rolled Back' },
  { value: VfdChangeSetStatus.CANCELLED, label: 'Cancelled' },
  { value: VfdChangeSetStatus.FAILED, label: 'Failed' },
];

const STATUS_STYLES: Record<string, { bg: string; text: string; icon: React.ReactNode }> = {
  [VfdChangeSetStatus.DRAFT]: {
    bg: 'bg-gray-100', text: 'text-gray-800',
    icon: <FileText className="h-3 w-3" />,
  },
  [VfdChangeSetStatus.PENDING_APPROVAL]: {
    bg: 'bg-yellow-100', text: 'text-yellow-800',
    icon: <Clock className="h-3 w-3" />,
  },
  [VfdChangeSetStatus.APPROVED]: {
    bg: 'bg-blue-100', text: 'text-blue-800',
    icon: <Check className="h-3 w-3" />,
  },
  [VfdChangeSetStatus.REJECTED]: {
    bg: 'bg-red-100', text: 'text-red-800',
    icon: <X className="h-3 w-3" />,
  },
  [VfdChangeSetStatus.APPLYING]: {
    bg: 'bg-indigo-100', text: 'text-indigo-800',
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
  },
  [VfdChangeSetStatus.APPLIED]: {
    bg: 'bg-green-100', text: 'text-green-800',
    icon: <Check className="h-3 w-3" />,
  },
  // SENSOR-HIGH-028: VERIFIED is a real backend state — a verified change set
  // rendered STATUS_STYLES[undefined] before this key existed.
  [VfdChangeSetStatus.VERIFIED]: {
    bg: 'bg-emerald-100', text: 'text-emerald-800',
    icon: <Check className="h-3 w-3" />,
  },
  [VfdChangeSetStatus.FAILED]: {
    bg: 'bg-red-100', text: 'text-red-800',
    icon: <AlertTriangle className="h-3 w-3" />,
  },
  [VfdChangeSetStatus.ROLLED_BACK]: {
    bg: 'bg-purple-100', text: 'text-purple-800',
    icon: <RotateCcw className="h-3 w-3" />,
  },
  [VfdChangeSetStatus.CANCELLED]: {
    bg: 'bg-gray-100', text: 'text-gray-500',
    icon: <Ban className="h-3 w-3" />,
  },
};

const RISK_BADGE: Record<string, string> = {
  [VfdRiskLevel.LOW]: 'bg-green-100 text-green-700',
  [VfdRiskLevel.MEDIUM]: 'bg-yellow-100 text-yellow-700',
  [VfdRiskLevel.HIGH]: 'bg-orange-100 text-orange-700',
  [VfdRiskLevel.CRITICAL]: 'bg-red-100 text-red-700',
};

// ============================================================================
// Props
// ============================================================================

interface VfdChangeSetListProps {
  changeSets: VfdChangeSet[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  onApprove: (id: string) => Promise<unknown>;
  onReject: (id: string, reason: string) => Promise<unknown>;
  onApply: (id: string) => Promise<unknown>;
  onRollback: (id: string, reason: string) => Promise<unknown>;
  onCancel: (id: string) => Promise<unknown>;
  onSubmitForApproval: (id: string) => Promise<unknown>;
}

// ============================================================================
// Component
// ============================================================================

export function VfdChangeSetList({
  changeSets,
  loading,
  error,
  hasMore,
  onLoadMore,
  onApprove,
  onReject,
  onApply,
  onRollback,
  onCancel,
  onSubmitForApproval,
}: VfdChangeSetListProps) {
  const { changeSetFilter, setChangeSetFilter, selectedChangeSetId, setSelectedChangeSetId } =
    useVfdProgrammingStore();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const filteredSets = changeSetFilter
    ? changeSets.filter((cs) => cs.status === changeSetFilter)
    : changeSets;

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12" role="alert">
        <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  return (
    <div data-testid="vfd-changeset-list">
      {/* Detail slide-over */}
      {selectedChangeSetId && (
        <VfdChangeSetDetail
          changeSet={changeSets.find((cs) => cs.id === selectedChangeSetId) ?? null}
          onClose={() => setSelectedChangeSetId(null)}
          onApprove={onApprove}
          onReject={onReject}
          onApply={onApply}
          onRollback={onRollback}
          onCancel={onCancel}
          onSubmitForApproval={onSubmitForApproval}
        />
      )}

      {/* Toolbar */}
      <div className="mb-4 flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-gray-400" />
          <select
            value={changeSetFilter ?? ''}
            onChange={(e) =>
              setChangeSetFilter(
                e.target.value ? (e.target.value as VfdChangeSetStatus) : null,
              )
            }
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            aria-label="Filter by status"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="ml-auto text-xs text-gray-400">
          {filteredSets.length} change set{filteredSets.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* List */}
      {loading && changeSets.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-indigo-600" />
        </div>
      ) : filteredSets.length === 0 ? (
        <div className="py-12 text-center">
          <FileText className="mx-auto mb-2 h-8 w-8 text-gray-300" />
          <p className="text-sm text-gray-500">No change sets yet</p>
          <p className="mt-1 text-xs text-gray-400">
            Add parameter changes from the Parameters tab to create one
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredSets.map((cs) => {
            const style = STATUS_STYLES[cs.status] ?? STATUS_STYLES[VfdChangeSetStatus.DRAFT];
            const riskClass = RISK_BADGE[computeMaxRisk(cs)] ?? RISK_BADGE[VfdRiskLevel.LOW];
            const isExpanded = expandedIds.has(cs.id);

            return (
              <div
                key={cs.id}
                className="rounded-lg border border-gray-200 bg-white"
                data-testid={`changeset-card-${cs.id}`}
              >
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => toggleExpand(cs.id)}
                          className="text-gray-400 hover:text-gray-600"
                          aria-label={isExpanded ? 'Collapse items' : 'Expand items'}
                          aria-expanded={isExpanded}
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>
                        <h4 className="text-sm font-semibold text-gray-900">
                          {cs.description || `Change Set ${cs.id.slice(0, 8)}`}
                        </h4>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${riskClass}`}>
                          {computeMaxRisk(cs)}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-gray-500">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${style.bg} ${style.text}`}>
                          {style.icon} {formatStatus(cs.status)}
                        </span>
                        <span>{cs.items.length} item{cs.items.length !== 1 ? 's' : ''}</span>
                        <span>By: {cs.createdBy}</span>
                        <span>{formatDate(cs.createdAt)}</span>
                        {cs.scheduledAt && (
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" /> Scheduled: {formatDate(cs.scheduledAt)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedChangeSetId(cs.id)}
                      className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      View Details
                    </button>
                    {renderActions(cs, { onApprove, onReject, onApply, onRollback, onCancel, onSubmitForApproval })}
                  </div>
                </div>

                {/* Expanded items table */}
                {isExpanded && (
                  <div className="border-t bg-gray-50 px-4 py-3">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-gray-500">
                          <th className="pb-1 pr-3">Parameter</th>
                          <th className="pb-1 pr-3">Previous</th>
                          <th className="pb-1 pr-3">Requested</th>
                          <th className="pb-1 pr-3">Applied</th>
                          <th className="pb-1">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cs.items.map((item) => (
                          <tr key={item.id} className="border-t border-gray-200">
                            <td className="py-1 pr-3 font-mono">{item.parameterName}</td>
                            <td className="py-1 pr-3">{item.previousValue ?? '-'}</td>
                            <td className="py-1 pr-3 font-medium text-indigo-700">{item.requestedValue}</td>
                            <td className="py-1 pr-3">{item.appliedValue ?? '-'}</td>
                            <td className="py-1">{item.status || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Load more */}
      {hasMore && (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}
            Load More
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function computeMaxRisk(cs: VfdChangeSet): string {
  // No items-level risk field in the new schema; derive from metadata or default
  if (cs.metadata && typeof cs.metadata === 'object' && 'riskLevel' in cs.metadata) {
    return cs.metadata.riskLevel as string;
  }
  return VfdRiskLevel.LOW;
}

function formatStatus(status: VfdChangeSetStatus): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

interface ActionCallbacks {
  onApprove: (id: string) => Promise<unknown>;
  onReject: (id: string, reason: string) => Promise<unknown>;
  onApply: (id: string) => Promise<unknown>;
  onRollback: (id: string, reason: string) => Promise<unknown>;
  onCancel: (id: string) => Promise<unknown>;
  onSubmitForApproval: (id: string) => Promise<unknown>;
}

function renderActions(cs: VfdChangeSet, cbs: ActionCallbacks): React.ReactNode {
  const buttons: React.ReactNode[] = [];

  if (cs.status === VfdChangeSetStatus.DRAFT) {
    buttons.push(
      <button
        key="submit"
        type="button"
        onClick={() => cbs.onSubmitForApproval(cs.id)}
        className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700"
      >
        <Play className="h-3 w-3" /> Submit
      </button>,
      <button
        key="cancel"
        type="button"
        onClick={() => cbs.onCancel(cs.id)}
        className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
      >
        Cancel
      </button>,
    );
  }

  if (cs.status === VfdChangeSetStatus.PENDING_APPROVAL) {
    buttons.push(
      <button
        key="approve"
        type="button"
        onClick={() => cbs.onApprove(cs.id)}
        className="inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700"
        data-testid={`approve-btn-${cs.id}`}
      >
        <Check className="h-3 w-3" /> Approve
      </button>,
      <button
        key="reject"
        type="button"
        onClick={() => {
          const reason = window.prompt('Rejection reason:');
          if (reason) cbs.onReject(cs.id, reason);
        }}
        className="inline-flex items-center gap-1 rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
      >
        <X className="h-3 w-3" /> Reject
      </button>,
    );
  }

  if (cs.status === VfdChangeSetStatus.APPROVED) {
    buttons.push(
      <button
        key="apply"
        type="button"
        onClick={() => {
          if (window.confirm('Apply this change set to the VFD device?')) {
            cbs.onApply(cs.id);
          }
        }}
        className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700"
      >
        <Play className="h-3 w-3" /> Apply
      </button>,
      <button
        key="cancel-approved"
        type="button"
        onClick={() => cbs.onCancel(cs.id)}
        className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
      >
        Cancel
      </button>,
    );
  }

  if (cs.status === VfdChangeSetStatus.APPLIED) {
    buttons.push(
      <button
        key="rollback"
        type="button"
        onClick={() => {
          const reason = window.prompt('Rollback reason:');
          if (reason) cbs.onRollback(cs.id, reason);
        }}
        className="inline-flex items-center gap-1 rounded-md border border-purple-200 px-3 py-1 text-xs font-medium text-purple-600 hover:bg-purple-50"
      >
        <RotateCcw className="h-3 w-3" /> Rollback
      </button>,
    );
  }

  return buttons;
}
