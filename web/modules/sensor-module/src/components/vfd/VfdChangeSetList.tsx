/**
 * VfdChangeSetList
 *
 * Tab 2 content: List VFD change sets with status filters,
 * action buttons, and expandable item details.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  Button,
  DataTable,
  Select,
  SeverityBadge,
  Spinner,
  usePrompt,
  type DataTableColumn,
  type PromptFn,
} from '@aquaculture/shared-ui';
import {
  ChevronDown,
  ChevronRight,
  Check,
  X,
  Clock,
  RotateCcw,
  Play,
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
  VfdChangeSetItem,
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
    bg: 'bg-gray-100 dark:bg-gray-800',
    text: 'text-gray-800 dark:text-gray-200',
    icon: <FileText className="h-3 w-3" />,
  },
  [VfdChangeSetStatus.PENDING_APPROVAL]: {
    bg: 'bg-warning-100 dark:bg-warning-900/40',
    text: 'text-warning-800 dark:text-warning-200',
    icon: <Clock className="h-3 w-3" />,
  },
  [VfdChangeSetStatus.APPROVED]: {
    bg: 'bg-info-100 dark:bg-info-900/40',
    text: 'text-info-800 dark:text-info-200',
    icon: <Check className="h-3 w-3" />,
  },
  [VfdChangeSetStatus.REJECTED]: {
    bg: 'bg-error-100 dark:bg-error-900/40',
    text: 'text-error-800 dark:text-error-200',
    icon: <X className="h-3 w-3" />,
  },
  [VfdChangeSetStatus.APPLYING]: {
    bg: 'bg-primary-100 dark:bg-primary-900/40',
    text: 'text-primary-800 dark:text-primary-200',
    icon: <Spinner size="sm" color="inherit" />,
  },
  [VfdChangeSetStatus.APPLIED]: {
    bg: 'bg-success-100 dark:bg-success-900/40',
    text: 'text-success-800 dark:text-success-200',
    icon: <Check className="h-3 w-3" />,
  },
  // SENSOR-HIGH-028: VERIFIED is a real backend state — a verified change set
  // rendered STATUS_STYLES[undefined] before this key existed.
  [VfdChangeSetStatus.VERIFIED]: {
    bg: 'bg-success-100 dark:bg-success-900/40',
    text: 'text-success-800 dark:text-success-200',
    icon: <Check className="h-3 w-3" />,
  },
  [VfdChangeSetStatus.FAILED]: {
    bg: 'bg-error-100 dark:bg-error-900/40',
    text: 'text-error-800 dark:text-error-200',
    icon: <AlertTriangle className="h-3 w-3" />,
  },
  [VfdChangeSetStatus.ROLLED_BACK]: {
    bg: 'bg-accent-100 dark:bg-accent-900/40',
    text: 'text-accent-800 dark:text-accent-200',
    icon: <RotateCcw className="h-3 w-3" />,
  },
  [VfdChangeSetStatus.CANCELLED]: {
    bg: 'bg-gray-100 dark:bg-gray-800',
    text: 'text-gray-500 dark:text-gray-400',
    icon: <Ban className="h-3 w-3" />,
  },
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
  onRollback,
  onCancel,
  onSubmitForApproval,
}: VfdChangeSetListProps) {
  const prompt = usePrompt();
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
        <AlertTriangle className="mb-2 h-8 w-8 text-error-500" />
        <p className="text-sm text-error-600 dark:text-error-400">{error}</p>
      </div>
    );
  }

  const vfdChangeSetItemColumns: DataTableColumn<VfdChangeSetItem>[] = [
    {
      key: 'parameter',
      header: 'Parameter',
      render: (_value, item) => item.parameterName,
    },
    {
      key: 'previous',
      header: 'Previous',
      render: (_value, item) => item.previousValue ?? '-',
    },
    {
      key: 'requested',
      header: 'Requested',
      render: (_value, item) => item.requestedValue,
    },
    {
      key: 'applied',
      header: 'Applied',
      render: (_value, item) => item.appliedValue ?? '-',
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, item) => item.status || '-',
    },
  ];

  return (
    <div data-testid="vfd-changeset-list">
      {/* Detail slide-over */}
      {selectedChangeSetId && (
        <VfdChangeSetDetail
          changeSet={changeSets.find((cs) => cs.id === selectedChangeSetId) ?? null}
          onClose={() => setSelectedChangeSetId(null)}
          onApprove={onApprove}
          onReject={onReject}
          onRollback={onRollback}
          onCancel={onCancel}
          onSubmitForApproval={onSubmitForApproval}
        />
      )}

      {/* Toolbar */}
      <div className="mb-4 flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-gray-400 dark:text-gray-500" />
          <Select
            value={changeSetFilter ?? ''}
            onChange={(e) =>
              setChangeSetFilter(e.target.value ? (e.target.value as VfdChangeSetStatus) : null)
            }
            aria-label="Filter by status"
            options={STATUS_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
          />
        </div>
        <div className="ml-auto text-xs text-gray-400 dark:text-gray-500">
          {filteredSets.length} change set{filteredSets.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* List */}
      {loading && changeSets.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Spinner size="md" />
        </div>
      ) : filteredSets.length === 0 ? (
        <div className="py-12 text-center">
          <FileText className="mx-auto mb-2 h-8 w-8 text-gray-300" />
          <p className="text-sm text-gray-500 dark:text-gray-400">No change sets yet</p>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            Add parameter changes from the Parameters tab to create one
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredSets.map((cs) => {
            const style = STATUS_STYLES[cs.status] ?? STATUS_STYLES[VfdChangeSetStatus.DRAFT];
            const isExpanded = expandedIds.has(cs.id);

            return (
              <div
                key={cs.id}
                className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
                data-testid={`changeset-card-${cs.id}`}
              >
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          type="button"
                          onClick={() => toggleExpand(cs.id)}
                          aria-label={isExpanded ? 'Collapse items' : 'Expand items'}
                          aria-expanded={isExpanded}
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </Button>
                        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                          {cs.description || `Change Set ${cs.id.slice(0, 8)}`}
                        </h4>
                        <SeverityBadge severity={computeMaxRisk(cs)} label={computeMaxRisk(cs)} />
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${style.bg} ${style.text}`}
                        >
                          {style.icon} {formatStatus(cs.status)}
                        </span>
                        <span>
                          {cs.items.length} item{cs.items.length !== 1 ? 's' : ''}
                        </span>
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
                    <Button
                      variant="secondary"
                      size="xs"
                      type="button"
                      onClick={() => setSelectedChangeSetId(cs.id)}
                    >
                      View Details
                    </Button>
                    {renderActions(
                      cs,
                      { onApprove, onReject, onRollback, onCancel, onSubmitForApproval },
                      prompt,
                    )}
                  </div>
                </div>

                {/* Expanded items table */}
                {isExpanded && (
                  <div className="border-t bg-gray-50 dark:bg-gray-800 px-4 py-3">
                    <DataTable<VfdChangeSetItem>
                      data={cs.items}
                      columns={vfdChangeSetItemColumns}
                      keyExtractor={(item) => item.id}
                      emptyMessage="No items"
                      searchable={false}
                      sortable={false}
                      stickyHeader={false}
                      compact
                    />
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
          <Button variant="secondary" type="button" onClick={onLoadMore} disabled={loading}>
            {loading ? <Spinner size="sm" color="inherit" /> : <ChevronDown className="h-4 w-4" />}
            Load More
          </Button>
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
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

interface ActionCallbacks {
  onApprove: (id: string) => Promise<unknown>;
  onReject: (id: string, reason: string) => Promise<unknown>;
  onRollback: (id: string, reason: string) => Promise<unknown>;
  onCancel: (id: string) => Promise<unknown>;
  onSubmitForApproval: (id: string) => Promise<unknown>;
}

function renderActions(cs: VfdChangeSet, cbs: ActionCallbacks, prompt: PromptFn): React.ReactNode {
  const buttons: React.ReactNode[] = [];

  if (cs.status === VfdChangeSetStatus.DRAFT) {
    buttons.push(
      <Button
        variant="primary"
        size="xs"
        leftIcon={<Play className="h-3 w-3" />}
        key="submit"
        type="button"
        onClick={() => cbs.onSubmitForApproval(cs.id)}
      >
        Submit
      </Button>,
      <Button
        variant="secondary"
        size="xs"
        key="cancel"
        type="button"
        onClick={() => cbs.onCancel(cs.id)}
      >
        Cancel
      </Button>,
    );
  }

  if (cs.status === VfdChangeSetStatus.PENDING_APPROVAL) {
    buttons.push(
      <Button
        variant="primary"
        size="xs"
        leftIcon={<Check className="h-3 w-3" />}
        key="approve"
        type="button"
        onClick={() => cbs.onApprove(cs.id)}
        data-testid={`approve-btn-${cs.id}`}
      >
        Approve
      </Button>,
      <Button
        variant="secondary"
        size="xs"
        leftIcon={<X className="h-3 w-3" />}
        key="reject"
        type="button"
        onClick={() =>
          void prompt({
            title: 'Reject change set',
            label: 'Rejection reason',
            confirmText: 'Reject',
            cancelText: 'Cancel',
          }).then((reason) => {
            if (reason) void cbs.onReject(cs.id, reason);
          })
        }
      >
        Reject
      </Button>,
    );
  }

  if (cs.status === VfdChangeSetStatus.APPROVED) {
    buttons.push(
      // SENSOR-CRITICAL-003 follow-up: there is no `applyVfdChangeSet` mutation and
      // never was. Approval IS the trigger — VfdChangeSetSchedulerService applies an
      // approved set on `vfd.changeset.approved`, with a 30s sweep as the
      // crash-durable backstop. The button here re-sent `approveVfdChangeSet`, which
      // the service rejects on anything but PENDING_APPROVAL, so every click errored
      // while the set was already on its way to the drive. Saying what will happen is
      // the honest replacement for a control that could only fail.
      <span
        key="auto-apply"
        data-testid={`changeset-auto-apply-${cs.id}`}
        className="inline-flex items-center gap-1 rounded-md bg-primary-50 dark:bg-primary-900/20 px-3 py-1 text-xs font-medium text-primary-700 dark:text-primary-300"
      >
        <Play className="h-3 w-3" />
        {cs.scheduledAt
          ? `Scheduled for ${new Date(cs.scheduledAt).toLocaleString()}`
          : 'Applying automatically'}
      </span>,
      <Button
        variant="secondary"
        size="xs"
        key="cancel-approved"
        type="button"
        onClick={() => cbs.onCancel(cs.id)}
      >
        Cancel
      </Button>,
    );
  }

  if (cs.status === VfdChangeSetStatus.APPLIED) {
    buttons.push(
      <Button
        variant="secondary"
        size="xs"
        leftIcon={<RotateCcw className="h-3 w-3" />}
        key="rollback"
        type="button"
        onClick={() =>
          void prompt({
            title: 'Roll back change set',
            label: 'Rollback reason',
            confirmText: 'Roll back',
            cancelText: 'Cancel',
          }).then((reason) => {
            if (reason) void cbs.onRollback(cs.id, reason);
          })
        }
      >
        Rollback
      </Button>,
    );
  }

  return buttons;
}
