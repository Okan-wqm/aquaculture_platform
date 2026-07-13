/**
 * Purchase Orders Tab - Real GraphQL-backed PO list with filters and modals
 */
import { parseMoney } from '@aquaculture/shared-ui';
import React, { useState } from 'react';
import {
  usePurchaseOrders,
  useUpdatePurchaseOrderStatus,
  useSubmitPurchaseOrder,
  useApprovePurchaseOrder,
  useCancelPurchaseOrder,
  PurchaseOrderCategory,
  PurchaseOrderStatus,
  PurchaseOrder,
} from '../../../hooks/usePurchaseOrders';
import { CreatePurchaseOrderModal } from './CreatePurchaseOrderModal';
import { ReceiveDeliveryModal } from './ReceiveDeliveryModal';

const statusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-800',
  SUBMITTED: 'bg-yellow-100 text-yellow-800',
  APPROVED: 'bg-teal-100 text-teal-800',
  ORDERED: 'bg-indigo-100 text-indigo-800',
  PARTIALLY_RECEIVED: 'bg-orange-100 text-orange-800',
  RECEIVED: 'bg-green-100 text-green-800',
  CANCELLED: 'bg-red-100 text-red-800',
};

const categoryColors: Record<string, string> = {
  FEED: 'bg-amber-50 text-amber-700',
  CHEMICAL: 'bg-blue-50 text-blue-700',
  CONSUMABLE: 'bg-green-50 text-green-700',
  HEALTHCARE: 'bg-purple-50 text-purple-700',
};

const STATUSES: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.DRAFT,
  PurchaseOrderStatus.SUBMITTED,
  PurchaseOrderStatus.APPROVED,
  PurchaseOrderStatus.ORDERED,
  PurchaseOrderStatus.PARTIALLY_RECEIVED,
  PurchaseOrderStatus.RECEIVED,
  PurchaseOrderStatus.CANCELLED,
];

const CATEGORIES: PurchaseOrderCategory[] = [
  PurchaseOrderCategory.FEED,
  PurchaseOrderCategory.CHEMICAL,
  PurchaseOrderCategory.CONSUMABLE,
  PurchaseOrderCategory.HEALTHCARE,
];

const formatCurrency = (amount: number, currency: string) =>
  new Intl.NumberFormat('nb-NO', { style: 'currency', currency }).format(amount);

export const PurchaseOrdersTab: React.FC = () => {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [receiveTarget, setReceiveTarget] = useState<PurchaseOrder | null>(null);

  const { data, isLoading, error, refetch } = usePurchaseOrders({
    status: statusFilter ? statusFilter as PurchaseOrderStatus : undefined,
    category: categoryFilter ? categoryFilter as PurchaseOrderCategory : undefined,
  });

  const updateStatus = useUpdatePurchaseOrderStatus();
  const submitPO = useSubmitPurchaseOrder();
  const approvePO = useApprovePurchaseOrder();
  const cancelPO = useCancelPurchaseOrder();

  const orders = data?.items || [];

  // Maker step: DRAFT -> SUBMITTED (sends the PO into the approval queue).
  const handleSubmit = async (po: PurchaseOrder) => {
    try {
      await submitPO.mutateAsync(po.id);
    } catch (err) {
      console.error('Failed to submit PO for approval:', err);
    }
  };

  // Checker step: SUBMITTED -> APPROVED. The backend rejects self-approval
  // (creator === approver) with a 403 — surface that message to the user.
  const handleApprove = async (po: PurchaseOrder) => {
    try {
      await approvePO.mutateAsync(po.id);
    } catch (err) {
      console.error('Failed to approve PO:', err);
    }
  };

  // Post-approval: APPROVED -> ORDERED (places the authorized spend). ORDERED is
  // reachable ONLY from APPROVED, so this button only appears on APPROVED rows.
  const handleMarkOrdered = async (po: PurchaseOrder) => {
    try {
      await updateStatus.mutateAsync({ id: po.id, status: PurchaseOrderStatus.ORDERED });
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  };

  const handleCancel = async (po: PurchaseOrder) => {
    if (!confirm(`Cancel PO ${po.orderNumber}?`)) return;
    try {
      await cancelPO.mutateAsync(po.id);
    } catch (err) {
      console.error('Failed to cancel PO:', err);
    }
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex gap-3">
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm">
            <option value="">All Status</option>
            {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
          <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm">
            <option value="">All Categories</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <button onClick={() => setIsCreateOpen(true)}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm">
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          New Purchase Order
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
        </div>
      )}

      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load purchase orders.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">Retry</button>
        </div>
      )}

      {!isLoading && !error && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Order #</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Supplier</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Items</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Total</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Expected</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Approved By</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {orders.map(po => (
                <tr key={po.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm font-medium text-gray-900 font-mono">{po.orderNumber}</td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${categoryColors[po.category] || 'bg-gray-100 text-gray-800'}`}>
                      {po.category}
                    </span>
                  </td>
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
                  <td className="px-6 py-4 text-sm font-medium text-gray-900">
                    {po.totalAmountDecimal != null ? formatCurrency(parseMoney(po.totalAmountDecimal), po.currency) : '-'}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {po.expectedDeliveryDate ? new Date(po.expectedDeliveryDate).toLocaleDateString('nb-NO') : '-'}
                  </td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[po.status] || 'bg-gray-100 text-gray-800'}`}>
                      {po.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {po.approvedByName || po.approvedBy ? (
                      <div>
                        <div className="text-xs text-gray-700">{po.approvedByName || po.approvedBy}</div>
                        {po.approvedAt && (
                          <div className="text-xs text-gray-400">{new Date(po.approvedAt).toLocaleDateString('nb-NO')}</div>
                        )}
                      </div>
                    ) : <span className="text-gray-400">-</span>}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex gap-2">
                      {po.status === 'DRAFT' && (
                        <button onClick={() => handleSubmit(po)}
                          className="text-xs px-2 py-1 bg-yellow-50 text-yellow-700 rounded hover:bg-yellow-100">
                          Submit for Approval
                        </button>
                      )}
                      {po.status === 'SUBMITTED' && (
                        <button onClick={() => handleApprove(po)}
                          className="text-xs px-2 py-1 bg-teal-50 text-teal-700 rounded hover:bg-teal-100">
                          Approve
                        </button>
                      )}
                      {po.status === 'APPROVED' && (
                        <button onClick={() => handleMarkOrdered(po)}
                          className="text-xs px-2 py-1 bg-indigo-50 text-indigo-700 rounded hover:bg-indigo-100">
                          Mark Ordered
                        </button>
                      )}
                      {(po.status === 'ORDERED' || po.status === 'PARTIALLY_RECEIVED') && (
                        <button onClick={() => setReceiveTarget(po)}
                          className="text-xs px-2 py-1 bg-green-50 text-green-700 rounded hover:bg-green-100">
                          Receive
                        </button>
                      )}
                      {po.status !== 'RECEIVED' && po.status !== 'CANCELLED' && (
                        <button onClick={() => handleCancel(po)}
                          className="text-xs px-2 py-1 bg-red-50 text-red-700 rounded hover:bg-red-100">
                          Cancel
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {orders.length === 0 && (
            <div className="text-center py-12 text-gray-500 text-sm">No purchase orders found.</div>
          )}
        </div>
      )}

      <CreatePurchaseOrderModal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} />
      <ReceiveDeliveryModal isOpen={!!receiveTarget} onClose={() => setReceiveTarget(null)} purchaseOrder={receiveTarget} />
    </div>
  );
};

export default PurchaseOrdersTab;
