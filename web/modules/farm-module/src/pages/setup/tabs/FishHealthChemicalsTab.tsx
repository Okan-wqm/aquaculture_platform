/**
 * Fish Health Chemicals Tab
 *
 * Therapeutic-substance setup, backed by the Chemical master (FARM-HIGH-003
 * Phase 4.2). This tab is a therapeutic-focused VIEW over the canonical
 * `chemicals` aggregate — create/edit/delete route through the Phase-3-compliant
 * Chemical resolver (tenant transaction + audit + outbox), NOT a client-side
 * mock. Therapeutic-only attributes (withdrawal period, target conditions,
 * prescription requirement) ride in the chemical's `usageProtocol`.
 */
import React, { useState } from 'react';
import { Modal, useToast } from '@aquaculture/shared-ui';

import {
  useChemicalList,
  useCreateChemical,
  useUpdateChemical,
  useDeleteChemical,
  Chemical,
  ChemicalType,
  ChemicalStatus,
  CreateChemicalInput,
  UpdateChemicalInput,
  UsageProtocol,
} from '../../../hooks/useChemicals';
import { useSupplierList, SupplierType } from '../../../hooks/useSuppliers';
import { useSiteList } from '../../../hooks/useSites';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * The therapeutic subset of ChemicalType surfaced by this tab. The Chemicals
 * tab shows every type; this tab is the therapeutic-substance view of the same
 * Chemical master. Values map 1:1 to the backend `chemicals_type_enum`
 * (antifungal/vaccine/wound_care were added in migration 1805900000000).
 */
const THERAPEUTIC_CATEGORIES: { value: ChemicalType; label: string }[] = [
  { value: ChemicalType.ANTIPARASITIC, label: 'Antiparasitic' },
  { value: ChemicalType.ANTIBIOTIC, label: 'Antibiotic' },
  { value: ChemicalType.ANTIFUNGAL, label: 'Antifungal' },
  { value: ChemicalType.VACCINE, label: 'Vaccine' },
  { value: ChemicalType.ANESTHETIC, label: 'Anesthetic' },
  { value: ChemicalType.DISINFECTANT, label: 'Disinfectant' },
  { value: ChemicalType.PROBIOTIC, label: 'Probiotic' },
  { value: ChemicalType.VITAMIN, label: 'Vitamin' },
  { value: ChemicalType.WOUND_CARE, label: 'Wound Care' },
  { value: ChemicalType.OTHER, label: 'Other' },
];

const THERAPEUTIC_TYPES = new Set<ChemicalType>(THERAPEUTIC_CATEGORIES.map((c) => c.value));

const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  THERAPEUTIC_CATEGORIES.map((c) => [c.value, c.label]),
);

const categoryColors: Record<string, string> = {
  [ChemicalType.ANTIPARASITIC]: 'bg-orange-100 text-orange-800',
  [ChemicalType.ANTIBIOTIC]: 'bg-red-100 text-red-800',
  [ChemicalType.ANTIFUNGAL]: 'bg-purple-100 text-purple-800',
  [ChemicalType.VACCINE]: 'bg-blue-100 text-blue-800',
  [ChemicalType.ANESTHETIC]: 'bg-pink-100 text-pink-800',
  [ChemicalType.DISINFECTANT]: 'bg-green-100 text-green-800',
  [ChemicalType.PROBIOTIC]: 'bg-indigo-100 text-indigo-800',
  [ChemicalType.VITAMIN]: 'bg-yellow-100 text-yellow-800',
  [ChemicalType.WOUND_CARE]: 'bg-rose-100 text-rose-800',
  [ChemicalType.OTHER]: 'bg-gray-100 text-gray-800',
};

const statusColors: Record<string, string> = {
  [ChemicalStatus.AVAILABLE]: 'bg-green-100 text-green-800',
  [ChemicalStatus.LOW_STOCK]: 'bg-yellow-100 text-yellow-800',
  [ChemicalStatus.OUT_OF_STOCK]: 'bg-red-100 text-red-800',
  [ChemicalStatus.EXPIRED]: 'bg-gray-100 text-gray-800',
  [ChemicalStatus.DISCONTINUED]: 'bg-gray-100 text-gray-800',
};

const statusLabels: Record<string, string> = {
  [ChemicalStatus.AVAILABLE]: 'Available',
  [ChemicalStatus.LOW_STOCK]: 'Low Stock',
  [ChemicalStatus.OUT_OF_STOCK]: 'Out of Stock',
  [ChemicalStatus.EXPIRED]: 'Expired',
  [ChemicalStatus.DISCONTINUED]: 'Discontinued',
};

