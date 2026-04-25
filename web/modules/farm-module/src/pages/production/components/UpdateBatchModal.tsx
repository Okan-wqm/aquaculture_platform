/**
 * UpdateBatchModal — Tier 2 #1 (Scope C PR-2)
 *
 * Edits a batch's *metadata* — name, expected harvest date, target
 * FCR, and notes. Status / quantity / biomass changes are NOT
 * available through this surface; those go through the dedicated
 * `UpdateBatchStatusModal` and the lifecycle mutations.
 *
 * Pattern follows the canonical Tier 1 modal shape:
 *   - useState for each form field
 *   - useMemo(errors) for client-side validation (no zod, no RHF —
 *     consistent with the rest of farm-module)
 *   - shared `parseGraphQLError` for backend error mapping
 *   - submit button disabled while validation fails OR mutation pending
 *
 * Validation rules (mirror backend's UpdateBatchInput shape):
 *   - name: optional; if present, 1..255 chars after trim
 *   - expectedHarvestDate: optional; if present, must be >= stockedAt
 *   - targetFCR: optional; if present, in [0.5, 5.0]
 *   - notes: optional; <=2000 chars
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Modal,
  formatErrorForToast,
  useToast,
} from '@aquaculture/shared-ui';

import { Batch, useUpdateBatch } from '../../../hooks/useBatches';

interface UpdateBatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  batch: Batch;
  onSuccess?: () => void;
}

const NAME_MAX = 255;
const NOTES_MAX = 2000;
const TARGET_FCR_MIN = 0.5;
const TARGET_FCR_MAX = 5.0;

function toDateInputValue(iso?: string): string {
  if (!iso) return '';
  // YYYY-MM-DD slice for `<input type="date">`
  return iso.length >= 10 ? iso.slice(0, 10) : '';
}

const UpdateBatchModal: React.FC<UpdateBatchModalProps> = ({
  isOpen,
  onClose,
  batch,
  onSuccess,
}) => {
  const { toast } = useToast();
  const updateBatch = useUpdateBatch();

  const [name, setName] = useState<string>(batch.name ?? '');
  const [expectedHarvestDate, setExpectedHarvestDate] = useState<string>(
    toDateInputValue(batch.expectedHarvestDate),
  );
  const [targetFCRRaw, setTargetFCRRaw] = useState<string>(
    batch.fcr.target ? String(batch.fcr.target) : '',
  );
  const [notes, setNotes] = useState<string>(batch.notes ?? '');

  // Reset form whenever the modal re-opens against a different batch
  // (a previous edit's state must not leak into the new batch's form).
  useEffect(() => {
    if (isOpen) {
      setName(batch.name ?? '');
      setExpectedHarvestDate(toDateInputValue(batch.expectedHarvestDate));
      setTargetFCRRaw(batch.fcr.target ? String(batch.fcr.target) : '');
      setNotes(batch.notes ?? '');
    }
  }, [isOpen, batch.id, batch.name, batch.expectedHarvestDate, batch.fcr.target, batch.notes]);

  const targetFCRParsed: number | null = useMemo(() => {
    const trimmed = targetFCRRaw.trim();
    if (trimmed.length === 0) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN;
  }, [targetFCRRaw]);

  const errors: string[] = useMemo(() => {
    const errs: string[] = [];

    const trimmedName = name.trim();
    if (trimmedName.length > NAME_MAX) {
      errs.push(`İsim ${NAME_MAX} karakteri aşamaz.`);
    }

    if (expectedHarvestDate) {
      const stocked = new Date(batch.stockedAt);
      const target = new Date(expectedHarvestDate);
      if (Number.isNaN(target.getTime())) {
        errs.push('Hasat tarihi geçerli bir tarih olmalı.');
      } else if (target < stocked) {
        errs.push('Hasat tarihi stoklama tarihinden önce olamaz.');
      }
    }

    if (targetFCRParsed !== null) {
      if (Number.isNaN(targetFCRParsed)) {
        errs.push('Hedef FCR sayısal bir değer olmalı.');
      } else if (
        targetFCRParsed < TARGET_FCR_MIN ||
        targetFCRParsed > TARGET_FCR_MAX
      ) {
        errs.push(
          `Hedef FCR ${TARGET_FCR_MIN.toFixed(1)} ile ${TARGET_FCR_MAX.toFixed(1)} arasında olmalı.`,
        );
      }
    }

    if (notes.length > NOTES_MAX) {
      errs.push(`Notlar ${NOTES_MAX} karakteri aşamaz.`);
    }

    return errs;
  }, [name, expectedHarvestDate, targetFCRParsed, notes, batch.stockedAt]);

  /**
   * The "is anything actually different" gate: if the user opens the
   * modal and submits without changing a field, we have nothing to
   * send. Prevents an empty mutation that would just bump updatedAt.
   */
  const hasChanges: boolean = useMemo(() => {
    const trimmedName = name.trim();
    const trimmedNotes = notes;
    const currentName = (batch.name ?? '').trim();
    const currentNotes = batch.notes ?? '';
    const currentExpected = toDateInputValue(batch.expectedHarvestDate);
    const currentFCR = batch.fcr.target;

    if (trimmedName !== currentName) return true;
    if (expectedHarvestDate !== currentExpected) return true;
    if (notes !== currentNotes && trimmedNotes !== currentNotes) return true;
    if (notes !== currentNotes) return true;
    if (targetFCRParsed !== null && targetFCRParsed !== currentFCR) {
      return true;
    }
    return false;
  }, [
    name,
    notes,
    expectedHarvestDate,
    targetFCRParsed,
    batch.name,
    batch.notes,
    batch.expectedHarvestDate,
    batch.fcr.target,
  ]);

  const isValid = errors.length === 0;
  const canSubmit = isValid && hasChanges && !updateBatch.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const trimmedName = name.trim();
    const currentName = (batch.name ?? '').trim();
    const currentExpected = toDateInputValue(batch.expectedHarvestDate);
    const currentNotes = batch.notes ?? '';

    try {
      await updateBatch.mutateAsync({
        id: batch.id,
        ...(trimmedName !== currentName && {
          name: trimmedName.length === 0 ? undefined : trimmedName,
        }),
        ...(expectedHarvestDate !== currentExpected && {
          expectedHarvestDate:
            expectedHarvestDate.length === 0 ? undefined : expectedHarvestDate,
        }),
        ...(targetFCRParsed !== null &&
          targetFCRParsed !== batch.fcr.target && {
            targetFCR: targetFCRParsed,
          }),
        ...(notes !== currentNotes && { notes }),
      });
      toast({
        title: 'Parti güncellendi',
        description: `${batch.batchNumber} bilgileri güncellendi.`,
        variant: 'success',
      });
      onSuccess?.();
      onClose();
    } catch (err) {
      toast({
        title: 'Güncelleme başarısız',
        description: formatErrorForToast(err),
        variant: 'error',
      });
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Parti Bilgilerini Düzenle"
      size="md"
    >
      <div className="space-y-4">
        <div className="bg-gray-50 rounded-lg p-3">
          <p className="text-xs text-gray-500">Parti</p>
          <p className="font-medium text-gray-900">{batch.batchNumber}</p>
        </div>

        <div>
          <label
            htmlFor="update-batch-name"
            className="block text-sm font-medium text-gray-700"
          >
            İsim
          </label>
          <input
            id="update-batch-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={NAME_MAX}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="(opsiyonel) parti için anlamlı bir isim"
          />
        </div>

        <div>
          <label
            htmlFor="update-batch-harvest-date"
            className="block text-sm font-medium text-gray-700"
          >
            Beklenen Hasat Tarihi
          </label>
          <input
            id="update-batch-harvest-date"
            type="date"
            value={expectedHarvestDate}
            onChange={(e) => setExpectedHarvestDate(e.target.value)}
            min={batch.stockedAt.slice(0, 10)}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="mt-1 text-xs text-gray-500">
            Stok tarihi: {new Date(batch.stockedAt).toLocaleDateString('tr-TR')}
          </p>
        </div>

        <div>
          <label
            htmlFor="update-batch-fcr"
            className="block text-sm font-medium text-gray-700"
          >
            Hedef FCR
          </label>
          <input
            id="update-batch-fcr"
            type="number"
            step="0.01"
            min={TARGET_FCR_MIN}
            max={TARGET_FCR_MAX}
            value={targetFCRRaw}
            onChange={(e) => setTargetFCRRaw(e.target.value)}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder={`${TARGET_FCR_MIN.toFixed(1)} – ${TARGET_FCR_MAX.toFixed(1)}`}
          />
          <p className="mt-1 text-xs text-gray-500">
            Mevcut: hedef {batch.fcr.target.toFixed(2)} / gerçek{' '}
            {(batch.fcr.actual ?? 0).toFixed(2)}
          </p>
        </div>

        <div>
          <label
            htmlFor="update-batch-notes"
            className="block text-sm font-medium text-gray-700"
          >
            Notlar
          </label>
          <textarea
            id="update-batch-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={NOTES_MAX}
            rows={4}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="mt-1 text-xs text-gray-500 text-right">
            {notes.length} / {NOTES_MAX}
          </p>
        </div>

        {errors.length > 0 && (
          <ul className="list-disc list-inside text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        {!hasChanges && errors.length === 0 && (
          <p className="text-xs text-gray-500 italic">
            Hiçbir alan değişmedi — kaydetmek için bir alanı düzenleyin.
          </p>
        )}

        <div className="flex justify-end space-x-2 pt-2">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={updateBatch.isPending}
          >
            İptal
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {updateBatch.isPending ? 'Kaydediliyor…' : 'Kaydet'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default UpdateBatchModal;
