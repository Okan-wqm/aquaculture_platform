/**
 * Purchase Orders Tab - PO list with status filters and creation modal
 */
import React, { useState } from 'react';
import { purchaseOrders as initialOrders } from '../mock';
import type { PurchaseOrder, PurchaseOrderStatus } from '../types/storage.types';

const statusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-800',
  PENDING: 'bg-yellow-100 text-yellow-800',
  APPROVED: 'bg-blue-100 text-blue-800',
  ORDERED: 'bg-indigo-100 text-indigo-800',
  PARTIAL: 'bg-orange-100 text-orange-800',
  RECEIVED: 'bg-green-100 text-green-800',
  CANCELLED: 'bg-red-100 text-red-800',
};

const STATUSES: PurchaseOrderStatus[] = ['DRAFT', 'PENDING', 'APPROVED', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED'];

const formatCurrency = (amount: number, currency: string) =>
  new Intl.NumberFormat('nb-NO', { style: 'currency', currency }).format(amount);

export const PurchaseOrdersTab: React.FC = () => {
  const [orders, setOrders] = useState<PurchaseOrder[]>(initialOrders);
  const [statusFilter, setStatusFilter] = useState('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newPO, setNewPO] = useState({ supplierName: '', notes: '' });

  const filtered = orders.filter(o => statusFilter === 'all' || o.status === statusFilter);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPO.supplierName) { alert('Supplier required.'); return; }
    const po: PurchaseOrder = {
      id: Date.now().toString(),
      poNumber: `PO-2026-${String(orders.length + 46).padStart(3, '0')}`,
      supplierName: newPO.supplierName,
      status: 'DRAFT',
      items: [],
      totalAmount: 0,
      currency: 'NOK',
      orderDate: new Date().toISOString().split('T')[0],
      notes: newPO.notes || undefined,
    };
    setOrders(prev => [po, ...prev]);
    setNewPO({ supplierName: '', notes: '' });
    setIsModalOpen(false);
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent">
          <option value="all">All Status</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <button onClick={() => setIsModalOpen(true)}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          New Purchase Order
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">PO Number</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Supplier</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Items</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Total</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Order Date</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Expected</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {filtered.map(po => (
              <tr key={po.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 text-sm font-medium text-gray-900 font-mono">{po.poNumber}</td>
                <td className="px-6 py-4 text-sm text-gray-700">{po.supplierName}</td>
                <td className="px-6 py-4 text-sm text-gray-500">
                  {po.items.length > 0 ? (
                    <div>
                      {po.items.slice(0, 2).map(item => (
                        <div key={item.id} className="text-xs">{item.itemName} ({item.quantity} {item.unit})</div>
                      ))}
                      {po.items.length > 2 && <div className="text-xs text-gray-400">+{po.items.length - 2} more</div>}
                    </div>
                  ) : <span className="text-gray-400">No items</span>}
                </td>
                <td className="px-6 py-4 text-sm font-medium text-gray-900">{formatCurrency(po.totalAmount, po.currency)}</td>
                <td className="px-6 py-4 text-sm text-gray-500">{new Date(po.orderDate).toLocaleDateString('nb-NO')}</td>
                <td className="px-6 py-4 text-sm text-gray-500">
                  {po.expectedDelivery ? new Date(po.expectedDelivery).toLocaleDateString('nb-NO') : '-'}
                </td>
                <td className="px-6 py-4">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[po.status] || 'bg-gray-100 text-gray-800'}`}>
                    {po.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-gray-500 text-sm">No purchase orders found.</div>
        )}
      </div>

      {/* Create Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => setIsModalOpen(false)} />
            <div className="relative bg-white rounded-lg shadow-xl sm:max-w-md sm:w-full">
              <form onSubmit={handleCreate}>
                <div className="px-6 pt-5 pb-4 space-y-4">
                  <h3 className="text-lg font-medium text-gray-900">New Purchase Order</h3>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Supplier *</label>
                    <input type="text" required value={newPO.supplierName}
                      onChange={e => setNewPO(prev => ({ ...prev, supplierName: e.target.value }))}
                      className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Notes</label>
                    <textarea rows={2} value={newPO.notes}
                      onChange={e => setNewPO(prev => ({ ...prev, notes: e.target.value }))}
                      className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500" />
                  </div>
                  <p className="text-xs text-gray-500">Items can be added after creation.</p>
                </div>
                <div className="bg-gray-50 px-6 py-3 flex justify-end gap-3">
                  <button type="button" onClick={() => setIsModalOpen(false)}
                    className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 bg-white hover:bg-gray-50">Cancel</button>
                  <button type="submit"
                    className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700">Create</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PurchaseOrdersTab;
