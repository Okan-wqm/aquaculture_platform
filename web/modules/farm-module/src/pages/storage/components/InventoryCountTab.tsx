/**
 * Inventory Count Tab - Count records with detail modal
 */
import React, { useState } from 'react';
import { inventoryCounts } from '../mock';
import type { InventoryCount } from '../types/storage.types';

const statusColors: Record<string, string> = {
  PLANNED: 'bg-gray-100 text-gray-800',
  IN_PROGRESS: 'bg-blue-100 text-blue-800',
  COMPLETED: 'bg-green-100 text-green-800',
  APPROVED: 'bg-purple-100 text-purple-800',
};

export const InventoryCountTab: React.FC = () => {
  const [selectedCount, setSelectedCount] = useState<InventoryCount | null>(null);

  return (
    <div>
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Count #</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Location</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Items</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Total Variance</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Performed By</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {inventoryCounts.map(ic => (
              <tr key={ic.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 text-sm font-medium text-gray-900 font-mono">{ic.countNumber}</td>
                <td className="px-6 py-4 text-sm text-gray-700">{ic.locationName}</td>
                <td className="px-6 py-4 text-sm text-gray-500">{new Date(ic.countDate).toLocaleDateString('nb-NO')}</td>
                <td className="px-6 py-4 text-sm text-gray-500">{ic.items.length}</td>
                <td className="px-6 py-4 text-sm">
                  <span className={ic.totalVariance !== 0 ? 'text-red-600 font-medium' : 'text-green-600'}>
                    {ic.totalVariance > 0 ? '+' : ''}{ic.totalVariance}
                  </span>
                </td>
                <td className="px-6 py-4 text-sm text-gray-500">{ic.performedBy}</td>
                <td className="px-6 py-4">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[ic.status] || 'bg-gray-100 text-gray-800'}`}>
                    {ic.status.replace('_', ' ')}
                  </span>
                </td>
                <td className="px-6 py-4 text-right">
                  <button onClick={() => setSelectedCount(ic)} className="text-blue-600 hover:text-blue-900 text-sm">
                    Details
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Detail Modal */}
      {selectedCount && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => setSelectedCount(null)} />
            <div className="relative bg-white rounded-lg shadow-xl sm:max-w-lg sm:w-full max-h-[90vh] overflow-y-auto">
              <div className="px-6 pt-5 pb-4">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="text-lg font-medium text-gray-900">{selectedCount.countNumber}</h3>
                    <p className="text-sm text-gray-500">{selectedCount.locationName} - {new Date(selectedCount.countDate).toLocaleDateString('nb-NO')}</p>
                  </div>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[selectedCount.status]}`}>
                    {selectedCount.status.replace('_', ' ')}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                  <div>
                    <span className="text-gray-500">Performed by:</span>
                    <span className="ml-1 text-gray-900">{selectedCount.performedBy}</span>
                  </div>
                  {selectedCount.approvedBy && (
                    <div>
                      <span className="text-gray-500">Approved by:</span>
                      <span className="ml-1 text-gray-900">{selectedCount.approvedBy}</span>
                    </div>
                  )}
                </div>

                {selectedCount.items.length > 0 ? (
                  <table className="min-w-full divide-y divide-gray-200 border border-gray-200 rounded-lg">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Item</th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">Expected</th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">Counted</th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">Variance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {selectedCount.items.map(item => (
                        <tr key={item.id}>
                          <td className="px-4 py-2 text-sm text-gray-900">{item.itemName}</td>
                          <td className="px-4 py-2 text-sm text-gray-500 text-right">{item.expectedQty} {item.unit}</td>
                          <td className="px-4 py-2 text-sm text-gray-900 text-right">{item.countedQty} {item.unit}</td>
                          <td className={`px-4 py-2 text-sm text-right font-medium ${item.variance !== 0 ? 'text-red-600' : 'text-green-600'}`}>
                            {item.variance > 0 ? '+' : ''}{item.variance}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-gray-50">
                      <tr>
                        <td className="px-4 py-2 text-sm font-medium text-gray-900" colSpan={3}>Total Variance</td>
                        <td className={`px-4 py-2 text-sm text-right font-bold ${selectedCount.totalVariance !== 0 ? 'text-red-600' : 'text-green-600'}`}>
                          {selectedCount.totalVariance > 0 ? '+' : ''}{selectedCount.totalVariance}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                ) : (
                  <p className="text-sm text-gray-500 text-center py-6">No items counted yet.</p>
                )}
              </div>
              <div className="bg-gray-50 px-6 py-3 flex justify-end">
                <button onClick={() => setSelectedCount(null)}
                  className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 bg-white hover:bg-gray-50">Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default InventoryCountTab;
