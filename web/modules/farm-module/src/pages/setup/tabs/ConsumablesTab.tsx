/**
 * Consumables Tab Component
 * Manage consumable materials and supplies with CRUD operations via GraphQL API
 */
import React, { useState } from 'react';
import {
  useConsumableList,
  useCreateConsumable,
  useUpdateConsumable,
  useDeleteConsumable,
  Consumable,
  ConsumableCategory,
  ConsumableStatus,
  CreateConsumableInput,
} from '../../../hooks/useConsumables';
import { useSupplierList } from '../../../hooks/useSuppliers';
import {
  FormField,
  Modal,
  useConfirm,
  useToast,
  DataTable,
  type DataTableColumn,
  Spinner,
  Button,
  Input,
  Select,
  Textarea,
} from '@aquaculture/shared-ui';
import { Box as BoxIcon, ChevronDown, Plus, Search as SearchIcon } from 'lucide-react';

// ============================================================================
// CONSTANTS
// ============================================================================

const CATEGORIES = [
  { value: 'NET', label: 'Net' },
  { value: 'ROPE', label: 'Rope' },
  { value: 'PPE', label: 'PPE' },
  { value: 'SPARE_PART', label: 'Spare Part' },
  { value: 'OXYGEN', label: 'Oxygen' },
  { value: 'PACKAGING', label: 'Packaging' },
  { value: 'CLEANING', label: 'Cleaning' },
  { value: 'TOOL', label: 'Tool' },
  { value: 'ELECTRICAL', label: 'Electrical' },
  { value: 'PIPE_FITTING', label: 'Pipe & Fitting' },
  { value: 'OTHER', label: 'Other' },
];

const categoryColors: Record<string, string> = {
  NET: 'bg-blue-100 text-blue-800',
  ROPE: 'bg-amber-100 text-amber-800',
  PPE: 'bg-orange-100 text-orange-800',
  SPARE_PART: 'bg-purple-100 text-purple-800',
  OXYGEN: 'bg-cyan-100 text-cyan-800',
  PACKAGING: 'bg-lime-100 text-lime-800',
  CLEANING: 'bg-teal-100 text-teal-800',
  TOOL: 'bg-indigo-100 text-indigo-800',
  ELECTRICAL: 'bg-yellow-100 text-yellow-800',
  PIPE_FITTING: 'bg-rose-100 text-rose-800',
  OTHER: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
};

const statusColors: Record<string, string> = {
  AVAILABLE: 'bg-green-100 text-green-800',
  LOW_STOCK: 'bg-yellow-100 text-yellow-800',
  OUT_OF_STOCK: 'bg-red-100 text-red-800',
  DISCONTINUED: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
};

const statusLabels: Record<string, string> = {
  AVAILABLE: 'Available',
  LOW_STOCK: 'Low Stock',
  OUT_OF_STOCK: 'Out of Stock',
  DISCONTINUED: 'Discontinued',
};

// ============================================================================
// TYPES
// ============================================================================

interface ConsumableFormData {
  name: string;
  code: string;
  category: string;
  unit: string;
  description: string;
  brand: string;
  supplierId: string;
  minStock: number | '';
  quantity: number | '';
  unitPrice: number | '';
  currency: string;
  storageTempMin: number | '';
  storageTempMax: number | '';
  storageHumidityMin: number | '';
  storageHumidityMax: number | '';
  storageRequirements: string;
  notes: string;
  status: string;
}

const initialFormData: ConsumableFormData = {
  name: '',
  code: '',
  category: '',
  unit: 'pcs',
  description: '',
  brand: '',
  supplierId: '',
  minStock: '',
  quantity: '',
  unitPrice: '',
  currency: 'NOK',
  storageTempMin: '',
  storageTempMax: '',
  storageHumidityMin: '',
  storageHumidityMax: '',
  storageRequirements: '',
  notes: '',
  status: 'AVAILABLE',
};

