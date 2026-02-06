/**
 * Consumables Stock Tab - View consumable inventory
 */
import React, { useState } from 'react';
import { consumableItems } from '../mock';

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

const categoryLabels: Record<string, string> = {
  NET: 'Net', ROPE: 'Rope', PPE: 'PPE', SPARE_PART: 'Spare Part',
  OXYGEN: 'Oxygen', PACKAGING: 'Packaging', CLEANING: 'Cleaning',
  TOOL: 'Tool', ELECTRICAL: 'Electrical', PIPE_FITTING: 'Pipe & Fitting', OTHER: 'Other',
};

const statusColors: Record<string, string> = {
  AVAILABLE: 'bg-green-100 text-green-800',
  LOW_STOCK: 'bg-yellow-100 text-yellow-800',
  OUT_OF_STOCK: 'bg-red-100 text-red-800',
};

export const ConsumablesStockTab: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');

  const categories = [...new Set(consumableItems.map(i => i.category))];

  const filtered = consumableItems.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.code.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCat = categoryFilter === 'all' || item.category === categoryFilter;
    return matchesSearch && matchesCat;
  });

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="relative flex-1 max-w-md">
          <input type="text" placeholder="Search consumables..." value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
          <svg className="absolute left-3 top-2.5 w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent">
          <option value="all">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{categoryLabels[c] || c}</option>)}
        </select>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name / Code</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Stock / Min</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Unit Price</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Supplier</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {filtered.map(item => (
              <tr key={item.id} className="hover:bg-gray-50">
                <td className="px-6 py-4">
                  <div className="text-sm font-medium text-gray-900">{item.name}</div>
                  <div className="text-sm text-gray-500">{item.code}</div>
                </td>
                <td className="px-6 py-4">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${categoryColors[item.category] || 'bg-gray-100 text-gray-800'}`}>
                    {categoryLabels[item.category] || item.category}
                  </span>
                </td>
                <td className="px-6 py-4 text-sm">
                  <span className={item.currentStock <= item.minStock ? 'text-red-600 font-medium' : 'text-gray-900'}>
                    {item.currentStock}
                  </span>
                  <span className="text-gray-400"> / {item.minStock} {item.unit}</span>
                </td>
                <td className="px-6 py-4 text-sm text-gray-700">{item.unitPrice.toLocaleString()} {item.currency}</td>
                <td className="px-6 py-4 text-sm text-gray-500">{item.supplierName}</td>
                <td className="px-6 py-4">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[item.status] || 'bg-gray-100 text-gray-800'}`}>
                    {item.status.replace('_', ' ')}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-gray-500 text-sm">No consumable items found.</div>
        )}
      </div>
    </div>
  );
};

export default ConsumablesStockTab;
