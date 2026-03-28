/**
 * Feed Stock Tab - View feed inventory from storage
 */
import React, { useState } from 'react';
import { useStorageInventory, StorageItemType } from '../../../hooks/useStorageInventory';

const statusColors: Record<string, string> = {
  AVAILABLE: 'bg-green-100 text-green-800',
  LOW_STOCK: 'bg-yellow-100 text-yellow-800',
  OUT_OF_STOCK: 'bg-red-100 text-red-800',
  EXPIRED: 'bg-gray-100 text-gray-800',
};

/**
 * Determines the visual urgency class for an inventory row based on expiry date.
 * Red = expired (safety hazard), amber = expiring within 30 days (action needed),
 * transparent = normal. This follows HACCP Critical Control Point guidance for
 * perishable aquaculture supplies (feed, chemicals, medications).
 */
function getExpiryRowClass(expiryDate?: string): string {
  if (!expiryDate) return '';
  const expiry = new Date(expiryDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (expiry < today) return 'bg-red-50';
  const thirtyDaysFromNow = new Date(today);
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
  if (expiry <= thirtyDaysFromNow) return 'bg-amber-50';
  return '';
}

export const FeedStockTab: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const { data: inventory, isLoading, error, refetch } = useStorageInventory(undefined, StorageItemType.FEED);

  const items = inventory || [];
  const filtered = items.filter(item => {
    return (item.itemName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (item.lotNumber || '').toLowerCase().includes(searchTerm.toLowerCase());
  });

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="relative flex-1 max-w-md">
          <input type="text" placeholder="Search feeds..." value={searchTerm}
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
          <p className="text-red-600">Failed to load feed stock.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">Retry</button>
        </div>
      )}

      {!isLoading && !error && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Feed</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Location</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Lot Number</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Quantity</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Expiry</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filtered.map(item => (
                <tr key={item.id} className={`hover:bg-gray-50 ${getExpiryRowClass(item.expiryDate)}`}>
                  <td className="px-6 py-4 text-sm font-medium text-gray-900">{item.itemName || '-'}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">{item.locationName || '-'}</td>
                  <td className="px-6 py-4 text-sm text-gray-500 font-mono">{item.lotNumber || '-'}</td>
                  <td className="px-6 py-4 text-sm font-medium text-gray-900">{item.quantity} {item.unit}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {item.expiryDate ? new Date(item.expiryDate).toLocaleDateString('nb-NO') : '-'}
                    {/* Visual badge indicates urgency level for warehouse staff scanning
                        the inventory list. Red = must be disposed/used immediately.
                        Amber = plan to use within 30 days or risk waste. */}
                    {item.expiryDate && new Date(item.expiryDate) < new Date() && (
                      <span className="ml-2 text-xs px-1.5 py-0.5 bg-red-100 text-red-700 rounded font-medium">EXPIRED</span>
                    )}
                    {item.expiryDate && new Date(item.expiryDate) >= new Date() &&
                      new Date(item.expiryDate) <= new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) && (
                      <span className="ml-2 text-xs px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded font-medium">EXPIRING SOON</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="text-center py-12 text-gray-500 text-sm">No feed stock items found.</div>
          )}
        </div>
      )}
    </div>
  );
};

export default FeedStockTab;
