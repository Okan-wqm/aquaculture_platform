/**
 * SubEquipmentModal
 *
 * Dual-purpose create/edit modal for a sub-equipment row attached to
 * a parent equipment (tank, feeder, aerator, etc.). The backend
 * `createSubEquipment` and `updateSubEquipment` mutations share a
 * nearly identical input shape so the form exposes both flows via
 * the `mode` prop.
 *
 * Phase 3 Tier 1 + Tier 3 sub-equipment CRUD of the "Farm modülü
 * kalan kör noktalar" plan.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Button, useToast } from '@aquaculture/shared-ui';

import {
  CreateSubEquipmentInput,
  EquipmentStatus,
  SubEquipment,
  UpdateSubEquipmentInput,
  useCreateSubEquipment,
  useSubEquipmentTypes,
  useUpdateSubEquipment,
} from '../../../hooks/useSubEquipment';

interface SubEquipmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'create' | 'edit';
  parentEquipmentId: string;
  parentEquipmentTypeCode?: string;
  existing?: SubEquipment;
  onSuccess?: () => void;
}

const STATUS_OPTIONS: Array<{ value: EquipmentStatus; label: string }> = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'MAINTENANCE', label: 'Maintenance' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'RETIRED', label: 'Retired' },
];

interface FormState {
  subEquipmentTypeId: string;
  name: string;
  code: string;
  description: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  status: EquipmentStatus;
  installationDate: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  subEquipmentTypeId: '',
  name: '',
  code: '',
  description: '',
  manufacturer: '',
  model: '',
  serialNumber: '',
  status: 'ACTIVE',
  installationDate: '',
  notes: '',
};

function toFormState(existing?: SubEquipment): FormState {
  if (!existing) return EMPTY_FORM;
  return {
    subEquipmentTypeId: existing.subEquipmentTypeId,
    name: existing.name,
    code: existing.code,
    description: existing.description ?? '',
    manufacturer: existing.manufacturer ?? '',
    model: existing.model ?? '',
    serialNumber: existing.serialNumber ?? '',
    status: existing.status ?? 'ACTIVE',
    installationDate: existing.installationDate?.slice(0, 10) ?? '',
    notes: existing.notes ?? '',
  };
}

export const SubEquipmentModal: React.FC<SubEquipmentModalProps> = ({
  isOpen,
  onClose,
  mode,
  parentEquipmentId,
  parentEquipmentTypeCode,
  existing,
  onSuccess,
}) => {
  const [form, setForm] = useState<FormState>(toFormState(existing));

  useEffect(() => {
    setForm(toFormState(existing));
  }, [existing, isOpen]);

  const subEquipmentTypes = useSubEquipmentTypes(parentEquipmentTypeCode);
  const createMutation = useCreateSubEquipment();
  const updateMutation = useUpdateSubEquipment();
  const { toast } = useToast();

  const submitting = createMutation.isPending || updateMutation.isPending;

  const errors = useMemo(() => {
    const errs: string[] = [];
    if (mode === 'create' && !form.subEquipmentTypeId) {
      errs.push('Choose a sub-equipment type.');
    }
    if (form.name.trim().length < 2) {
      errs.push('Name must be at least 2 characters.');
    }
    if (form.name.length > 255) {
      errs.push('Name cannot exceed 255 characters.');
    }
    if (form.code.trim().length < 2) {
      errs.push('Code must be at least 2 characters.');
    }
    if (form.code.length > 50) {
      errs.push('Code cannot exceed 50 characters.');
    }
    return errs;
  }, [form, mode]);

  const isValid = errors.length === 0;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async () => {
    if (!isValid) return;

    try {
      if (mode === 'create') {
        const input: CreateSubEquipmentInput = {
          parentEquipmentId,
          subEquipmentTypeId: form.subEquipmentTypeId,
          name: form.name.trim(),
          code: form.code.trim(),
          description: form.description.trim() || undefined,
          manufacturer: form.manufacturer.trim() || undefined,
          model: form.model.trim() || undefined,
          serialNumber: form.serialNumber.trim() || undefined,
          status: form.status,
          installationDate: form.installationDate || undefined,
          notes: form.notes.trim() || undefined,
        };
        await createMutation.mutateAsync(input);
        toast({
          title: 'Sub-equipment created',
          description: `${form.name} attached to parent equipment.`,
          variant: 'success',
        });
      } else {
        if (!existing) throw new Error('Missing existing sub-equipment.');
        const input: UpdateSubEquipmentInput = {
          id: existing.id,
          name: form.name.trim(),
          code: form.code.trim(),
          description: form.description.trim() || undefined,
          manufacturer: form.manufacturer.trim() || undefined,
          model: form.model.trim() || undefined,
          serialNumber: form.serialNumber.trim() || undefined,
          status: form.status,
          installationDate: form.installationDate || undefined,
          notes: form.notes.trim() || undefined,
        };
        await updateMutation.mutateAsync(input);
        toast({
          title: 'Sub-equipment updated',
          description: `${form.name} saved.`,
          variant: 'success',
        });
      }
      onSuccess?.();
      onClose();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to save sub-equipment.';
      toast({ title: 'Error', description: message, variant: 'error' });
    }
  };

  const handleClose = () => {
    setForm(toFormState(existing));
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={mode === 'create' ? 'Add sub-equipment' : 'Edit sub-equipment'}
      size="md"
    >
      <div className="space-y-6">
        {mode === 'create' && (
          <div>
            <label htmlFor="sub-eq-type" className="block text-sm font-medium text-gray-700">
              Type <span className="text-orange-500">*</span>
            </label>
            <select
              id="sub-eq-type"
              value={form.subEquipmentTypeId}
              onChange={(e) => set('subEquipmentTypeId', e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
            >
              <option value="">— Choose a type —</option>
              {subEquipmentTypes.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.code})
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="sub-eq-name" className="block text-sm font-medium text-gray-700">
              Name <span className="text-orange-500">*</span>
            </label>
            <input
              id="sub-eq-name"
              type="text"
              maxLength={255}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
            />
          </div>
          <div>
            <label htmlFor="sub-eq-code" className="block text-sm font-medium text-gray-700">
              Code <span className="text-orange-500">*</span>
            </label>
            <input
              id="sub-eq-code"
              type="text"
              maxLength={50}
              value={form.code}
              onChange={(e) => set('code', e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="sub-eq-manufacturer" className="block text-sm font-medium text-gray-700">
              Manufacturer
            </label>
            <input
              id="sub-eq-manufacturer"
              type="text"
              maxLength={100}
              value={form.manufacturer}
              onChange={(e) => set('manufacturer', e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
            />
          </div>
          <div>
            <label htmlFor="sub-eq-model" className="block text-sm font-medium text-gray-700">
              Model
            </label>
            <input
              id="sub-eq-model"
              type="text"
              maxLength={100}
              value={form.model}
              onChange={(e) => set('model', e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="sub-eq-serial" className="block text-sm font-medium text-gray-700">
              Serial number
            </label>
            <input
              id="sub-eq-serial"
              type="text"
              maxLength={100}
              value={form.serialNumber}
              onChange={(e) => set('serialNumber', e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
            />
          </div>
          <div>
            <label htmlFor="sub-eq-status" className="block text-sm font-medium text-gray-700">
              Status
            </label>
            <select
              id="sub-eq-status"
              value={form.status}
              onChange={(e) => set('status', e.target.value as EquipmentStatus)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="sub-eq-install" className="block text-sm font-medium text-gray-700">
            Installation date
          </label>
          <input
            id="sub-eq-install"
            type="date"
            value={form.installationDate}
            onChange={(e) => set('installationDate', e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
          />
        </div>

        <div>
          <label htmlFor="sub-eq-desc" className="block text-sm font-medium text-gray-700">
            Description
          </label>
          <textarea
            id="sub-eq-desc"
            rows={2}
            maxLength={1000}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
          />
        </div>

        <div>
          <label htmlFor="sub-eq-notes" className="block text-sm font-medium text-gray-700">
            Notes
          </label>
          <textarea
            id="sub-eq-notes"
            rows={2}
            maxLength={2000}
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
          />
        </div>

        {errors.length > 0 && (
          <div className="bg-orange-50 border border-orange-200 rounded-lg p-3">
            <ul className="list-disc list-inside text-sm text-orange-600 space-y-1">
              {errors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-4 border-t">
          <Button variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!isValid || submitting}
            className="bg-orange-600 hover:bg-orange-700"
          >
            {submitting
              ? 'Saving…'
              : mode === 'create'
                ? 'Create sub-equipment'
                : 'Save changes'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default SubEquipmentModal;
