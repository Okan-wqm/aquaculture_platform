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
import {
  FormField,
  Modal,
  useToast,
  DataTable,
  type DataTableColumn,
  Button,
  Input,
} from '@aquaculture/shared-ui';

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
import { Plus, Search as SearchIcon } from 'lucide-react';

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
  [ChemicalType.ANTIPARASITIC]:
    'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  [ChemicalType.ANTIBIOTIC]: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
  [ChemicalType.ANTIFUNGAL]:
    'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  [ChemicalType.VACCINE]: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  [ChemicalType.ANESTHETIC]:
    'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  [ChemicalType.DISINFECTANT]:
    'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  [ChemicalType.PROBIOTIC]:
    'bg-primary-100 dark:bg-primary-900/40 text-primary-800 dark:text-primary-200',
  [ChemicalType.VITAMIN]:
    'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  [ChemicalType.WOUND_CARE]: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
  [ChemicalType.OTHER]: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
};

const statusColors: Record<string, string> = {
  [ChemicalStatus.AVAILABLE]:
    'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  [ChemicalStatus.LOW_STOCK]:
    'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  [ChemicalStatus.OUT_OF_STOCK]:
    'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
  [ChemicalStatus.EXPIRED]: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  [ChemicalStatus.DISCONTINUED]: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
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
  // FE-HIGH-086: required-field misses land on the field, not in a toast.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
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
    setFieldErrors({});
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
    const errors: Record<string, string> = {};
    // `type` is read into a const so the empty-string check below narrows it
    // to ChemicalType for the input objects.
    const { type } = formData;
    if (!formData.name) errors.name = 'Please enter a name.';
    if (!formData.code) errors.code = 'Please enter a code.';
    if (!type) errors.type = 'Please select a category.';
    if (!editing && !formData.siteId) errors.siteId = 'Please select a site.';
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0 || !type) return;

    setIsSaving(true);
    try {
      if (editing) {
        const input: UpdateChemicalInput = {
          id: editing.id,
          name: formData.name,
          code: formData.code,
          type,
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
          type,
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
      setFieldErrors({});
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

  type ItemRow = (typeof filtered)[number];
  const itemRowColumns: DataTableColumn<ItemRow>[] = [
    {
      key: 'nameCode',
      header: 'Name / Code',
      render: (_value, item) => (
        <>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{item.name}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{item.code}</div>
        </>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      render: (_value, item) => (
        <>
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${categoryColors[item.type] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
          >
            {getCategoryLabel(item.type)}
          </span>
        </>
      ),
    },
    {
      key: 'activeIngredient',
      header: 'Active Ingredient',
      render: (_value, item) => item.activeIngredient || '-',
    },
    {
      key: 'withdrawal',
      header: 'Withdrawal',
      render: (_value, item) => (
        <>
          {item.usageProtocol?.withdrawalPeriod
            ? `${item.usageProtocol.withdrawalPeriod} days`
            : '-'}
        </>
      ),
    },
    {
      key: 'prescription',
      header: 'Prescription',
      render: (_value, item) => (
        <>
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${item.usageProtocol?.prescriptionRequired ? 'bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-300' : 'bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}
          >
            {item.usageProtocol?.prescriptionRequired ? 'Yes' : 'No'}
          </span>
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, item) => (
        <>
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[item.status] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
          >
            {statusLabels[item.status] || item.status}
          </span>
        </>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, item) => (
        <>
          <Button variant="ghost" className="mr-3" onClick={() => openEdit(item)}>
            Edit
          </Button>
          <Button variant="ghost" onClick={() => setDeleteTarget(item)}>
            Delete
          </Button>
        </>
      ),
    },
  ];

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 sticky top-0 z-10 bg-white dark:bg-gray-900 pb-4 -mt-4 pt-4">
        <div className="flex flex-1 gap-4">
          <div className="relative flex-1 max-w-md">
            <input
              type="text"
              placeholder="Search therapeutic substances..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-transparent"
            />
            <SearchIcon
              className="absolute left-3 top-2.5 w-5 h-5 text-gray-400 dark:text-gray-500"
              aria-hidden="true"
            />
          </div>
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-transparent"
          >
            <option value="all">All Categories</option>
            {THERAPEUTIC_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <Button variant="primary" onClick={openCreate}>
          <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
          Add Therapeutic Substance
        </Button>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        <DataTable<ItemRow>
          data={filtered}
          columns={itemRowColumns}
          keyExtractor={(item) => item.id}
          emptyMessage="No records found"
          searchable={false}
          sortable={false}
          stickyHeader={false}
        />

        {isLoading && (
          <div className="text-center py-12 text-sm text-gray-500 dark:text-gray-400">
            Loading therapeutic substances…
          </div>
        )}

        {error && !isLoading && (
          <div className="text-center py-12 text-sm text-error-600 dark:text-error-400">
            Failed to load therapeutic substances. Please retry.
          </div>
        )}

        {!isLoading && !error && filtered.length === 0 && (
          <div className="text-center py-12">
            <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
              No therapeutic substances found
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Name *
                  </label>
                  <FormField error={formData.name ? undefined : fieldErrors.name} className="mb-0">
                    <Input
                      fullWidth
                      type="text"
                      required
                      value={formData.name}
                      onChange={(e) => updateField('name', e.target.value)}
                    />
                  </FormField>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Code *
                  </label>
                  <FormField error={formData.code ? undefined : fieldErrors.code} className="mb-0">
                    <Input
                      fullWidth
                      type="text"
                      required
                      value={formData.code}
                      onChange={(e) => updateField('code', e.target.value)}
                    />
                  </FormField>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Category *
                  </label>
                  <FormField error={formData.type ? undefined : fieldErrors.type} className="mb-0">
                    <select
                      required
                      value={formData.type}
                      onChange={(e) => updateField('type', e.target.value as ChemicalType)}
                      className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-info-500 focus:border-info-500"
                    >
                      <option value="">Select</option>
                      {THERAPEUTIC_CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </FormField>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Unit
                  </label>
                  <select
                    value={formData.unit}
                    onChange={(e) => updateField('unit', e.target.value)}
                    className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-info-500 focus:border-info-500"
                  >
                    {UNIT_OPTIONS.map((u) => (
                      <option key={u.value} value={u.value}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Site {editing ? '' : '*'}
                  </label>
                  {editing ? (
                    <Input fullWidth type="text" disabled value={getSiteName(formData.siteId)} />
                  ) : (
                    <FormField
                      error={formData.siteId ? undefined : fieldErrors.siteId}
                      className="mb-0"
                    >
                      <select
                        required
                        value={formData.siteId}
                        onChange={(e) => updateField('siteId', e.target.value)}
                        className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-info-500 focus:border-info-500"
                      >
                        <option value="">Select site</option>
                        {sites.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </FormField>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Supplier
                  </label>
                  <select
                    value={formData.supplierId}
                    onChange={(e) => updateField('supplierId', e.target.value)}
                    className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-info-500 focus:border-info-500"
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
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                  Composition
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Active Ingredient
                    </label>
                    <Input
                      fullWidth
                      type="text"
                      value={formData.activeIngredient}
                      onChange={(e) => updateField('activeIngredient', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Concentration
                    </label>
                    <Input
                      fullWidth
                      type="text"
                      value={formData.concentration}
                      onChange={(e) => updateField('concentration', e.target.value)}
                      placeholder="e.g., 10%, 50mg/L"
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Formulation
                  </label>
                  <select
                    value={formData.formulation}
                    onChange={(e) => updateField('formulation', e.target.value)}
                    className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-info-500 focus:border-info-500"
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
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                  Regulation
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Withdrawal Period (days)
                    </label>
                    <Input
                      fullWidth
                      type="number"
                      min="0"
                      value={formData.withdrawalPeriodDays}
                      onChange={(e) =>
                        updateField('withdrawalPeriodDays', parseInt(e.target.value, 10) || 0)
                      }
                    />
                  </div>
                  <div className="flex items-end pb-1">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={formData.prescriptionRequired}
                        onChange={(e) => updateField('prescriptionRequired', e.target.checked)}
                        className="h-4 w-4 text-info-600 focus:ring-info-500 border-gray-300 dark:border-gray-600 rounded"
                      />
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        Prescription Required
                      </span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Target conditions */}
              <div className="border-t pt-4 mt-4">
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                  Target Conditions
                </h4>
                <Input
                  fullWidth
                  type="text"
                  value={formData.targetConditionsText}
                  onChange={(e) => updateField('targetConditionsText', e.target.value)}
                  placeholder="Comma separated, e.g.: Sea lice, Furunculosis"
                />
              </div>

              {/* Storage & status */}
              <div className="border-t pt-4 mt-4">
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                  Storage &amp; Status
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Storage Requirements
                    </label>
                    <select
                      value={formData.storageRequirements}
                      onChange={(e) => updateField('storageRequirements', e.target.value)}
                      className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-info-500 focus:border-info-500"
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
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Status
                      </label>
                      <select
                        value={formData.status}
                        onChange={(e) => updateField('status', e.target.value as ChemicalStatus)}
                        className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-info-500 focus:border-info-500"
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

          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
            <Button variant="secondary" type="button" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={isSaving}>
              {isSaving ? 'Saving…' : editing ? 'Update' : 'Create'}
            </Button>
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
        <p className="text-sm text-gray-700 dark:text-gray-300">
          Are you sure you want to delete <span className="font-medium">{deleteTarget?.name}</span>?
          This removes the substance from the Chemical master.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" type="button" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            type="button"
            onClick={() => void confirmDelete()}
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </Modal>
    </div>
  );
};

export default FishHealthChemicalsTab;
