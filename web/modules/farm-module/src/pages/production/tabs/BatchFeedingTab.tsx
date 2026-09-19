/**
 * BatchFeedingTab
 *
 * Renders the batch's current feed assignments + the action buttons:
 *   - "Atamayı Düzenle" / "İlk atamayı oluştur" → AssignFeedsToBatchModal
 *     (the modal handles both create and edit via the `existing` prop).
 *   - "Atamayı Sil" → ConfirmModal + useDeleteBatchFeedAssignment.
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
import { DataTable, type DataTableColumn } from '@aquaculture/shared-ui';

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
        title: 'Yem ataması silindi',
        description: `${batch.batchNumber} için yem ataması kaldırıldı.`,
        variant: 'success',
      });
      setShowDeleteConfirm(false);
    } catch (err) {
      toast({
        title: 'Silme başarısız',
        description: formatErrorForToast(err),
        variant: 'error',
      });
    }
  };

  type EntryRow = NonNullable<NonNullable<typeof assignment>['feedAssignments']>[number];
  const entryRowColumns: DataTableColumn<EntryRow>[] = [
    {
      key: 'yem',
      header: 'Yem',
      render: (_value, entry) => (
        <>
          <div className="font-medium">{entry.feedName}</div>
          <div className="text-xs text-gray-500">
            {entry.feedCode}
          </div>
        </>
      ),
    },
    {
      key: 'minARlKG',
      header: 'Min Ağırlık (g)',
      render: (_value, entry) => entry.minWeightG.toLocaleString('tr-TR'),
    },
    {
      key: 'maxARlKG',
      header: 'Max Ağırlık (g)',
      render: (_value, entry) => entry.maxWeightG.toLocaleString('tr-TR'),
    },
    {
      key: 'ncelik',
      header: 'Öncelik',
      render: (_value, entry) => entry.priority ?? '—',
    }
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            Yem Atamaları
          </h2>
          <p className="text-sm text-gray-500">
            Bu partinin ağırlık aralıklarına göre yem atamaları —
            yemleme planı bu eşlemeyi okur.
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
              Atamayı Sil
            </button>
          )}
          {((assignment && canEdit) || (!assignment && canAssign)) && (
            <button
              type="button"
              onClick={() => setShowAssignModal(true)}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              {assignment ? 'Atamayı Düzenle' : 'Yem Atamaları Ekle'}
            </button>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="animate-pulse text-gray-500 text-sm">
          Atamalar yükleniyor…
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
          Atamalar yüklenemedi:{' '}
          {error instanceof Error ? error.message : 'Bilinmeyen hata'}
        </div>
      )}

      {!isLoading && !error && !assignment && (
        <div className="bg-gray-50 border border-dashed border-gray-300 rounded-lg p-6 text-center">
          <p className="text-sm text-gray-600">
            Bu parti için henüz yem ataması yapılmamış.
          </p>
          {canAssign && (
            <button
              type="button"
              onClick={() => setShowAssignModal(true)}
              className="mt-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              İlk atamayı oluştur
            </button>
          )}
        </div>
      )}

      {assignment && (
        <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
          <DataTable<EntryRow>
            data={assignment.feedAssignments}
            columns={entryRowColumns}
            keyExtractor={(entry, idx) => String(`${entry.feedId}-${idx}`)}
            emptyMessage="No records found"
            searchable={false}
            sortable={false}
            stickyHeader={false}
          />
          {assignment.notes && (
            <div className="border-t border-gray-200 p-3 text-sm text-gray-600">
              <span className="font-semibold">Notlar:</span>{' '}
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
        title="Yem ataması silinsin mi?"
        message={
          <span>
            <strong className="font-semibold">{batch.batchNumber}</strong>{' '}
            partisinin tüm yem ataması (
            <span className="font-semibold">
              {assignment?.feedAssignments.length ?? 0} satır
            </span>
            ) silinecek. Bu işlem yemleme programının bu partiyi
            tanımayan duruma dönmesine yol açar — silmeden önce
            yerine yeni bir atama planlamanız önerilir.
          </span>
        }
        confirmText="Sil"
        cancelText="İptal"
        variant="danger"
        isLoading={deleteMutation.isPending}
      />
    </div>
  );
};

export default BatchFeedingTab;