const UNIT_OPTIONS = [
  { value: 'kg', label: 'Kilograms' },
  { value: 'L', label: 'Liters' },
  { value: 'ml', label: 'Milliliters' },
  { value: 'g', label: 'Grams' },
  { value: 'dose', label: 'Doses' },
  { value: 'pcs', label: 'Pieces' },
];

const FORMULATION_OPTIONS = [
  'Liquid',
  'Powder',
  'Premix',
  'Tablet',
  'Injectable',
  'Gel',
  'Emulsion',
];

const STORAGE_OPTIONS = [
  'Room temperature',
  'Cool & dry',
  'Cool & dry, below 25°C',
  'Refrigerated 2-8°C',
  'Room temperature, dark',
  'Hazmat storage',
];

// ============================================================================
// FORM STATE
// ============================================================================

interface FormData {
  name: string;
  code: string;
  type: ChemicalType | '';
  siteId: string;
  supplierId: string;
  activeIngredient: string;
  concentration: string;
  formulation: string;
  unit: string;
  withdrawalPeriodDays: number;
  prescriptionRequired: boolean;
  targetConditionsText: string;
  storageRequirements: string;
  status: ChemicalStatus;
}

const emptyForm: FormData = {
  name: '',
  code: '',
  type: '',
  siteId: '',
  supplierId: '',
  activeIngredient: '',
  concentration: '',
  formulation: '',
  unit: 'kg',
  withdrawalPeriodDays: 0,
  prescriptionRequired: false,
  targetConditionsText: '',
  storageRequirements: '',
  status: ChemicalStatus.AVAILABLE,
};

// ============================================================================
// COMPONENT
// ============================================================================

