/**
 * Purchase Orders Tab - Real GraphQL-backed PO list with filters and modals
 */
import {
  parseMoney,
  useConfirm,
  DataTable,
  type DataTableColumn,
  Spinner,
  Button,
} from '@aquaculture/shared-ui';
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
import { Plus } from 'lucide-react';

const statusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  SUBMITTED: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  APPROVED: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  ORDERED: 'bg-primary-100 dark:bg-primary-900/40 text-primary-800 dark:text-primary-200',
  PARTIALLY_RECEIVED:
    'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  RECEIVED: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  CANCELLED: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
};

const categoryColors: Record<string, string> = {
  FEED: 'bg-warning-50 dark:bg-warning-900/20 text-warning-700 dark:text-warning-300',
  CHEMICAL: 'bg-info-50 dark:bg-info-900/20 text-info-700 dark:text-info-300',
  CONSUMABLE: 'bg-success-50 dark:bg-success-900/20 text-success-700 dark:text-success-300',
  HEALTHCARE: 'bg-accent-50 dark:bg-accent-900/20 text-accent-700 dark:text-accent-300',
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
    status: statusFilter ? (statusFilter as PurchaseOrderStatus) : undefined,
    category: categoryFilter ? (categoryFilter as PurchaseOrderCategory) : undefined,
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

  const confirm = useConfirm();
  const handleCancel = async (po: PurchaseOrder) => {
    if (
      !(await confirm({
        title: `Cancel PO ${po.orderNumber}?`,
        confirmText: 'Cancel order',
        cancelText: 'Keep',
        variant: 'danger',
      }))
    )
      return;
    try {
      await cancelPO.mutateAsync(po.id);
    } catch (err) {
      console.error('Failed to cancel PO:', err);
    }
  };

  type PoRow = (typeof orders)[number];
  const poRowColumns: DataTableColumn<PoRow>[] = [
    {
      key: 'order',
      header: 'Order #',
      render: (_value, po) => po.orderNumber,
    },
    {
      key: 'category',
      header: 'Category',
      render: (_value, po) => (
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${categoryColors[po.category] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
        >
          {po.category}
        </span>
      ),
    },
    {
      key: 'supplier',
      header: 'Supplier',
      render: (_value, po) => po.supplierName,
    },
    {
      key: 'items',
      header: 'Items',
      render: (_value, po) => (
        <>
          {po.items.length > 0 ? (
            <div>
              {po.items.slice(0, 2).map((item) => (
                <div key={item.id} className="text-xs">
                  {item.itemName} ({item.quantity} {item.unit})
                </div>
              ))}
              {po.items.length > 2 && (
                <div className="text-xs text-gray-400 dark:text-gray-500">
                  +{po.items.length - 2} more
                </div>
              )}
            </div>
          ) : (
            <span className="text-gray-400 dark:text-gray-500">No items</span>
          )}
        </>
      ),
    },
    {
      key: 'total',
      header: 'Total',
      render: (_value, po) =>
        po.totalAmountDecimal != null
          ? formatCurrency(parseMoney(po.totalAmountDecimal), po.currency)
          : '-',
    },
    {
      key: 'expected',
      header: 'Expected',
      render: (_value, po) =>
        po.expectedDeliveryDate
          ? new Date(po.expectedDeliveryDate).toLocaleDateString('nb-NO')
          : '-',
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, po) => (
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[po.status] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
        >
          {po.status.replace('_', ' ')}
        </span>
      ),
    },
    {
      key: 'approvedBy',
      header: 'Approved By',
      render: (_value, po) => (
        <>
          {po.approvedByName || po.approvedBy ? (
            <div>
              <div className="text-xs text-gray-700 dark:text-gray-300">
                {po.approvedByName || po.approvedBy}
              </div>
              {po.approvedAt && (
                <div className="text-xs text-gray-400 dark:text-gray-500">
                  {new Date(po.approvedAt).toLocaleDateString('nb-NO')}
                </div>
              )}
            </div>
          ) : (
            <span className="text-gray-400 dark:text-gray-500">-</span>
          )}
        </>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (_value, po) => (
        <div className="flex gap-2">
          {po.status === 'DRAFT' && (
            <button
              onClick={() => handleSubmit(po)}
              className="text-xs px-2 py-1 bg-warning-50 dark:bg-warning-900/20 text-warning-700 dark:text-warning-300 rounded hover:bg-warning-100 dark:hover:bg-warning-900/50"
            >
              Submit for Approval
            </button>
          )}
          {po.status === 'SUBMITTED' && (
            <button
              onClick={() => handleApprove(po)}
              className="text-xs px-2 py-1 bg-info-50 dark:bg-info-900/20 text-info-700 dark:text-info-300 rounded hover:bg-info-100 dark:hover:bg-info-900/50"
            >
              Approve
            </button>
          )}
          {po.status === 'APPROVED' && (
            <button
              onClick={() => handleMarkOrdered(po)}
              className="text-xs px-2 py-1 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300 rounded hover:bg-primary-100 dark:hover:bg-primary-900/50"
            >
              Mark Ordered
            </button>
          )}
          {(po.status === 'ORDERED' || po.status === 'PARTIALLY_RECEIVED') && (
            <button
              onClick={() => setReceiveTarget(po)}
              className="text-xs px-2 py-1 bg-success-50 dark:bg-success-900/20 text-success-700 dark:text-success-300 rounded hover:bg-success-100 dark:hover:bg-success-900/50"
            >
              Receive
            </button>
          )}
          {po.status !== 'RECEIVED' && po.status !== 'CANCELLED' && (
            <button
              onClick={() => handleCancel(po)}
              className="text-xs px-2 py-1 bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-300 rounded hover:bg-error-100 dark:hover:bg-error-900/50"
            >
              Cancel
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex gap-3">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-transparent text-sm"
          >
            <option value="">All Status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-transparent text-sm"
          >
            <option value="">All Categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <Button variant="primary" onClick={() => setIsCreateOpen(true)}>
          <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
          New Purchase Order
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Spinner size="lg" />
        </div>
      )}

      {error && (
        <div className="text-center py-12 bg-error-50 dark:bg-error-900/20 rounded-lg border border-error-200 dark:border-error-800">
          <p className="text-error-600 dark:text-error-400">Failed to load purchase orders.</p>
          <Button variant="ghost" className="mt-2" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {!isLoading && !error && (
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
          <DataTable<PoRow>
            data={orders}
            columns={poRowColumns}
            keyExtractor={(po) => po.id}
            emptyMessage="No records found"
            searchable={false}
            sortable={false}
            stickyHeader={false}
          />
          {orders.length === 0 && (
            <div className="text-center py-12 text-gray-500 dark:text-gray-400 text-sm">
              No purchase orders found.
            </div>
          )}
        </div>
      )}

      <CreatePurchaseOrderModal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} />
      <ReceiveDeliveryModal
        isOpen={!!receiveTarget}
        onClose={() => setReceiveTarget(null)}
        purchaseOrder={receiveTarget}
      />
    </div>
  );
};

export default PurchaseOrdersTab;
