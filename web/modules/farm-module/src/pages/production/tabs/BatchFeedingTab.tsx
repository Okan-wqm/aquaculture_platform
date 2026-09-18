/**
 * BatchFeedingTab
 *
 * Renders the batch's current feed assignments + the action buttons:
 *   - "Atamayı Düzenle" / "Create the first assignment" → AssignFeedsToBatchModal
 *     (the modal handles both create and edit via the `existing` prop).
 *   - "Delete Assignment" → ConfirmModal + useDeleteBatchFeedAssignment.
 *
 * Inline weight-range overlap visualisation will land in a follow-up
 * (tracked under the Scope C plan PR-3 design notes).
 */
import React, { useState } from 'react';
import {
  ConfirmModal,
  formatErrorForToast,
  useCanMutate,
  useToast,
} from '@aquaculture/shared-ui';

import type { Batch } from '../../../hooks/useBatches';
import {
  useBatchFeedAssignment,
  useDeleteBatchFeedAssignment,
} from '../../../hooks/useBatchFeedAssignments';
import AssignFeedsToBatchModal from '../components/AssignFeedsToBatchModal';

interface BatchFeedingTabProps {
  batch: Batch;
}

const BatchFeedingTab: React.FC<BatchFeedingTabProps> = ({ batch }) => {
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const canAssign = useCanMutate('assignFeedsToBatch');
  // Backend has updateBatchFeedAssignment + assignFeedsToBatch as
  // separate mutations; the UPSERT path through `assignFeedsToBatch`
  // covers edits via the modal's `existing` prop. We still gate the
  // explicit "Düzenle" affordance on the more permissive of the two.
  // Both hooks must be invoked unconditionally (rules-of-hooks); a `||`
  // between two hook calls would short-circuit the second one and make
  // the hook call order unstable across renders.
  const canUpdate = useCanMutate('updateBatchFeedAssignment');
  const canEdit = canUpdate || canAssign;
  const canDelete = useCanMutate('deleteBatchFeedAssignment');

  const { data: assignment, isLoading, error } = useBatchFeedAssignment(
    batch.id,
  );

  const { toast } = useToast();
  const deleteMutation = useDeleteBatchFeedAssignment();

  const handleDelete = async () => {
    if (!assignment) return;
    try {
      await deleteMutation.mutateAsync(assignment.id);
      toast({
        title: 'Feed assignment deleted',
        description: `Feed assignment removed for ${batch.batchNumber}.`,
        variant: 'success',
      });
      setShowDeleteConfirm(false);
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: formatErrorForToast(err),
        variant: 'error',
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            Feed Assignments
          </h2>
          <p className="text-sm text-gray-500">
            Feed assignments by weight range for this batch —
            the feeding schedule reads this mapping.
          </p>
        </div>
        <div className="flex items-center space-x-2">
          {assignment && canDelete && (
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              disabled={deleteMutation.isPending}
              className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-40"
            >
              Delete Assignment
            </button>
          )}
          {((assignment && canEdit) || (!assignment && canAssign)) && (
            <button
              type="button"
              onClick={() => setShowAssignModal(true)}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              {assignment ? 'Edit Assignment' : 'Add Feed Assignments'}
            </button>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="animate-pulse text-gray-500 text-sm">
          Loading assignments…
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
          Failed to load assignments:{' '}
          {error instanceof Error ? error.message : 'Bilinmeyen hata'}
        </div>
      )}

      {!isLoading && !error && !assignment && (
        <div className="bg-gray-50 border border-dashed border-gray-300 rounded-lg p-6 text-center">
          <p className="text-sm text-gray-600">
            No feed assignments have been made for this batch yet.
          </p>
          {canAssign && (
            <button
              type="button"
              onClick={() => setShowAssignModal(true)}
              className="mt-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Create the first assignment
            </button>
          )}
        </div>
      )}

      {assignment && (
        <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th
                  scope="col"
                  className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase"
                >
                  Yem
                </th>
                <th
                  scope="col"
                  className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase"
                >
                  Min Weight (g)
                </th>
                <th
                  scope="col"
                  className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase"
                >
                  Max Weight (g)
                </th>
                <th
                  scope="col"
                  className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase"
                >
                  Priority
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {assignment.feedAssignments.map((entry, idx) => (
                <tr key={`${entry.feedId}-${idx}`}>
                  <td className="px-4 py-2 text-sm text-gray-900">
                    <div className="font-medium">{entry.feedName}</div>
                    <div className="text-xs text-gray-500">
                      {entry.feedCode}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-900">
                    {entry.minWeightG.toLocaleString('tr-TR')}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-900">
                    {entry.maxWeightG.toLocaleString('tr-TR')}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-900">
                    {entry.priority ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {assignment.notes && (
            <div className="border-t border-gray-200 p-3 text-sm text-gray-600">
              <span className="font-semibold">Notes:</span>{' '}
              <span className="whitespace-pre-wrap">{assignment.notes}</span>
            </div>
          )}
        </div>
      )}

      <AssignFeedsToBatchModal
        isOpen={showAssignModal}
        onClose={() => setShowAssignModal(false)}
        batchId={batch.id}
        batchNumber={batch.batchNumber}
        existing={assignment ?? null}
      />

      <ConfirmModal
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Delete feed assignment?"
        message={
          <span>
            <strong className="font-semibold">{batch.batchNumber}</strong>{' '}
            batch's entire feed assignment (
            <span className="font-semibold">
              {assignment?.feedAssignments.length ?? 0} rows
            </span>
            ) will be deleted. This can leave the feeding schedule unable
            to recognize this batch — plan a replacement assignment
            before deleting.
          </span>
        }
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        isLoading={deleteMutation.isPending}
      />
    </div>
  );
};

export default BatchFeedingTab;
