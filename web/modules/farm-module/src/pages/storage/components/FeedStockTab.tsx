/**
 * Feed Stock Tab - View and filter feed inventory
 */
import React, { useState } from 'react';
import { feedStockItems } from '../mock';

const statusColors: Record<string, string> = {
  AVAILABLE: 'bg-green-100 text-green-800',
  LOW_STOCK: 'bg-yellow-100 text-yellow-800',
  OUT_OF_STOCK: 'bg-red-100 text-red-800',
  EXPIRED: 'bg-gray-100 text-gray-800',
};

export const FeedStockTab: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const filtered = feedStockItems.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.lotNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.brand.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || item.status === statusFilter;
    return matchesSearch && matchesStatus;
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
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent">
          <option value="all">All Status</option>
          <option value="AVAILABLE">Available</option>
          <option value="LOW_STOCK">Low Stock</option>
          <option value="EXPIRED">Expired</option>
        </select>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Feed</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Brand / Type</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Lot Number</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Quantity</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Location</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Pellet Size</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Expiry</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {filtered.map(item => (
              <tr key={item.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 text-sm font-medium text-gray-900">{item.name}</td>
                <td className="px-6 py-4 text-sm text-gray-500">
                  <div>{item.brand}</div>
                  <div className="text-xs text-gray-400">{item.type}</div>
                </td>
                <td className="px-6 py-4 text-sm text-gray-500 font-mono">{item.lotNumber}</td>
                <td className="px-6 py-4 text-sm font-medium text-gray-900">{item.quantity.toLocaleString()} {item.unit}</td>
                <td className="px-6 py-4 text-sm text-gray-500">{item.location}</td>
                <td className="px-6 py-4 text-sm text-gray-500">{item.pelletSize}</td>
                <td className="px-6 py-4 text-sm text-gray-500">{new Date(item.expiryDate).toLocaleDateString('nb-NO')}</td>
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
          <div className="text-center py-12 text-gray-500 text-sm">No feed stock items found.</div>
        )}
      </div>
    </div>
  );
};

export default FeedStockTab;
