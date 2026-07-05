/**
 * Fish Health Chemicals Tab Component
 * Manage fish health chemicals and treatments with CRUD operations (mock data)
 */
import React, { useState } from 'react';
import { Modal } from '@aquaculture/shared-ui';

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

interface FishHealthItem {
  id: string;
  name: string;
  code: string;
  category: string;
  activeIngredient: string;
  concentration: string;
  formulation: string;
  unit: string;
  supplierName: string;
  withdrawalPeriodDays: number;
  prescriptionRequired: boolean;
  targetConditions: string[];
  storageRequirements: string;
  status: string;
  isActive: boolean;
}

const CATEGORIES = [
  { value: 'ANTIPARASITIC', label: 'Antiparasitic' },
  { value: 'ANTIBIOTIC', label: 'Antibiotic' },
  { value: 'ANTIFUNGAL', label: 'Antifungal' },
  { value: 'VACCINE', label: 'Vaccine' },
  { value: 'ANESTHETIC', label: 'Anesthetic' },
  { value: 'DISINFECTANT', label: 'Disinfectant' },
  { value: 'PROBIOTIC', label: 'Probiotic' },
  { value: 'VITAMIN', label: 'Vitamin' },
  { value: 'WOUND_CARE', label: 'Wound Care' },
  { value: 'OTHER', label: 'Other' },
];

const categoryColors: Record<string, string> = {
  ANTIPARASITIC: 'bg-orange-100 text-orange-800',
  ANTIBIOTIC: 'bg-red-100 text-red-800',
  ANTIFUNGAL: 'bg-purple-100 text-purple-800',
  VACCINE: 'bg-blue-100 text-blue-800',
  ANESTHETIC: 'bg-pink-100 text-pink-800',
  DISINFECTANT: 'bg-green-100 text-green-800',
  PROBIOTIC: 'bg-indigo-100 text-indigo-800',
  VITAMIN: 'bg-yellow-100 text-yellow-800',
  WOUND_CARE: 'bg-rose-100 text-rose-800',
  OTHER: 'bg-gray-100 text-gray-800',
};

const statusColors: Record<string, string> = {
  AVAILABLE: 'bg-green-100 text-green-800',
  LOW_STOCK: 'bg-yellow-100 text-yellow-800',
  OUT_OF_STOCK: 'bg-red-100 text-red-800',
  EXPIRED: 'bg-gray-100 text-gray-800',
};

const statusLabels: Record<string, string> = {
  AVAILABLE: 'Available',
  LOW_STOCK: 'Low Stock',
  OUT_OF_STOCK: 'Out of Stock',
  EXPIRED: 'Expired',
};

const INITIAL_DATA: FishHealthItem[] = [
  {
    id: '1',
    name: 'SLICE Premix',
    code: 'FH-001',
    category: 'ANTIPARASITIC',
    activeIngredient: 'Emamectin Benzoate',
    concentration: '0.2%',
    formulation: 'Premix',
    unit: 'kg',
    supplierName: 'MSD Animal Health',
    withdrawalPeriodDays: 175,
    prescriptionRequired: true,
    targetConditions: ['Sea lice'],
    storageRequirements: 'Cool & dry, below 25°C',
    status: 'AVAILABLE',
    isActive: true,
  },
  {
    id: '2',
    name: 'Alphamax',
    code: 'FH-002',
    category: 'ANTIPARASITIC',
    activeIngredient: 'Deltamethrin',
    concentration: '10 mg/ml',
    formulation: 'Liquid',
    unit: 'L',
    supplierName: 'PHARMAQ',
    withdrawalPeriodDays: 7,
    prescriptionRequired: true,
    targetConditions: ['Sea lice'],
    storageRequirements: 'Room temperature',
    status: 'AVAILABLE',
    isActive: true,
  },
  {
    id: '3',
    name: 'Aqui-S',
    code: 'FH-003',
    category: 'ANESTHETIC',
    activeIngredient: 'Isoeugenol',
    concentration: '50%',
    formulation: 'Liquid',
    unit: 'L',
    supplierName: 'Aqui-S NZ',
    withdrawalPeriodDays: 1,
    prescriptionRequired: false,
    targetConditions: ['Sedation', 'Anesthesia'],
    storageRequirements: 'Room temperature, dark',
    status: 'AVAILABLE',
    isActive: true,
  },
  {
    id: '4',
    name: 'Oxytetracycline 20%',
    code: 'FH-004',
    category: 'ANTIBIOTIC',
    activeIngredient: 'OTC',
    concentration: '200 mg/g',
    formulation: 'Powder',
    unit: 'kg',
    supplierName: 'PHARMAQ',
    withdrawalPeriodDays: 80,
    prescriptionRequired: true,
    targetConditions: ['Furunculosis', 'Vibriosis'],
    storageRequirements: 'Cool & dry',
    status: 'AVAILABLE',
    isActive: true,
  },
  {
    id: '5',
    name: 'PHARMAQ Alpha Ject',
    code: 'FH-005',
    category: 'VACCINE',
    activeIngredient: 'Inactivated A. salmonicida',
    concentration: 'Standard',
    formulation: 'Injectable',
    unit: 'dose',
    supplierName: 'PHARMAQ',
    withdrawalPeriodDays: 450,
    prescriptionRequired: true,
    targetConditions: ['Furunculosis'],
    storageRequirements: 'Refrigerated 2-8°C',
    status: 'AVAILABLE',
    isActive: true,
  },
  {
    id: '6',
    name: 'Bronopol 50%',
    code: 'FH-006',
    category: 'ANTIFUNGAL',
    activeIngredient: 'Bronopol',
    concentration: '50%',
    formulation: 'Liquid',
    unit: 'L',
    supplierName: 'Novartis',
    withdrawalPeriodDays: 0,
    prescriptionRequired: false,
    targetConditions: ['Saprolegnia'],
    storageRequirements: 'Room temperature',
    status: 'AVAILABLE',
    isActive: true,
  },
];

