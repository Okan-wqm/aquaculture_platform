/**
 * BatchOverviewTab
 *
 * Renders batch metadata cards (quantity / biomass / dates / status)
 * + the action buttons that wire the Tier 1 mutation modals:
 *
 *   - "Durum Güncelle" → UpdateBatchStatusModal
 *   - "Partiyi Kapat" → CloseBatchModal
 *
 * Both buttons are gated by `useCanMutate(...)` so a MODULE_USER
 * who lacks the role sees no button. The modals themselves
 * already enforce the same gate via the resolver, but rendering
 * the disabled button would be poor UX.
 */
import React, { useState } from 'react';
import { useCanMutate } from '@aquaculture/shared-ui';

import type { Batch } from '../../../hooks/useBatches';
import CloseBatchModal from '../components/CloseBatchModal';
import UpdateBatchModal from '../components/UpdateBatchModal';
import UpdateBatchStatusModal from '../components/UpdateBatchStatusModal';

interface BatchOverviewTabProps {
  batch: Batch;
}

const BatchOverviewTab: React.FC<BatchOverviewTabProps> = ({ batch }) => {
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);

  const canUpdate = useCanMutate('updateBatch');
  const canUpdateStatus = useCanMutate('updateBatchStatus');
  const canClose = useCanMutate('closeBatch');

  const closableStatuses = new Set([
    'ACTIVE',
    'GROWING',
    'PRE_HARVEST',
    'HARVESTING',
    'HARVESTED',
  ]);
  const closeButtonDisabled = !closableStatuses.has(batch.status);

  return (
    <div className="space-y-6">
      {/* Action row */}
      <div className="flex flex-wrap gap-2">
        {canUpdate && (
          <button
            type="button"
            onClick={() => setShowEditModal(true)}
            className="px-3 py-1.5 text-sm bg-gray-600 text-white rounded hover:bg-gray-700"
          >
            Düzenle
          </button>
        )}
        {canUpdateStatus && (
          <button
            type="button"
            onClick={() => setShowStatusModal(true)}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Durum Güncelle
          </button>
        )}
        {canClose && (
          <button
            type="button"
            onClick={() => setShowCloseModal(true)}
            disabled={closeButtonDisabled}
            title={
              closeButtonDisabled
                ? 'Bu durumdaki bir parti kapatılamaz'
                : undefined
            }
            className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Partiyi Kapat
          </button>
        )}
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <MetadataCard
          label="İlk Adet"
          value={batch.initialQuantity.toLocaleString('tr-TR')}
        />
        <MetadataCard
          label="Mevcut Adet"
          value={batch.currentQuantity.toLocaleString('tr-TR')}
        />
        <MetadataCard
          label="Toplam Mortalite"
          value={`${batch.totalMortality.toLocaleString('tr-TR')} (${(batch.mortalityRate ?? 0).toFixed(2)}%)`}
        />
        <MetadataCard
          label="Mevcut Biyokütle"
          value={
            batch.currentBiomassKg !== undefined
              ? `${batch.currentBiomassKg.toFixed(1)} kg`
              : '—'
          }
        />
        <MetadataCard
          label="Ortalama Ağırlık"
          value={
            batch.currentAvgWeightG !== undefined
              ? `${batch.currentAvgWeightG.toFixed(1)} g`
              : '—'
          }
        />
        <MetadataCard
          label="Üretimde Kalan Gün"
          value={
            batch.daysInProduction !== undefined
              ? `${batch.daysInProduction} gün`
              : '—'
          }
        />
        <MetadataCard
          label="Stok Tarihi"
          value={new Date(batch.stockedAt).toLocaleDateString('tr-TR')}
        />
        <MetadataCard
          label="Beklenen Hasat"
          value={
            batch.expectedHarvestDate
              ? new Date(batch.expectedHarvestDate).toLocaleDateString('tr-TR')
              : '—'
          }
        />
        <MetadataCard
          label="FCR (hedef / gerçek)"
          value={`${batch.fcr.target.toFixed(2)} / ${(batch.fcr.actual ?? 0).toFixed(2)}`}
        />
      </div>

      {/* Description / notes */}
      {(batch.description || batch.notes) && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          {batch.description && (
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase">
                Açıklama
              </div>
              <p className="mt-1 text-sm text-gray-700">
                {batch.description}
              </p>
            </div>
          )}
          {batch.notes && (
            <div className="mt-3">
              <div className="text-xs font-semibold text-gray-500 uppercase">
                Notlar
              </div>
              <p className="mt-1 text-sm text-gray-700 whitespace-pre-wrap">
                {batch.notes}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Modals — each renders only when its `isOpen` prop is true */}
      <UpdateBatchModal
        isOpen={showEditModal}
        onClose={() => setShowEditModal(false)}
        batch={batch}
      />
      <UpdateBatchStatusModal
        isOpen={showStatusModal}
        onClose={() => setShowStatusModal(false)}
        batchId={batch.id}
        batchNumber={batch.batchNumber}
        currentStatus={batch.status}
      />
      <CloseBatchModal
        isOpen={showCloseModal}
        onClose={() => setShowCloseModal(false)}
        batchId={batch.id}
        batchNumber={batch.batchNumber}
      />
    </div>
  );
};

const MetadataCard: React.FC<{ label: string; value: React.ReactNode }> = ({
  label,
  value,
}) => (
  <div className="bg-white border border-gray-200 rounded-lg p-3">
    <div className="text-xs font-semibold text-gray-500 uppercase">
      {label}
    </div>
    <div className="mt-1 text-base font-medium text-gray-900">{value}</div>
  </div>
);

export default BatchOverviewTab;
