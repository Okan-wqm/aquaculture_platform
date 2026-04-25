/**
 * BatchFeedingTab
 *
 * Renders the batch's current feed assignments + the action button
 * that opens `AssignFeedsToBatchModal` (create OR edit — the modal
 * handles both via the `existing` prop).
 *
 * Per-row Edit / Delete actions (Tier 2 PR-3) and the inline weight-
 * range overlap visualisation will land in the next PR.
 */
import React, { useState } from 'react';
import { useCanMutate } from '@aquaculture/shared-ui';

import type { Batch } from '../../../hooks/useBatches';
import { useBatchFeedAssignment } from '../../../hooks/useBatchFeedAssignments';
import AssignFeedsToBatchModal from '../components/AssignFeedsToBatchModal';

interface BatchFeedingTabProps {
  batch: Batch;
}

const BatchFeedingTab: React.FC<BatchFeedingTabProps> = ({ batch }) => {
  const [showAssignModal, setShowAssignModal] = useState(false);
  const canAssign = useCanMutate('assignFeedsToBatch');

  const { data: assignment, isLoading, error } = useBatchFeedAssignment(
    batch.id,
  );

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
        {canAssign && (
          <button
            type="button"
            onClick={() => setShowAssignModal(true)}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            {assignment ? 'Atamayı Düzenle' : 'Yem Atamaları Ekle'}
          </button>
        )}
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
                  Min Ağırlık (g)
                </th>
                <th
                  scope="col"
                  className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase"
                >
                  Max Ağırlık (g)
                </th>
                <th
                  scope="col"
                  className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase"
                >
                  Öncelik
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
    </div>
  );
};

export default BatchFeedingTab;