type FormData = Omit<FishHealthItem, 'id'> & { targetConditionsText: string };

const emptyForm: FormData = {
  name: '',
  code: '',
  category: '',
  activeIngredient: '',
  concentration: '',
  formulation: '',
  unit: 'kg',
  supplierName: '',
  withdrawalPeriodDays: 0,
  prescriptionRequired: false,
  targetConditions: [],
  targetConditionsText: '',
  storageRequirements: '',
  status: 'AVAILABLE',
  isActive: true,
};

// ============================================================================
// COMPONENT
// ============================================================================

export const FishHealthChemicalsTab: React.FC = () => {
  const [items, setItems] = useState<FishHealthItem[]>(INITIAL_DATA);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<FormData>(emptyForm);

  const filtered = items.filter((item) => {
    const matchesSearch =
      item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.activeIngredient.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCat = selectedCategory === 'all' || item.category === selectedCategory;
    return matchesSearch && matchesCat;
  });

  const getCategoryLabel = (cat: string) => CATEGORIES.find((c) => c.value === cat)?.label || cat;

  const openCreate = () => {
    setEditingId(null);
    setFormData(emptyForm);
    setIsModalOpen(true);
  };

  const openEdit = (item: FishHealthItem) => {
    setEditingId(item.id);
    const { id, ...rest } = item;
    setFormData({ ...rest, targetConditionsText: rest.targetConditions.join(', ') });
    setIsModalOpen(true);
  };

  const handleDelete = (id: string) => {
    if (confirm('Are you sure you want to delete this therapeutic substance?')) {
      setItems((prev) => prev.filter((i) => i.id !== id));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.code) {
      alert('Name and code are required.');
      return;
    }

    const targetConditions = formData.targetConditionsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const { targetConditionsText, ...rest } = formData;
    const itemData = { ...rest, targetConditions };

    if (editingId) {
      setItems((prev) =>
        prev.map((i) => (i.id === editingId ? { ...itemData, id: editingId } : i)),
      );
    } else {
      setItems((prev) => [...prev, { ...itemData, id: Date.now().toString() }]);
    }
    setIsModalOpen(false);
  };

  const updateField = <K extends keyof FormData>(key: K, value: FormData[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div>
      {/* BUG-13 FIX: Sticky toolbar keeps the Add button visible when scrolling long tables */}
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
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${categoryColors[item.category] || 'bg-gray-100 text-gray-800'}`}
                  >
                    {getCategoryLabel(item.category)}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                  {item.activeIngredient}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                  {item.withdrawalPeriodDays > 0 ? `${item.withdrawalPeriodDays} days` : '-'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${item.prescriptionRequired ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-gray-600'}`}
                  >
                    {item.prescriptionRequired ? 'Yes' : 'No'}
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
                d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"
              />
            </svg>
            <h3 className="mt-2 text-sm font-medium text-gray-900">
              No therapeutic substances found
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              Add therapeutic substances to manage treatments and protocols.
            </p>
          </div>
        )}
      </div>

      {/* Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingId ? 'Edit Therapeutic Substance' : 'Add Therapeutic Substance'}
        size="md"
      >
        <form onSubmit={handleSubmit}>
          <div className="max-h-[70vh] overflow-y-auto">
            <div className="space-y-4">
              {/* Basic Info */}
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
                    value={formData.category}
                    onChange={(e) => updateField('category', e.target.value)}
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
                    onChange={(e) => updateField('unit', e.target.value)}
                    className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="kg">Kilograms</option>
                    <option value="L">Liters</option>
                    <option value="ml">Milliliters</option>
                    <option value="g">Grams</option>
                    <option value="dose">Doses</option>
                    <option value="pcs">Pieces</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Supplier</label>
                <input
                  type="text"
                  value={formData.supplierName}
                  onChange={(e) => updateField('supplierName', e.target.value)}
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                />
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
                    <option value="Liquid">Liquid</option>
                    <option value="Powder">Powder</option>
                    <option value="Premix">Premix</option>
                    <option value="Tablet">Tablet</option>
                    <option value="Injectable">Injectable</option>
                    <option value="Gel">Gel</option>
                    <option value="Emulsion">Emulsion</option>
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
                        updateField('withdrawalPeriodDays', parseInt(e.target.value) || 0)
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

              {/* Target Conditions */}
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

              {/* Storage & Safety */}
              <div className="border-t pt-4 mt-4">
                <h4 className="text-sm font-medium text-gray-700 mb-3">Storage & Safety</h4>
                <select
                  value={formData.storageRequirements}
                  onChange={(e) => updateField('storageRequirements', e.target.value)}
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="">Select</option>
                  <option value="Room temperature">Room Temperature</option>
                  <option value="Cool & dry">Cool & Dry</option>
                  <option value="Cool & dry, below 25°C">Cool & Dry, below 25°C</option>
                  <option value="Refrigerated 2-8°C">Refrigerated 2-8°C</option>
                  <option value="Room temperature, dark">Room Temperature, Dark</option>
                  <option value="Hazmat storage">Hazmat Storage</option>
                </select>
              </div>

              {/* Status */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Status</label>
                <select
                  value={formData.status}
                  onChange={(e) => updateField('status', e.target.value)}
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
              className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
            >
              {editingId ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default FishHealthChemicalsTab;
