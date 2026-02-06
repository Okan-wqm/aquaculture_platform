/**
 * Consumables Tab Component
 * Manage consumable materials and supplies with CRUD operations (mock data)
 */
import React, { useState } from 'react';

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

interface ConsumableItem {
  id: string;
  name: string;
  code: string;
  category: string;
  unit: string;
  description: string;
  supplierName: string;
  minStock: number;
  currentStock: number;
  unitPrice: number;
  currency: string;
  status: string;
  isActive: boolean;
}

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
};

const statusLabels: Record<string, string> = {
  AVAILABLE: 'Available',
  LOW_STOCK: 'Low Stock',
  OUT_OF_STOCK: 'Out of Stock',
};

const INITIAL_DATA: ConsumableItem[] = [
  { id: '1', name: 'Predator Net 20mm', code: 'NET-001', category: 'NET', unit: 'pcs', description: 'Anti-predator net, 20mm mesh', supplierName: 'AquaNet AS', minStock: 5, currentStock: 8, unitPrice: 12500, currency: 'NOK', status: 'AVAILABLE', isActive: true },
  { id: '2', name: 'PE Rope 16mm', code: 'ROPE-001', category: 'ROPE', unit: 'm', description: 'UV-resistant PE rope', supplierName: 'NorRope', minStock: 500, currentStock: 1200, unitPrice: 45, currency: 'NOK', status: 'AVAILABLE', isActive: true },
  { id: '3', name: 'Nitrile Gloves (L)', code: 'PPE-001', category: 'PPE', unit: 'box', description: 'Disposable nitrile gloves, Large', supplierName: 'SafeWork AS', minStock: 100, currentStock: 45, unitPrice: 89, currency: 'NOK', status: 'LOW_STOCK', isActive: true },
  { id: '4', name: 'Pump Impeller Kit', code: 'SP-001', category: 'SPARE_PART', unit: 'pcs', description: 'Replacement impeller for main pump', supplierName: 'PumpTech', minStock: 3, currentStock: 5, unitPrice: 4500, currency: 'NOK', status: 'AVAILABLE', isActive: true },
  { id: '5', name: 'Net Repair Kit', code: 'TOOL-001', category: 'TOOL', unit: 'pcs', description: 'Complete net repair toolkit', supplierName: 'AquaNet AS', minStock: 5, currentStock: 2, unitPrice: 890, currency: 'NOK', status: 'LOW_STOCK', isActive: true },
];

const emptyForm: Omit<ConsumableItem, 'id'> = {
  name: '', code: '', category: '', unit: 'pcs', description: '',
  supplierName: '', minStock: 0, currentStock: 0, unitPrice: 0,
  currency: 'NOK', status: 'AVAILABLE', isActive: true,
};

// ============================================================================
// COMPONENT
// ============================================================================

