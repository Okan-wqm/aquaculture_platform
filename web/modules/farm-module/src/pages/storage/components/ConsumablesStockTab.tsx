/**
 * Consumables Stock Tab - View consumable inventory from storage
 */
import React, { useState } from 'react';
import { useStorageInventory, StorageItemType } from '../../../hooks/useStorageInventory';

export const ConsumablesStockTab: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const { data: inventory, isLoading, error, refetch } = useStorageInventory(undefined, StorageItemType.CONSUMABLE);

  const items = inventory || [];
  const filtered = items.filter(item => {
    return (item.itemName || '').toLowerCase().includes(searchTerm.toLowerCase());
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
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
        </div>
      )}

      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load consumable stock.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">Retry</button>
        </div>
      )}

      {!isLoading && !error && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Item</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Location</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Lot Number</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Quantity</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filtered.map(item => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm font-medium text-gray-900">{item.itemName || '-'}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">{item.locationName || '-'}</td>
                  <td className="px-6 py-4 text-sm text-gray-500 font-mono">{item.lotNumber || '-'}</td>
                  <td className="px-6 py-4 text-sm font-medium text-gray-900">{item.quantity} {item.unit}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">{item.notes || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="text-center py-12 text-gray-500 text-sm">No consumable items found.</div>
          )}
        </div>
      )}
    </div>
  );
};

export default ConsumablesStockTab;