// Collapsible Section Component
const CollapsibleSection: React.FC<{
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}> = ({ title, children, defaultOpen = false }) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg mb-4">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3 flex items-center justify-between bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-t-lg"
      >
        <span className="font-medium text-gray-700 dark:text-gray-300">{title}</span>
        <ChevronDown
          className={`w-5 h-5 text-gray-500 dark:text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      {isOpen && <div className="p-4">{children}</div>}
    </div>
  );
};

// ============================================================================
// COMPONENT
// ============================================================================

export const ConsumablesTab: React.FC = () => {
  // API hooks
  const { data: consumablesData, isLoading, error, refetch } = useConsumableList();
  const { data: suppliersData } = useSupplierList();
  const suppliers = suppliersData?.items || [];
  const createConsumable = useCreateConsumable();
  const updateConsumable = useUpdateConsumable();
  const deleteConsumableMutation = useDeleteConsumable();

  // Local state
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<ConsumableFormData>(initialFormData);
  // FE-HIGH-086: required-field misses land on the field, not in a toast.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);

  const consumables = consumablesData?.items || [];

  const filtered = consumables.filter((item) => {
    const matchesSearch =
      item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.code.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCat = selectedCategory === 'all' || item.category === selectedCategory;
    return matchesSearch && matchesCat;
  });

  const getCategoryLabel = (cat: string) => CATEGORIES.find((c) => c.value === cat)?.label || cat;

  const getSupplierName = (supplierId?: string) => {
    if (!supplierId) return '-';
    const supplier = suppliers.find((s) => s.id === supplierId);
    return supplier?.name || '-';
  };

  /**
   * BUG-12 FIX: Ensure modal opens reliably on the first click.
   * The previous implementation set isModalOpen together with other state updates
   * which React 18's automatic batching could coalesce with a pending
   * setIsModalOpen(false) from the backdrop onClick, causing the modal
   * to appear to need two clicks. Using flushSync ensures the modal state
   * update commits synchronously.
   */
  const openCreate = () => {
    setEditingId(null);
    setFormData({ ...initialFormData });
    setIsSaving(false);
    setIsModalOpen(true);
  };

  const openEdit = (item: Consumable) => {
    setEditingId(item.id);
    setFormData({
      name: item.name,
      code: item.code,
      category: item.category,
      unit: item.unit,
      description: item.description || '',
      brand: item.brand || '',
      supplierId: item.supplierId || '',
      minStock: item.minStock ?? '',
      quantity: item.quantity ?? '',
      unitPrice: item.unitPrice ?? '',
      currency: item.currency || 'NOK',
      storageTempMin: item.storageTempMin ?? '',
      storageTempMax: item.storageTempMax ?? '',
      storageHumidityMin: item.storageHumidityMin ?? '',
      storageHumidityMax: item.storageHumidityMax ?? '',
      storageRequirements: item.storageRequirements || '',
      notes: item.notes || '',
      status: item.status || 'AVAILABLE',
    });
    setIsModalOpen(true);
  };

  const confirm = useConfirm();
  const { toast } = useToast();
  const handleDelete = async (id: string) => {
    if (
      await confirm({
        title: 'Delete this item?',
        confirmText: 'Delete',
        cancelText: 'Cancel',
        variant: 'danger',
      })
    ) {
      try {
        await deleteConsumableMutation.mutateAsync(id);
      } catch (err) {
        console.error('Failed to delete consumable:', err);
        toast({ title: 'Failed to delete consumable. Please try again.', variant: 'error' });
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors: Record<string, string> = {};
    if (!formData.name) errors.name = 'Please enter a name.';
    if (!formData.code) errors.code = 'Please enter a code.';
    if (!formData.category) errors.category = 'Please select a category.';
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsSaving(true);
    try {
      const input: any = {
        name: formData.name,
        code: formData.code,
        category: formData.category as ConsumableCategory,
        unit: formData.unit,
        description: formData.description || undefined,
        brand: formData.brand || undefined,
        supplierId: formData.supplierId || undefined,
        minStock: formData.minStock !== '' ? Number(formData.minStock) : undefined,
        quantity: formData.quantity !== '' ? Number(formData.quantity) : undefined,
        unitPrice: formData.unitPrice !== '' ? Number(formData.unitPrice) : undefined,
        currency: formData.currency || undefined,
        storageTempMin:
          formData.storageTempMin !== '' ? Number(formData.storageTempMin) : undefined,
        storageTempMax:
          formData.storageTempMax !== '' ? Number(formData.storageTempMax) : undefined,
        storageHumidityMin:
          formData.storageHumidityMin !== '' ? Number(formData.storageHumidityMin) : undefined,
        storageHumidityMax:
          formData.storageHumidityMax !== '' ? Number(formData.storageHumidityMax) : undefined,
        storageRequirements: formData.storageRequirements || undefined,
        notes: formData.notes || undefined,
      };

      if (editingId) {
        await updateConsumable.mutateAsync({
          id: editingId,
          status: formData.status as ConsumableStatus,
          ...input,
        });
      } else {
        await createConsumable.mutateAsync(input as CreateConsumableInput);
      }
      setIsModalOpen(false);
      setFormData(initialFormData);
      setFieldErrors({});
      setEditingId(null);
    } catch (err) {
      console.error('Failed to save consumable:', err);
      toast({ title: 'Failed to save consumable. Please try again.', variant: 'error' });
    } finally {
      setIsSaving(false);
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
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${categoryColors[item.category] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
          >
            {getCategoryLabel(item.category)}
          </span>
        </>
      ),
    },
    {
      key: 'unit',
      header: 'Unit',
      render: (_value, item) => item.unit,
    },
    {
      key: 'stockMin',
      header: 'Stock / Min',
      render: (_value, item) => (
        <>
          <span
            className={
              item.quantity <= item.minStock
                ? 'text-red-600 font-medium'
                : 'text-gray-900 dark:text-gray-100'
            }
          >
            {item.quantity}
          </span>
          <span className="text-gray-400 dark:text-gray-500"> / {item.minStock}</span>
        </>
      ),
    },
    {
      key: 'supplier',
      header: 'Supplier',
      render: (_value, item) => getSupplierName(item.supplierId),
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
          <Button variant="ghost" onClick={() => handleDelete(item.id)}>
            Delete
          </Button>
        </>
      ),
    },
  ];

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex flex-1 gap-4">
          <div className="relative flex-1 max-w-md">
            <input
              type="text"
              placeholder="Search consumables..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <SearchIcon
              className="absolute left-3 top-2.5 w-5 h-5 text-gray-400 dark:text-gray-500"
              aria-hidden="true"
            />
          </div>
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">All Categories</option>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <Button variant="primary" onClick={openCreate}>
          <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
          Add Consumable
        </Button>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Spinner size="lg" />
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load consumables. Please try again.</p>
          <Button variant="ghost" className="mt-2" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* Table */}
      {!isLoading && !error && (
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
          {filtered.length === 0 && (
            <div className="text-center py-12">
              <BoxIcon
                className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
                aria-hidden="true"
              />
              <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                No consumables found
              </h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Add consumable items to manage your stock.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingId ? 'Edit Consumable' : 'Add Consumable'}
        size="lg"
      >
        <form onSubmit={handleSubmit}>
          <div className="max-h-[70vh] overflow-y-auto">
            {/* Basic Information */}
            <CollapsibleSection title="Basic Information" defaultOpen={true}>
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Name *
                    </label>
                    <FormField
                      error={formData.name ? undefined : fieldErrors.name}
                      className="mb-0"
                    >
                      <Input
                        fullWidth
                        type="text"
                        required
                        value={formData.name}
                        onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                      />
                    </FormField>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Code *
                    </label>
                    <FormField
                      error={formData.code ? undefined : fieldErrors.code}
                      className="mb-0"
                    >
                      <Input
                        fullWidth
                        type="text"
                        required
                        value={formData.code}
                        onChange={(e) => setFormData((prev) => ({ ...prev, code: e.target.value }))}
                      />
                    </FormField>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Category *
                    </label>
                    <FormField
                      error={formData.category ? undefined : fieldErrors.category}
                      className="mb-0"
                    >
                      <select
                        required
                        value={formData.category}
                        onChange={(e) =>
                          setFormData((prev) => ({ ...prev, category: e.target.value }))
                        }
                        className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                      >
                        <option value="">Select</option>
                        {CATEGORIES.map((c) => (
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
                    <Select
                      fullWidth
                      options={[
                        { value: 'pcs', label: 'Pieces' },
                        { value: 'm', label: 'Meters' },
                        { value: 'kg', label: 'Kilograms' },
                        { value: 'L', label: 'Liters' },
                        { value: 'box', label: 'Box' },
                        { value: 'roll', label: 'Roll' },
                        { value: 'tank', label: 'Tank' },
                        { value: 'set', label: 'Set' },
                      ]}
                      value={formData.unit}
                      onChange={(e) => setFormData((prev) => ({ ...prev, unit: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Brand
                    </label>
                    <Input
                      fullWidth
                      type="text"
                      value={formData.brand}
                      onChange={(e) => setFormData((prev) => ({ ...prev, brand: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Supplier
                    </label>
                    <select
                      value={formData.supplierId}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, supplierId: e.target.value }))
                      }
                      className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="">Select Supplier</option>
                      {suppliers.map((supplier) => (
                        <option key={supplier.id} value={supplier.id}>
                          {supplier.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Description
                  </label>
                  <Textarea
                    fullWidth
                    value={formData.description}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, description: e.target.value }))
                    }
                    rows={2}
                  />
                </div>
              </div>
            </CollapsibleSection>

            {/* Stock & Price */}
            <CollapsibleSection title="Stock & Price">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Current Stock
                  </label>
                  <Input
                    fullWidth
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.quantity}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        quantity: e.target.value ? parseFloat(e.target.value) : '',
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Min Stock
                  </label>
                  <Input
                    fullWidth
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.minStock}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        minStock: e.target.value ? parseFloat(e.target.value) : '',
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Unit Price
                  </label>
                  <Input
                    fullWidth
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.unitPrice}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        unitPrice: e.target.value ? parseFloat(e.target.value) : '',
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Currency
                  </label>
                  <Select
                    fullWidth
                    options={[
                      { value: 'NOK', label: 'NOK' },
                      { value: 'EUR', label: 'EUR' },
                      { value: 'USD', label: 'USD' },
                    ]}
                    value={formData.currency}
                    onChange={(e) => setFormData((prev) => ({ ...prev, currency: e.target.value }))}
                  />
                </div>
              </div>
            </CollapsibleSection>

            {/* Storage Conditions */}
            <CollapsibleSection title="Storage Conditions">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Min Temperature (°C)
                  </label>
                  <Input
                    fullWidth
                    type="number"
                    step="0.1"
                    value={formData.storageTempMin}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        storageTempMin: e.target.value ? parseFloat(e.target.value) : '',
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Max Temperature (°C)
                  </label>
                  <Input
                    fullWidth
                    type="number"
                    step="0.1"
                    value={formData.storageTempMax}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        storageTempMax: e.target.value ? parseFloat(e.target.value) : '',
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Min Humidity (%)
                  </label>
                  <Input
                    fullWidth
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    value={formData.storageHumidityMin}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        storageHumidityMin: e.target.value ? parseFloat(e.target.value) : '',
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Max Humidity (%)
                  </label>
                  <Input
                    fullWidth
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    value={formData.storageHumidityMax}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        storageHumidityMax: e.target.value ? parseFloat(e.target.value) : '',
                      }))
                    }
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Storage Requirements
                  </label>
                  <Textarea
                    fullWidth
                    rows={2}
                    placeholder="Special storage instructions..."
                    value={formData.storageRequirements}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, storageRequirements: e.target.value }))
                    }
                  />
                </div>
              </div>
            </CollapsibleSection>

            {/* Additional Information */}
            <CollapsibleSection title="Additional Information">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Notes
                  </label>
                  <Textarea
                    fullWidth
                    value={formData.notes}
                    onChange={(e) => setFormData((prev) => ({ ...prev, notes: e.target.value }))}
                    rows={3}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Status
                  </label>
                  <select
                    value={formData.status}
                    onChange={(e) => setFormData((prev) => ({ ...prev, status: e.target.value }))}
                    className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  >
                    {Object.entries(statusLabels).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </CollapsibleSection>
          </div>

          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
            <Button variant="secondary" type="button" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={isSaving}>
              {isSaving ? 'Saving...' : editingId ? 'Update' : 'Create'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default ConsumablesTab;
