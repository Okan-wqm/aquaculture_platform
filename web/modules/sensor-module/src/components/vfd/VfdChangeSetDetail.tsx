/**
 * VfdChangeSetDetail
 *
 * Slide-over panel showing full change set details,
 * approval/rejection flow, and item-level results.
 */

import React, { useState } from 'react';
import { Drawer, DataTable, type DataTableColumn, Button, Textarea } from '@aquaculture/shared-ui';
import {
  X,
  Check,
  Clock,
  RotateCcw,
  Play,
  AlertTriangle,
  Ban,
} from 'lucide-react';
import {
  VfdChangeSet,
  VfdChangeSetStatus,
  VfdChangeSetItem,
} from '../../types/vfd.types';

// ============================================================================
// Props
// ============================================================================

interface VfdChangeSetDetailProps {
  changeSet: VfdChangeSet | null;
  onClose: () => void;
  onApprove: (id: string) => Promise<unknown>;
  onReject: (id: string, reason: string) => Promise<unknown>;
  onRollback: (id: string, reason: string) => Promise<unknown>;
  onCancel: (id: string) => Promise<unknown>;
  onSubmitForApproval: (id: string) => Promise<unknown>;
}

// ============================================================================
// Component
// ============================================================================

export function VfdChangeSetDetail({
  changeSet,
  onClose,
  onApprove,
  onReject,
  onRollback,
  onCancel,
  onSubmitForApproval,
}: VfdChangeSetDetailProps) {
  const [rejectReason, setRejectReason] = useState('');
  const [rollbackReason, setRollbackReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [showRollbackForm, setShowRollbackForm] = useState(false);

  if (!changeSet) return null;

  const cs = changeSet;

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
      render: (_value, item) => (
        <>
          {item.errorMessage ? (
            <span className="text-red-600" title={item.errorMessage}>Error</span>
          ) : (
            item.status || '-'
          )}
        </>
      ),
    }
  ];

  return (
    <Drawer
      isOpen
      onClose={onClose}
      side="right"
      size="lg"
      title="Change Set Details"
      closeLabel="Close details"
      bodyClassName="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-6"
    >
      {/* Summary */}
      <div>
        <p className="text-sm text-gray-600 dark:text-gray-400">{cs.description || 'No description'}</p>
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div>
            <span className="text-gray-500 dark:text-gray-400">Status:</span>{' '}
            <span className="font-medium">{formatStatus(cs.status)}</span>
          </div>
          <div>
            <span className="text-gray-500 dark:text-gray-400">Items:</span>{' '}
            <span className="font-medium">{cs.items.length}</span>
          </div>
          <div>
            <span className="text-gray-500 dark:text-gray-400">Created by:</span>{' '}
            <span className="font-medium">{cs.createdBy}</span>
          </div>
          <div>
            <span className="text-gray-500 dark:text-gray-400">Created:</span>{' '}
            <span className="font-medium">{formatDate(cs.createdAt)}</span>
          </div>
          {cs.approvedBy && (
            <div>
              <span className="text-gray-500 dark:text-gray-400">Approved by:</span>{' '}
              <span className="font-medium">{cs.approvedBy}</span>
            </div>
          )}
          {cs.rejectedBy && (
            <div>
              <span className="text-gray-500 dark:text-gray-400">Rejected by:</span>{' '}
              <span className="font-medium">{cs.rejectedBy}</span>
            </div>
          )}
          {cs.appliedAt && (
            <div>
              <span className="text-gray-500 dark:text-gray-400">Applied:</span>{' '}
              <span className="font-medium">{formatDate(cs.appliedAt)}</span>
            </div>
          )}
          {cs.scheduledAt && (
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3 text-gray-400 dark:text-gray-500" />
              <span className="text-gray-500 dark:text-gray-400">Scheduled:</span>{' '}
              <span className="font-medium">{formatDate(cs.scheduledAt)}</span>
            </div>
          )}
        </div>
        {cs.rejectionReason && (
          <div className="mt-3 rounded-md bg-red-50 p-3 text-xs text-red-700">
            <strong>Rejection reason:</strong> {cs.rejectionReason}
          </div>
        )}
      </div>

      {/* Items table */}
      <div>
        <h3 className="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">Parameter Changes</h3>
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

      {/* Rejection form */}
      {showRejectForm && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 space-y-3">
          <h4 className="text-sm font-medium text-red-800">Reject Change Set</h4>
          <Textarea fullWidth value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Enter rejection reason..." rows={3} aria-label="Rejection reason" />
          <div className="flex gap-2">
            <Button variant="danger" size="xs" type="button" onClick={async () => {
                if (rejectReason.trim()) {
                  await onReject(cs.id, rejectReason.trim());
                  setShowRejectForm(false);
                  setRejectReason('');
                }
              }} disabled={!rejectReason.trim()}>Confirm Rejection</Button>
            <Button variant="secondary" size="xs" type="button" onClick={() => setShowRejectForm(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Rollback form */}
      {showRollbackForm && (
        <div className="rounded-md border border-purple-200 bg-purple-50 p-4 space-y-3">
          <h4 className="text-sm font-medium text-purple-800">Rollback Change Set</h4>
          <Textarea fullWidth value={rollbackReason} onChange={(e) => setRollbackReason(e.target.value)} placeholder="Enter rollback reason..." rows={3} aria-label="Rollback reason" />
          <div className="flex gap-2">
            <Button variant="primary" size="xs" type="button" onClick={async () => {
                if (rollbackReason.trim()) {
                  await onRollback(cs.id, rollbackReason.trim());
                  setShowRollbackForm(false);
                  setRollbackReason('');
                }
              }} disabled={!rollbackReason.trim()}>Confirm Rollback</Button>
            <Button variant="secondary" size="xs" type="button" onClick={() => setShowRollbackForm(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2 border-t pt-4">
        {cs.status === VfdChangeSetStatus.DRAFT && (
          <>
            <Button variant="primary" leftIcon={<Play className="h-4 w-4" />} type="button" onClick={() => onSubmitForApproval(cs.id)}>Submit for Approval</Button>
            <Button variant="secondary" type="button" onClick={() => onCancel(cs.id)}>Cancel</Button>
          </>
        )}

        {cs.status === VfdChangeSetStatus.PENDING_APPROVAL && (
          <>
            <Button variant="primary" leftIcon={<Check className="h-4 w-4" />} type="button" onClick={() => onApprove(cs.id)}>Approve</Button>
            <Button variant="secondary" leftIcon={<X className="h-4 w-4" />} type="button" onClick={() => setShowRejectForm(true)}>Reject</Button>
          </>
        )}

        {cs.status === VfdChangeSetStatus.APPROVED && (
          <>
            {/*
              There is no apply mutation: approval is the trigger, and the
              scheduler applies the set on the approved event with a 30s sweep
              behind it. This used to be an "Apply Now" button that re-sent
              approve and errored every time.
            */}
            <span
              data-testid="changeset-auto-apply"
              className="inline-flex items-center gap-1 rounded-md bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700"
            >
              <Play className="h-4 w-4" />
              {cs.scheduledAt
                ? `Scheduled for ${new Date(cs.scheduledAt).toLocaleString()}`
                : 'Applying automatically'}
            </span>
            <Button variant="secondary" type="button" onClick={() => onCancel(cs.id)}>Cancel</Button>
          </>
        )}

        {cs.status === VfdChangeSetStatus.APPLIED && (
          <Button variant="secondary" leftIcon={<RotateCcw className="h-4 w-4" />} type="button" onClick={() => setShowRollbackForm(true)}>Rollback</Button>
        )}
      </div>
    </Drawer>
  );
}

// ============================================================================
// Helpers
// ============================================================================

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
