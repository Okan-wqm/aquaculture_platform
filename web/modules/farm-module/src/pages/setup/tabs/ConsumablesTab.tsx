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
import { Modal } from '@aquaculture/shared-ui';

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
  OTHER: 'bg-gray-100 text-gray-800',
};

const statusColors: Record<string, string> = {
  AVAILABLE: 'bg-green-100 text-green-800',
  LOW_STOCK: 'bg-yellow-100 text-yellow-800',
  OUT_OF_STOCK: 'bg-red-100 text-red-800',
  DISCONTINUED: 'bg-gray-100 text-gray-800',
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
    <div className="border border-gray-200 rounded-lg mb-4">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3 flex items-center justify-between bg-gray-50 hover:bg-gray-100 rounded-t-lg"
      >
        <span className="font-medium text-gray-700">{title}</span>
        <svg
          className={`w-5 h-5 text-gray-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
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

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to delete this item?')) {
      try {
        await deleteConsumableMutation.mutateAsync(id);
      } catch (err) {
        console.error('Failed to delete consumable:', err);
        alert('Failed to delete consumable. Please try again.');
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.code || !formData.category) {
      alert('Name, code, and category are required.');
      return;
    }

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
      setEditingId(null);
    } catch (err) {
      console.error('Failed to save consumable:', err);
      alert('Failed to save consumable. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

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
            {CATEGORIES.map((c) => (
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
          Add Consumable
        </button>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load consumables. Please try again.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">
            Retry
          </button>
        </div>
      )}

      {/* Table */}
      {!isLoading && !error && (
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
                  Unit
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Stock / Min
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Supplier
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
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${categoryColors[item.category] || 'bg-gray-100 text-gray-800'}`}
                    >
                      {getCategoryLabel(item.category)}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{item.unit}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    <span
                      className={
                        item.quantity <= item.minStock
                          ? 'text-red-600 font-medium'
                          : 'text-gray-900'
                      }
                    >
                      {item.quantity}
                    </span>
                    <span className="text-gray-400"> / {item.minStock}</span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {getSupplierName(item.supplierId)}
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
                      onClick={() => handleDelete(item.id)}
                      className="text-red-600 hover:text-red-900"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="text-center py-12">
              <svg
                className="mx-auto h-12 w-12 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                />
              </svg>
              <h3 className="mt-2 text-sm font-medium text-gray-900">No consumables found</h3>
              <p className="mt-1 text-sm text-gray-500">
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
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Name *</label>
                    <input
                      type="text"
                      required
                      value={formData.name}
                      onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                      className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Code *</label>
                    <input
                      type="text"
                      required
                      value={formData.code}
                      onChange={(e) => setFormData((prev) => ({ ...prev, code: e.target.value }))}
                      className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Category *</label>
                    <select
                      required
                      value={formData.category}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, category: e.target.value }))
                      }
                      className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="">Select</option>
                      {CATEGORIES.map((c) => (
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
                      onChange={(e) => setFormData((prev) => ({ ...prev, unit: e.target.value }))}
                      className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="pcs">Pieces</option>
                      <option value="m">Meters</option>
                      <option value="kg">Kilograms</option>
                      <option value="L">Liters</option>
                      <option value="box">Box</option>
                      <option value="roll">Roll</option>
                      <option value="tank">Tank</option>
                      <option value="set">Set</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Brand</label>
                    <input
                      type="text"
                      value={formData.brand}
                      onChange={(e) => setFormData((prev) => ({ ...prev, brand: e.target.value }))}
                      className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Supplier</label>
                    <select
                      value={formData.supplierId}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, supplierId: e.target.value }))
                      }
                      className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
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
                  <label className="block text-sm font-medium text-gray-700">Description</label>
                  <textarea
                    value={formData.description}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, description: e.target.value }))
                    }
                    rows={2}
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>
            </CollapsibleSection>

            {/* Stock & Price */}
            <CollapsibleSection title="Stock & Price">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Current Stock</label>
                  <input
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
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Min Stock</label>
                  <input
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
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Unit Price</label>
                  <input
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
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Currency</label>
                  <select
                    value={formData.currency}
                    onChange={(e) => setFormData((prev) => ({ ...prev, currency: e.target.value }))}
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="NOK">NOK</option>
                    <option value="EUR">EUR</option>
                    <option value="USD">USD</option>
                  </select>
                </div>
              </div>
            </CollapsibleSection>

            {/* Storage Conditions */}
            <CollapsibleSection title="Storage Conditions">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Min Temperature (°C)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.storageTempMin}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        storageTempMin: e.target.value ? parseFloat(e.target.value) : '',
                      }))
                    }
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Max Temperature (°C)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.storageTempMax}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        storageTempMax: e.target.value ? parseFloat(e.target.value) : '',
                      }))
                    }
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Min Humidity (%)
                  </label>
                  <input
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
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Max Humidity (%)
                  </label>
                  <input
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
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Storage Requirements
                  </label>
                  <textarea
                    rows={2}
                    placeholder="Special storage instructions..."
                    value={formData.storageRequirements}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, storageRequirements: e.target.value }))
                    }
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>
            </CollapsibleSection>

            {/* Additional Information */}
            <CollapsibleSection title="Additional Information">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Notes</label>
                  <textarea
                    value={formData.notes}
                    onChange={(e) => setFormData((prev) => ({ ...prev, notes: e.target.value }))}
                    rows={3}
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Status</label>
                  <select
                    value={formData.status}
                    onChange={(e) => setFormData((prev) => ({ ...prev, status: e.target.value }))}
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
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
              className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:bg-gray-400"
            >
              {isSaving ? 'Saving...' : editingId ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default ConsumablesTab;
