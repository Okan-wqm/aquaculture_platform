/**
 * BatchTanksTab
 *
 * Renders the batch's current tank allocations + the action button
 * that opens `AllocateBatchToTankModal` for new allocations.
 *
 * The list itself reads from `batch.currentQuantity` — the existing
 * `useBatch` hook's payload doesn't include allocation rows yet
 * (would need a `batch.tankAllocations` field on the Batch GraphQL
 * type). For PR-0b we surface the high-level total and the button;
 * the detailed allocation list lands as part of PR-2/PR-3.
 */
import React, { useState } from 'react';
import { useCanMutate } from '@aquaculture/shared-ui';

import type { Batch } from '../../../hooks/useBatches';
import AllocateBatchToTankModal from '../components/AllocateBatchToTankModal';

interface BatchTanksTabProps {
  batch: Batch;
}

/**
 * Coarse "available to allocate" estimate. In this Scope C PR-0b
 * iteration we use the batch's `currentQuantity` because the
 * GraphQL Batch type does not yet expose a per-tank allocation
 * relation. The modal itself runs the precise capacity check
 * inside the mutation, so over-estimation here only affects the
 * front-end affordance — the backend rejects an over-allocation.
 */
function estimateAvailableForAllocation(batch: Batch): number {
  return Math.max(0, batch.currentQuantity);
}

const BatchTanksTab: React.FC<BatchTanksTabProps> = ({ batch }) => {
  const [showAllocateModal, setShowAllocateModal] = useState(false);
  const canAllocate = useCanMutate('allocateBatchToTank');

  const allocatableStatuses = new Set([
    'QUARANTINE',
    'ACTIVE',
    'GROWING',
    'PRE_HARVEST',
  ]);
  const buttonDisabled =
    !allocatableStatuses.has(batch.status) || batch.currentQuantity <= 0;

  const availableForAllocation = estimateAvailableForAllocation(batch);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            Tank Tahsisleri
          </h2>
          <p className="text-sm text-gray-500">
            Bu partinin tanklara dağılımı. Yeni tank tahsisi için
            "Tanka Tahsis Et" butonunu kullanın.
          </p>
        </div>
        {canAllocate && (
          <button
            type="button"
            onClick={() => setShowAllocateModal(true)}
            disabled={buttonDisabled}
            title={
              buttonDisabled
                ? batch.currentQuantity <= 0
                  ? 'Tahsis edilebilir adet kalmadı'
                  : 'Bu durumdaki bir parti tahsis edilemez'
                : undefined
            }
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Tanka Tahsis Et
          </button>
        )}
      </div>

      {/* Summary card — replaced with per-tank breakdown in a follow-up
          when the GraphQL Batch type exposes allocations relationally */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase">
              İlk Stok Adet
            </div>
            <div className="mt-1 text-lg font-medium text-gray-900">
              {batch.initialQuantity.toLocaleString('tr-TR')}
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase">
              Mevcut Adet
            </div>
            <div className="mt-1 text-lg font-medium text-gray-900">
              {batch.currentQuantity.toLocaleString('tr-TR')}
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase">
              Mevcut Biyokütle
            </div>
            <div className="mt-1 text-lg font-medium text-gray-900">
              {batch.currentBiomassKg !== undefined
                ? `${batch.currentBiomassKg.toFixed(1)} kg`
                : '—'}
            </div>
          </div>
        </div>
      </div>

      <AllocateBatchToTankModal
        isOpen={showAllocateModal}
        onClose={() => setShowAllocateModal(false)}
        batchId={batch.id}
        batchNumber={batch.batchNumber}
        availableBatchQuantity={availableForAllocation}
      />
    </div>
  );
};

export default BatchTanksTab;