export const FishHealthChemicalsTab: React.FC = () => {
  const { toast } = useToast();

  const { data: chemicalsData, isLoading, error } = useChemicalList();
  const { data: suppliersData } = useSupplierList({ type: SupplierType.CHEMICAL });
  const { data: sitesData } = useSiteList();
  const createChemical = useCreateChemical();
  const updateChemical = useUpdateChemical();
  const deleteChemical = useDeleteChemical();

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<Chemical | null>(null);
  const [formData, setFormData] = useState<FormData>(emptyForm);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Chemical | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const suppliers = suppliersData?.items ?? [];
  const sites = sitesData?.items ?? [];

  // Therapeutic-substance view over the Chemical master.
  const items = (chemicalsData?.items ?? []).filter((c) => THERAPEUTIC_TYPES.has(c.type));

  const filtered = items.filter((item) => {
    const term = searchTerm.toLowerCase();
    const matchesSearch =
      item.name.toLowerCase().includes(term) ||
      item.code.toLowerCase().includes(term) ||
      (item.activeIngredient?.toLowerCase().includes(term) ?? false);
    const matchesCategory = selectedCategory === 'all' || item.type === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const getCategoryLabel = (type: string): string => CATEGORY_LABELS[type] ?? type;
  const getSiteName = (siteId?: string): string =>
    (siteId && sites.find((s) => s.id === siteId)?.name) || '-';

  const updateField = <K extends keyof FormData>(key: K, value: FormData[K]): void => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const openCreate = (): void => {
    setEditing(null);
    setFormData(emptyForm);
    setIsModalOpen(true);
  };

  const openEdit = (item: Chemical): void => {
    setEditing(item);
    setFormData({
      name: item.name,
      code: item.code,
      type: item.type,
      siteId: item.siteId ?? '',
      supplierId: item.supplierId ?? '',
      activeIngredient: item.activeIngredient ?? '',
      concentration: item.concentration ?? '',
      formulation: item.formulation ?? '',
      unit: item.unit || 'kg',
      withdrawalPeriodDays: item.usageProtocol?.withdrawalPeriod ?? 0,
      prescriptionRequired: item.usageProtocol?.prescriptionRequired ?? false,
      targetConditionsText: (item.usageProtocol?.targetConditions ?? []).join(', '),
      storageRequirements: item.storageRequirements ?? '',
      status: item.status,
    });
    setIsModalOpen(true);
  };

  const buildUsageProtocol = (): UsageProtocol | undefined => {
    const targetConditions = formData.targetConditionsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const usageProtocol: UsageProtocol = {
      prescriptionRequired: formData.prescriptionRequired,
    };
    if (formData.withdrawalPeriodDays > 0) {
      usageProtocol.withdrawalPeriod = formData.withdrawalPeriodDays;
    }
    if (targetConditions.length > 0) {
      usageProtocol.targetConditions = targetConditions;
    }
    return usageProtocol;
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!formData.name || !formData.code) {
      toast({
        title: 'Missing fields',
        description: 'Name and code are required.',
        variant: 'error',
      });
      return;
    }
    if (!formData.type) {
      toast({
        title: 'Missing fields',
        description: 'Please select a category.',
        variant: 'error',
      });
      return;
    }
    if (!editing && !formData.siteId) {
      toast({ title: 'Missing fields', description: 'Please select a site.', variant: 'error' });
      return;
    }

    setIsSaving(true);
    try {
      if (editing) {
        const input: UpdateChemicalInput = {
          id: editing.id,
          name: formData.name,
          code: formData.code,
          type: formData.type,
          unit: formData.unit,
          supplierId: formData.supplierId || undefined,
          activeIngredient: formData.activeIngredient || undefined,
          concentration: formData.concentration || undefined,
          formulation: formData.formulation || undefined,
          storageRequirements: formData.storageRequirements || undefined,
          usageProtocol: buildUsageProtocol(),
          status: formData.status,
        };
        await updateChemical.mutateAsync(input);
      } else {
        const input: CreateChemicalInput = {
          name: formData.name,
          code: formData.code,
          type: formData.type,
          siteId: formData.siteId,
          unit: formData.unit,
          supplierId: formData.supplierId || undefined,
          activeIngredient: formData.activeIngredient || undefined,
          concentration: formData.concentration || undefined,
          formulation: formData.formulation || undefined,
          storageRequirements: formData.storageRequirements || undefined,
          usageProtocol: buildUsageProtocol(),
        };
        await createChemical.mutateAsync(input);
      }
      toast({
        title: editing ? 'Substance updated' : 'Substance added',
        description: `${formData.name} was saved.`,
        variant: 'success',
      });
      setIsModalOpen(false);
      setEditing(null);
      setFormData(emptyForm);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isDuplicate =
        message.toLowerCase().includes('duplicate') ||
        message.toLowerCase().includes('already exists') ||
        message.includes('409');
      toast({
        title: isDuplicate ? 'Duplicate substance' : 'Error',
        description: isDuplicate
          ? 'A substance with this name or code already exists. Use a different name or code.'
          : 'Failed to save the therapeutic substance. Please try again.',
        variant: 'error',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteChemical.mutateAsync(deleteTarget.id);
      toast({
        title: 'Substance removed',
        description: `${deleteTarget.name} was deleted.`,
        variant: 'success',
      });
      setDeleteTarget(null);
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to delete the substance. Please try again.',
        variant: 'error',
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 sticky top-0 z-10 bg-white pb-4 -mt-4 pt-4">
        <div className="flex flex-1 gap-4">
          <div className="relative flex-1 max-w-md">
            <input
              type="text"
              placeholder="Search therapeutic substances..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <svg
              className="absolute left-3 top-2.5 w-5 h-5 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">All Categories</option>
            {THERAPEUTIC_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 6v6m0 0v6m0-6h6m-6 0H6"
            />
          </svg>
          Add Therapeutic Substance
        </button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Name / Code
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Category
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Active Ingredient
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Withdrawal
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Prescription
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {filtered.map((item) => (
              <tr key={item.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm font-medium text-gray-900">{item.name}</div>
                  <div className="text-sm text-gray-500">{item.code}</div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${categoryColors[item.type] || 'bg-gray-100 text-gray-800'}`}
                  >
                    {getCategoryLabel(item.type)}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                  {item.activeIngredient || '-'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                  {item.usageProtocol?.withdrawalPeriod
                    ? `${item.usageProtocol.withdrawalPeriod} days`
                    : '-'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${item.usageProtocol?.prescriptionRequired ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-gray-600'}`}
                  >
                    {item.usageProtocol?.prescriptionRequired ? 'Yes' : 'No'}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[item.status] || 'bg-gray-100 text-gray-800'}`}
                  >
                    {statusLabels[item.status] || item.status}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <button
                    onClick={() => openEdit(item)}
                    className="text-blue-600 hover:text-blue-900 mr-3"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setDeleteTarget(item)}
                    className="text-red-600 hover:text-red-900"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {isLoading && (
          <div className="text-center py-12 text-sm text-gray-500">
            Loading therapeutic substances…
          </div>
        )}

        {error && !isLoading && (
          <div className="text-center py-12 text-sm text-red-600">
            Failed to load therapeutic substances. Please retry.
          </div>
        )}

        {!isLoading && !error && filtered.length === 0 && (
          <div className="text-center py-12">
            <h3 className="mt-2 text-sm font-medium text-gray-900">
              No therapeutic substances found
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              Add therapeutic substances to manage treatments and protocols.
            </p>
          </div>
        )}
      </div>

      {/* Create / Edit modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editing ? 'Edit Therapeutic Substance' : 'Add Therapeutic Substance'}
        size="md"
      >
        <form onSubmit={handleSubmit}>
          <div className="max-h-[70vh] overflow-y-auto">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Name *</label>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={(e) => updateField('name', e.target.value)}
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Code *</label>
                  <input
                    type="text"
                    required
                    value={formData.code}
                    onChange={(e) => updateField('code', e.target.value)}
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Category *</label>
                  <select
                    required
                    value={formData.type}
                    onChange={(e) => updateField('type', e.target.value as ChemicalType)}
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Select</option>
                    {THERAPEUTIC_CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Unit</label>
                  <select
                    value={formData.unit}
                    onChange={(e) => updateField('unit', e.target.value)}
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  >
                    {UNIT_OPTIONS.map((u) => (
                      <option key={u.value} value={u.value}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Site {editing ? '' : '*'}
                  </label>
                  {editing ? (
                    <input
                      type="text"
                      disabled
                      value={getSiteName(formData.siteId)}
                      className="mt-1 block w-full border border-gray-200 bg-gray-50 rounded-md py-2 px-3 text-gray-500"
                    />
                  ) : (
                    <select
                      required
                      value={formData.siteId}
                      onChange={(e) => updateField('siteId', e.target.value)}
                      className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="">Select site</option>
                      {sites.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Supplier</label>
                  <select
                    value={formData.supplierId}
                    onChange={(e) => updateField('supplierId', e.target.value)}
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Select supplier</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Composition */}
              <div className="border-t pt-4 mt-4">
                <h4 className="text-sm font-medium text-gray-700 mb-3">Composition</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Active Ingredient
                    </label>
                    <input
                      type="text"
                      value={formData.activeIngredient}
                      onChange={(e) => updateField('activeIngredient', e.target.value)}
                      className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Concentration</label>
                    <input
                      type="text"
                      value={formData.concentration}
                      onChange={(e) => updateField('concentration', e.target.value)}
                      placeholder="e.g., 10%, 50mg/L"
                      className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700">Formulation</label>
                  <select
                    value={formData.formulation}
                    onChange={(e) => updateField('formulation', e.target.value)}
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Select</option>
                    {FORMULATION_OPTIONS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Regulation */}
              <div className="border-t pt-4 mt-4">
                <h4 className="text-sm font-medium text-gray-700 mb-3">Regulation</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Withdrawal Period (days)
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={formData.withdrawalPeriodDays}
                      onChange={(e) =>
                        updateField('withdrawalPeriodDays', parseInt(e.target.value, 10) || 0)
                      }
                      className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                  <div className="flex items-end pb-1">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={formData.prescriptionRequired}
                        onChange={(e) => updateField('prescriptionRequired', e.target.checked)}
                        className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                      />
                      <span className="text-sm font-medium text-gray-700">
                        Prescription Required
                      </span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Target conditions */}
              <div className="border-t pt-4 mt-4">
                <h4 className="text-sm font-medium text-gray-700 mb-3">Target Conditions</h4>
                <input
                  type="text"
                  value={formData.targetConditionsText}
                  onChange={(e) => updateField('targetConditionsText', e.target.value)}
                  placeholder="Comma separated, e.g.: Sea lice, Furunculosis"
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              {/* Storage & status */}
              <div className="border-t pt-4 mt-4">
                <h4 className="text-sm font-medium text-gray-700 mb-3">Storage &amp; Status</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Storage Requirements
                    </label>
                    <select
                      value={formData.storageRequirements}
                      onChange={(e) => updateField('storageRequirements', e.target.value)}
                      className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="">Select</option>
                      {STORAGE_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                  {editing && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Status</label>
                      <select
                        value={formData.status}
                        onChange={(e) => updateField('status', e.target.value as ChemicalStatus)}
                        className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                      >
                        {Object.entries(statusLabels).map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-gray-200 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
            >
              {isSaving ? 'Saving…' : editing ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation modal (replaces browser confirm) */}
      <Modal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete Therapeutic Substance"
        size="sm"
      >
        <p className="text-sm text-gray-700">
          Are you sure you want to delete <span className="font-medium">{deleteTarget?.name}</span>?
          This removes the substance from the Chemical master.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={() => setDeleteTarget(null)}
            className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirmDelete()}
            disabled={isDeleting}
            className="px-4 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 disabled:opacity-60"
          >
            {isDeleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </Modal>
    </div>
  );
};

export default FishHealthChemicalsTab;