export const ConsumablesTab: React.FC = () => {
  const [items, setItems] = useState<ConsumableItem[]>(INITIAL_DATA);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState(emptyForm);

  const filtered = items.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.code.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCat = selectedCategory === 'all' || item.category === selectedCategory;
    return matchesSearch && matchesCat;
  });

  const getCategoryLabel = (cat: string) => CATEGORIES.find(c => c.value === cat)?.label || cat;

  const openCreate = () => {
    setEditingId(null);
    setFormData(emptyForm);
    setIsModalOpen(true);
  };

  const openEdit = (item: ConsumableItem) => {
    setEditingId(item.id);
    const { id, ...rest } = item;
    setFormData(rest);
    setIsModalOpen(true);
  };

  const handleDelete = (id: string) => {
    if (confirm('Are you sure you want to delete this item?')) {
      setItems(prev => prev.filter(i => i.id !== id));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.code) { alert('Name and code are required.'); return; }

    if (editingId) {
      setItems(prev => prev.map(i => i.id === editingId ? { ...formData, id: editingId } : i));
    } else {
      const newItem: ConsumableItem = { ...formData, id: Date.now().toString() };
      setItems(prev => [...prev, newItem]);
    }
    setIsModalOpen(false);
  };

  const updateField = <K extends keyof typeof formData>(key: K, value: (typeof formData)[K]) => {
    setFormData(prev => ({ ...prev, [key]: value }));
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
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <svg className="absolute left-3 top-2.5 w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <select
            value={selectedCategory}
            onChange={e => setSelectedCategory(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">All Categories</option>
            {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Add Consumable
        </button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name / Code</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Category</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Unit</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Stock / Min</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Supplier</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {filtered.map(item => (
              <tr key={item.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm font-medium text-gray-900">{item.name}</div>
                  <div className="text-sm text-gray-500">{item.code}</div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${categoryColors[item.category] || 'bg-gray-100 text-gray-800'}`}>
                    {getCategoryLabel(item.category)}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{item.unit}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm">
                  <span className={item.currentStock <= item.minStock ? 'text-red-600 font-medium' : 'text-gray-900'}>
                    {item.currentStock}
                  </span>
                  <span className="text-gray-400"> / {item.minStock}</span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{item.supplierName}</td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[item.status] || 'bg-gray-100 text-gray-800'}`}>
                    {statusLabels[item.status] || item.status}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <button onClick={() => openEdit(item)} className="text-blue-600 hover:text-blue-900 mr-3">Edit</button>
                  <button onClick={() => handleDelete(item.id)} className="text-red-600 hover:text-red-900">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center py-12">
            <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            <h3 className="mt-2 text-sm font-medium text-gray-900">No consumables found</h3>
            <p className="mt-1 text-sm text-gray-500">Add consumable items to manage your stock.</p>
          </div>
        )}
      </div>

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => setIsModalOpen(false)} />
            <div className="relative bg-white rounded-lg shadow-xl sm:max-w-lg sm:w-full max-h-[90vh] overflow-y-auto">
              <form onSubmit={handleSubmit}>
                <div className="px-6 pt-5 pb-4">
                  <h3 className="text-lg font-medium text-gray-900 mb-4">
                    {editingId ? 'Edit Consumable' : 'Add Consumable'}
                  </h3>

                  {/* Basic Info */}
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Name *</label>
                        <input type="text" required value={formData.name} onChange={e => updateField('name', e.target.value)}
                          className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Code *</label>
                        <input type="text" required value={formData.code} onChange={e => updateField('code', e.target.value)}
                          className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Category *</label>
                        <select required value={formData.category} onChange={e => updateField('category', e.target.value)}
                          className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500">
                          <option value="">Select</option>
                          {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Unit</label>
                        <select value={formData.unit} onChange={e => updateField('unit', e.target.value)}
                          className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500">
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
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Supplier</label>
                      <input type="text" value={formData.supplierName} onChange={e => updateField('supplierName', e.target.value)}
                        className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Description</label>
                      <textarea value={formData.description} onChange={e => updateField('description', e.target.value)} rows={2}
                        className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500" />
                    </div>

                    {/* Stock & Price */}
                    <div className="border-t pt-4 mt-4">
                      <h4 className="text-sm font-medium text-gray-700 mb-3">Stock & Price</h4>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Min Stock</label>
                          <input type="number" min="0" value={formData.minStock} onChange={e => updateField('minStock', parseInt(e.target.value) || 0)}
                            className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500" />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Current Stock</label>
                          <input type="number" min="0" value={formData.currentStock} onChange={e => updateField('currentStock', parseInt(e.target.value) || 0)}
                            className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500" />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Unit Price</label>
                          <input type="number" min="0" step="0.01" value={formData.unitPrice} onChange={e => updateField('unitPrice', parseFloat(e.target.value) || 0)}
                            className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500" />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Currency</label>
                          <select value={formData.currency} onChange={e => updateField('currency', e.target.value)}
                            className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500">
                            <option value="NOK">NOK</option>
                            <option value="EUR">EUR</option>
                            <option value="USD">USD</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    {/* Status */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Status</label>
                      <select value={formData.status} onChange={e => updateField('status', e.target.value)}
                        className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500">
                        {Object.entries(statusLabels).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </div>
                  </div>
                </div>

                <div className="bg-gray-50 px-6 py-3 flex justify-end gap-3">
                  <button type="button" onClick={() => setIsModalOpen(false)}
                    className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50">
                    Cancel
                  </button>
                  <button type="submit"
                    className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700">
                    {editingId ? 'Update' : 'Create'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ConsumablesTab;
