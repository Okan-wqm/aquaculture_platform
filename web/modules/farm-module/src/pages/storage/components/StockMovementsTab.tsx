/**
 * Stock Movements Tab - Movement history with filters
 *
 * Displays a chronological table of all stock movements (IN, OUT, TRANSFER,
 * WASTE, ADJUSTMENT, RETURN) with search and type filtering. Also provides
 * two action buttons for warehouse staff:
 *  - "Record Movement" opens the general-purpose stock movement modal
 *  - "Transfer Stock" opens the simplified transfer-only modal
 */
import React, { useState } from 'react';
import { useStockMovements } from '../../../hooks/useStorageInventory';
import { RecordStockMovementModal } from './RecordStockMovementModal';
import { TransferStockModal } from './TransferStockModal';

const typeBadge: Record<string, string> = {
  IN: 'bg-green-100 text-green-800',
  OUT: 'bg-red-100 text-red-800',
  TRANSFER: 'bg-blue-100 text-blue-800',
  WASTE: 'bg-gray-100 text-gray-800',
  ADJUSTMENT: 'bg-yellow-100 text-yellow-800',
  RETURN: 'bg-purple-100 text-purple-800',
};

const TYPES = ['IN', 'OUT', 'TRANSFER', 'WASTE', 'ADJUSTMENT', 'RETURN'];

export const StockMovementsTab: React.FC = () => {
  const [typeFilter, setTypeFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [showMovementModal, setShowMovementModal] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);

  // Build the filter object dynamically — backend already accepts fromDate/toDate
  // params for audit queries ("show me all movements in January") and
  // troubleshooting ("what happened last week?").
  const filter: Record<string, string> | undefined = (() => {
    const f: Record<string, string> = {};
    if (typeFilter !== 'all') f.movementType = typeFilter;
    if (fromDate) f.fromDate = fromDate;
    if (toDate) f.toDate = toDate;
    return Object.keys(f).length > 0 ? f : undefined;
  })();
  const { data: movementsData, isLoading, error, refetch } = useStockMovements(filter);

  const movements = movementsData?.items || [];
  const filtered = movements.filter(m => {
    return m.itemName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (m.performedBy || '').toLowerCase().includes(searchTerm.toLowerCase());
  });

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="relative flex-1 max-w-md">
          <input type="text" placeholder="Search movements..." value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
          <svg className="absolute left-3 top-2.5 w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        {/* Date range filter for audit queries ("show me all movements in January")
            and troubleshooting ("what happened last week?"). The backend already
            supports fromDate/toDate — this is purely a frontend wiring task. */}
        <input
          type="date"
          value={fromDate}
          onChange={e => setFromDate(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
          placeholder="From date"
        />
        <input
          type="date"
          value={toDate}
          onChange={e => setToDate(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
          placeholder="To date"
        />
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent">
          <option value="all">All Types</option>
          {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>

        {/* Action buttons for recording new stock movements and transfers.
            These are the primary entry points for warehouse staff to record
            daily operations: feed dispensing (OUT), chemical dosing (OUT),
            goods receipt (IN), waste disposal (WASTE), and inter-location
            transfers (TRANSFER). */}
        <div className="flex gap-2">
          <button
            onClick={() => setShowMovementModal(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
          >
            Record Movement
          </button>
          <button
            onClick={() => setShowTransferModal(true)}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors text-sm font-medium"
          >
            Transfer Stock
          </button>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
        </div>
      )}

      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load movements.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">Retry</button>
        </div>
      )}

      {!isLoading && !error && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Item</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Quantity</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">From / To</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">By</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Reference</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filtered.map(m => (
                <tr key={m.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {new Date(m.performedAt).toLocaleDateString('nb-NO', { month: 'short', day: 'numeric' })}
                    <div className="text-xs text-gray-400">
                      {new Date(m.performedAt).toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${typeBadge[m.movementType] || 'bg-gray-100 text-gray-800'}`}>
                      {m.movementType}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm font-medium text-gray-900">{m.itemName}</div>
                    <div className="text-xs text-gray-500">{m.itemType}</div>
                  </td>
                  <td className="px-6 py-4 text-sm font-medium">
                    <span className={m.movementType === 'OUT' || m.movementType === 'WASTE' ? 'text-red-600' : 'text-green-600'}>
                      {m.movementType === 'OUT' || m.movementType === 'WASTE' ? '-' : '+'}{m.quantity} {m.unit}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {m.fromLocationName && m.toLocationName ? (
                      <>{m.fromLocationName} <span className="text-gray-400">&rarr;</span> {m.toLocationName}</>
                    ) : m.fromLocationName ? (
                      m.fromLocationName
                    ) : m.toLocationName ? (
                      <><span className="text-gray-400">&rarr;</span> {m.toLocationName}</>
                    ) : '-'}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">{m.performedBy}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {m.reference || m.reason || '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="text-center py-12 text-gray-500 text-sm">No movements found.</div>
          )}
        </div>
      )}

      {/* Stock movement and transfer modals.
          Both modals call refetch() on close to ensure the movements table
          reflects the newly recorded operation without a full page reload. */}
      <RecordStockMovementModal
        isOpen={showMovementModal}
        onClose={() => { setShowMovementModal(false); refetch(); }}
      />
      <TransferStockModal
        isOpen={showTransferModal}
        onClose={() => { setShowTransferModal(false); refetch(); }}
      />
    </div>
  );
};

export default StockMovementsTab;
