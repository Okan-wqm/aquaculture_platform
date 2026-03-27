/**
 * VfdChangeSetDetail
 *
 * Slide-over panel showing full change set details,
 * approval/rejection flow, and item-level results.
 */

import React, { useState } from 'react';
import {
  X,
  Check,
  Clock,
  RotateCcw,
  Play,
  AlertTriangle,
  Ban,
} from 'lucide-react';
import { VfdChangeSet, VfdChangeSetStatus } from '../../types/vfd.types';

// ============================================================================
// Props
// ============================================================================

interface VfdChangeSetDetailProps {
  changeSet: VfdChangeSet | null;
  onClose: () => void;
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

export function VfdChangeSetDetail({
  changeSet,
  onClose,
  onApprove,
  onReject,
  onApply,
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

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Change set details"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="relative w-full max-w-lg overflow-y-auto bg-white shadow-xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Change Set Details</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close details"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-6">
          {/* Summary */}
          <div>
            <p className="text-sm text-gray-600">{cs.description || 'No description'}</p>
            <div className="mt-2 grid grid-cols-2 gap-3 text-xs">
              <div>
                <span className="text-gray-500">Status:</span>{' '}
                <span className="font-medium">{formatStatus(cs.status)}</span>
              </div>
              <div>
                <span className="text-gray-500">Items:</span>{' '}
                <span className="font-medium">{cs.items.length}</span>
              </div>
              <div>
                <span className="text-gray-500">Created by:</span>{' '}
                <span className="font-medium">{cs.createdBy}</span>
              </div>
              <div>
                <span className="text-gray-500">Created:</span>{' '}
                <span className="font-medium">{formatDate(cs.createdAt)}</span>
              </div>
              {cs.approvedBy && (
                <div>
                  <span className="text-gray-500">Approved by:</span>{' '}
                  <span className="font-medium">{cs.approvedBy}</span>
                </div>
              )}
              {cs.rejectedBy && (
                <div>
                  <span className="text-gray-500">Rejected by:</span>{' '}
                  <span className="font-medium">{cs.rejectedBy}</span>
                </div>
              )}
              {cs.appliedAt && (
                <div>
                  <span className="text-gray-500">Applied:</span>{' '}
                  <span className="font-medium">{formatDate(cs.appliedAt)}</span>
                </div>
              )}
              {cs.scheduledAt && (
                <div className="flex items-center gap-1">
                  <Clock className="h-3 w-3 text-gray-400" />
                  <span className="text-gray-500">Scheduled:</span>{' '}
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
            <h3 className="mb-2 text-sm font-medium text-gray-900">Parameter Changes</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-gray-500">
                    <th className="pb-2 pr-3">Parameter</th>
                    <th className="pb-2 pr-3">Previous</th>
                    <th className="pb-2 pr-3">Requested</th>
                    <th className="pb-2 pr-3">Applied</th>
                    <th className="pb-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {cs.items.map((item) => (
                    <tr key={item.id} className="border-b border-gray-100">
                      <td className="py-2 pr-3 font-mono font-medium">{item.parameterName}</td>
                      <td className="py-2 pr-3 text-gray-600">{item.previousValue ?? '-'}</td>
                      <td className="py-2 pr-3 font-medium text-indigo-700">{item.requestedValue}</td>
                      <td className="py-2 pr-3">{item.appliedValue ?? '-'}</td>
                      <td className="py-2">
                        {item.errorMessage ? (
                          <span className="text-red-600" title={item.errorMessage}>Error</span>
                        ) : (
                          item.status || '-'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Rejection form */}
          {showRejectForm && (
            <div className="rounded-md border border-red-200 bg-red-50 p-4 space-y-3">
              <h4 className="text-sm font-medium text-red-800">Reject Change Set</h4>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Enter rejection reason..."
                rows={3}
                className="w-full rounded-md border border-red-300 px-3 py-2 text-sm focus:border-red-500 focus:ring-red-500"
                aria-label="Rejection reason"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    if (rejectReason.trim()) {
                      await onReject(cs.id, rejectReason.trim());
                      setShowRejectForm(false);
                      setRejectReason('');
                    }
                  }}
                  disabled={!rejectReason.trim()}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  Confirm Rejection
                </button>
                <button
                  type="button"
                  onClick={() => setShowRejectForm(false)}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Rollback form */}
          {showRollbackForm && (
            <div className="rounded-md border border-purple-200 bg-purple-50 p-4 space-y-3">
              <h4 className="text-sm font-medium text-purple-800">Rollback Change Set</h4>
              <textarea
                value={rollbackReason}
                onChange={(e) => setRollbackReason(e.target.value)}
                placeholder="Enter rollback reason..."
                rows={3}
                className="w-full rounded-md border border-purple-300 px-3 py-2 text-sm focus:border-purple-500 focus:ring-purple-500"
                aria-label="Rollback reason"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    if (rollbackReason.trim()) {
                      await onRollback(cs.id, rollbackReason.trim());
                      setShowRollbackForm(false);
                      setRollbackReason('');
                    }
                  }}
                  disabled={!rollbackReason.trim()}
                  className="rounded-md bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-50"
                >
                  Confirm Rollback
                </button>
                <button
                  type="button"
                  onClick={() => setShowRollbackForm(false)}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2 border-t pt-4">
            {cs.status === VfdChangeSetStatus.DRAFT && (
              <>
                <button
                  type="button"
                  onClick={() => onSubmitForApproval(cs.id)}
                  className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
                >
                  <Play className="h-4 w-4" /> Submit for Approval
                </button>
                <button
                  type="button"
                  onClick={() => onCancel(cs.id)}
                  className="rounded-md border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  Cancel
                </button>
              </>
            )}

            {cs.status === VfdChangeSetStatus.PENDING_APPROVAL && (
              <>
                <button
                  type="button"
                  onClick={() => onApprove(cs.id)}
                  className="inline-flex items-center gap-1 rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
                >
                  <Check className="h-4 w-4" /> Approve
                </button>
                <button
                  type="button"
                  onClick={() => setShowRejectForm(true)}
                  className="inline-flex items-center gap-1 rounded-md border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  <X className="h-4 w-4" /> Reject
                </button>
              </>
            )}

            {cs.status === VfdChangeSetStatus.APPROVED && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm('Apply this change set to the VFD device?')) {
                      onApply(cs.id);
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
                >
                  <Play className="h-4 w-4" /> Apply Now
                </button>
                <button
                  type="button"
                  onClick={() => onCancel(cs.id)}
                  className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </>
            )}

            {cs.status === VfdChangeSetStatus.APPLIED && (
              <button
                type="button"
                onClick={() => setShowRollbackForm(true)}
                className="inline-flex items-center gap-1 rounded-md border border-purple-200 px-4 py-2 text-sm font-medium text-purple-600 hover:bg-purple-50"
              >
                <RotateCcw className="h-4 w-4" /> Rollback
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
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
