/**
 * Feed Inventory Tab
 *
 * Feed inventory management with:
 * - Inventory list per feed with status indicators
 * - Add inventory (purchase)
 * - Consume inventory (usage)
 * - Adjust inventory (correction)
 */
import React, { useState, useMemo } from 'react';
import {
  useFeedInventoryList,
  useAddFeedInventory,
  useConsumeFeedInventory,
  useAdjustFeedInventory,
  FeedInventory,
  FeedInventoryFilterInput,
  InventoryStatus,
  ConsumptionReason,
  AdjustmentType,
  AddFeedInventoryInput,
  ConsumeFeedInventoryInput,
  AdjustFeedInventoryInput,
} from '../../../hooks/useFeedingRecords';
import { useFeedList } from '../../../hooks/useFeeds';
import { isBlockingError } from '../../../utils/list-view-state';
import { useAuth } from '@aquaculture/shared-ui';

// ============================================================================
// TYPES
// ============================================================================

interface FeedInventoryTabProps {
  siteId?: string;
  sites: any[];
}

type ModalType = 'add' | 'consume' | 'adjust' | null;

// ============================================================================
// STATUS DISPLAY
// ============================================================================

/**
 * Status display configuration — keyed by GraphQL enum KEYS (uppercase).
 * The backend InventoryStatus enum uses uppercase keys (AVAILABLE, LOW_STOCK, etc.)
 * which is what GraphQL returns and expects in filters.
 */
const statusConfig: Record<InventoryStatus, { label: string; className: string }> = {
  AVAILABLE: { label: 'Available', className: 'bg-green-100 text-green-800' },
  LOW_STOCK: { label: 'Low Stock', className: 'bg-yellow-100 text-yellow-800' },
  OUT_OF_STOCK: { label: 'Out of Stock', className: 'bg-red-100 text-red-800' },
  EXPIRED: { label: 'Expired', className: 'bg-gray-100 text-gray-800' },
  QUARANTINE: { label: 'Quarantine', className: 'bg-purple-100 text-purple-800' },
};

// ============================================================================
// COMPONENT
// ============================================================================

export const FeedInventoryTab: React.FC<FeedInventoryTabProps> = ({
  siteId,
  sites,
}) => {
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<InventoryStatus | ''>('');
  const [modalType, setModalType] = useState<ModalType>(null);
  const [selectedInventory, setSelectedInventory] = useState<FeedInventory | null>(null);

  // Build filter
  const filter = useMemo<FeedInventoryFilterInput>(() => ({
    siteId: siteId || undefined,
    status: statusFilter || undefined,
  }), [siteId, statusFilter]);

  // Data
  const { data, isLoading, error, refetch } = useFeedInventoryList(filter, { page, limit: 20 });
  const { data: feeds } = useFeedList();
  const addMutation = useAddFeedInventory();
  const consumeMutation = useConsumeFeedInventory();
  const adjustMutation = useAdjustFeedInventory();

  // Feed lookup
  const feedMap = useMemo(() => {
    const map: Record<string, string> = {};
    feeds?.items?.forEach((f: any) => { map[f.id] = f.name || f.code; });
    return map;
  }, [feeds]);

  // Site lookup
  const siteMap = useMemo(() => {
    const map: Record<string, string> = {};
    sites.forEach((s: any) => { map[s.id] = s.name; });
    return map;
  }, [sites]);

  // Handlers
  const handleAdd = () => {
    setSelectedInventory(null);
    setModalType('add');
  };

  const handleConsume = (inventory: FeedInventory) => {
    setSelectedInventory(inventory);
    setModalType('consume');
  };

  const handleAdjust = (inventory: FeedInventory) => {
    setSelectedInventory(inventory);
    setModalType('adjust');
  };

  /**
   * Submit handler for adding new feed inventory.
   * Validates user context before sending the mutation.
   */
  const handleAddSubmit = async (data: any) => {
    try {
      if (!user?.id) {
        console.error('Failed to add inventory: user context missing');
        return;
      }
      const input: AddFeedInventoryInput = {
        feedId: data.feedId,
        siteId: data.siteId,
        departmentId: data.departmentId || undefined,
        quantityKg: Number(data.quantityKg),
        lotNumber: data.lotNumber || undefined,
        manufacturingDate: data.manufacturingDate || undefined,
        expiryDate: data.expiryDate || undefined,
        receivedDate: data.receivedDate || undefined,
        unitPricePerKg: data.unitPricePerKg ? Number(data.unitPricePerKg) : undefined,
        currency: data.currency || undefined,
        storageLocation: data.storageLocation || undefined,
        notes: data.notes || undefined,
        createdBy: user.id,
      };
      await addMutation.mutateAsync(input);
      setModalType(null);
    } catch (err) {
      console.error('Failed to add inventory:', err);
    }
  };

  const handleConsumeSubmit = async (data: any) => {
    try {
      const input: ConsumeFeedInventoryInput = {
        inventoryId: data.inventoryId,
        quantityKg: Number(data.quantityKg),
        reason: data.reason || 'FEEDING',
        notes: data.notes || undefined,
      };
      await consumeMutation.mutateAsync(input);
      setModalType(null);
      setSelectedInventory(null);
    } catch (err) {
      console.error('Failed to consume inventory:', err);
    }
  };

  const handleAdjustSubmit = async (data: any) => {
    try {
      const input: AdjustFeedInventoryInput = {
        inventoryId: data.inventoryId,
        adjustmentType: data.adjustmentType,
        quantity: Number(data.quantity),
        reason: data.reason,
        notes: data.notes || undefined,
      };
      await adjustMutation.mutateAsync(input);
      setModalType(null);
      setSelectedInventory(null);
    } catch (err) {
      console.error('Failed to adjust inventory:', err);
    }
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    try {
      return new Date(dateStr).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  // Blocking error — ONLY when the initial load failed and there is no cached
  // inventory. A failed background refetch with cached rows keeps rendering the
  // table and surfaces a non-blocking banner below (stale-on-error).
  if (isBlockingError(error, (data?.items?.length ?? 0) > 0)) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <p className="text-red-800">Failed to load inventory: {(error as Error).message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Non-blocking refresh error — keeps the last-loaded inventory visible. */}
      {error && (
        <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-800">
            Couldn&apos;t refresh inventory — showing the last loaded data.{' '}
            <span className="text-amber-700">{(error as Error).message}</span>
          </p>
          <button
            onClick={() => refetch()}
            className="ml-3 shrink-0 rounded bg-amber-100 px-3 py-1 text-sm text-amber-800 hover:bg-amber-200"
          >
            Retry
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value as InventoryStatus | ''); setPage(1); }}
            className="rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
          >
            <option value="">All Statuses</option>
            <option value="AVAILABLE">Available</option>
            <option value="LOW_STOCK">Low Stock</option>
            <option value="OUT_OF_STOCK">Out of Stock</option>
            <option value="EXPIRED">Expired</option>
            <option value="QUARANTINE">Quarantine</option>
          </select>
        </div>
        <button
          onClick={handleAdd}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-green-600 hover:bg-green-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
        >
          <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Inventory
        </button>
      </div>

      {/* Inventory Table */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Feed</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Site</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Qty (kg)</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Min Stock</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Lot #</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Expiry</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Price/kg</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Total Value</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Location</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {data?.items?.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center text-gray-500">
                    No inventory records found. Click "Add Inventory" to add feed stock.
                  </td>
                </tr>
              )}
              {data?.items?.map((inv) => {
                const statusCfg = statusConfig[inv.status] || statusConfig.AVAILABLE;
                return (
                  <tr key={inv.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
                      {feedMap[inv.feedId] || inv.feedId.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                      {siteMap[inv.siteId] || inv.siteId.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900 font-medium">
                      {Number(inv.quantityKg).toFixed(1)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-500">
                      {Number(inv.minStockKg).toFixed(1)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusCfg.className}`}>
                        {statusCfg.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                      {inv.lotNumber || '-'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm">
                      <span className={inv.daysUntilExpiry != null && inv.daysUntilExpiry <= 7 ? 'text-red-600 font-medium' : 'text-gray-500'}>
                        {formatDate(inv.expiryDate)}
                        {inv.daysUntilExpiry != null && inv.daysUntilExpiry > 0 && (
                          <span className="ml-1 text-xs">({inv.daysUntilExpiry}d)</span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-500">
                      {inv.unitPricePerKg ? `${Number(inv.unitPricePerKg).toFixed(2)}` : '-'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                      {inv.totalValue ? `${Number(inv.totalValue).toFixed(0)} ${inv.currency || 'NOK'}` : '-'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                      {inv.storageLocation || '-'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-right text-sm space-x-2">
                      <button
                        onClick={() => handleConsume(inv)}
                        className="text-orange-600 hover:text-orange-900"
                        title="Consume from this inventory"
                      >
                        Consume
                      </button>
                      <button
                        onClick={() => handleAdjust(inv)}
                        className="text-blue-600 hover:text-blue-900"
                        title="Adjust this inventory"
                      >
                        Adjust
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data && data.total > 20 && (
          <div className="bg-white px-4 py-3 flex items-center justify-between border-t border-gray-200">
            <div className="text-sm text-gray-700">
              Showing {((page - 1) * 20) + 1} to {Math.min(page * 20, data.total)} of {data.total} records
            </div>
            <div className="flex space-x-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 border border-gray-300 rounded-md text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={!data.hasNextPage}
                className="px-3 py-1 border border-gray-300 rounded-md text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {modalType === 'add' && (
        <AddInventoryModal
          feeds={feeds?.items ?? []}
          sites={sites}
          defaultSiteId={siteId}
          onSubmit={handleAddSubmit}
          onClose={() => setModalType(null)}
          isSubmitting={addMutation.isPending}
          error={addMutation.error}
        />
      )}
      {modalType === 'consume' && selectedInventory && (
        <ConsumeInventoryModal
          inventory={selectedInventory}
          feedName={feedMap[selectedInventory.feedId] || selectedInventory.feedId}
          onSubmit={handleConsumeSubmit}
          onClose={() => { setModalType(null); setSelectedInventory(null); }}
          isSubmitting={consumeMutation.isPending}
          error={consumeMutation.error}
        />
      )}
      {modalType === 'adjust' && selectedInventory && (
        <AdjustInventoryModal
          inventory={selectedInventory}
          feedName={feedMap[selectedInventory.feedId] || selectedInventory.feedId}
          onSubmit={handleAdjustSubmit}
          onClose={() => { setModalType(null); setSelectedInventory(null); }}
          isSubmitting={adjustMutation.isPending}
          error={adjustMutation.error}
        />
      )}
    </div>
  );
};

// ============================================================================
// ADD INVENTORY MODAL
// ============================================================================

interface AddInventoryModalProps {
  feeds: any[];
  sites: any[];
  defaultSiteId?: string;
  onSubmit: (data: any) => void;
  onClose: () => void;
  isSubmitting: boolean;
  error: Error | null;
}

const AddInventoryModal: React.FC<AddInventoryModalProps> = ({
  feeds, sites, defaultSiteId, onSubmit, onClose, isSubmitting, error,
}) => {
  const today = new Date().toISOString().split('T')[0];
  const [formData, setFormData] = useState({
    feedId: '',
    siteId: defaultSiteId || '',
    quantityKg: '',
    lotNumber: '',
    manufacturingDate: '',
    expiryDate: '',
    receivedDate: today,
    unitPricePerKg: '',
    currency: 'NOK',
    storageLocation: '',
    notes: '',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4">
        <div className="fixed inset-0 bg-gray-500/75" onClick={onClose} />
        <div className="relative bg-white rounded-lg shadow-xl max-w-lg w-full p-6 z-10">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">Add Feed Inventory</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
              {(error as Error).message}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Feed *</label>
                <select name="feedId" value={formData.feedId} onChange={handleChange} required
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm">
                  <option value="">Select feed...</option>
                  {feeds.map((f: any) => (
                    <option key={f.id} value={f.id}>{f.name || f.code}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Site *</label>
                <select name="siteId" value={formData.siteId} onChange={handleChange} required
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm">
                  <option value="">Select site...</option>
                  {sites.map((s: any) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Quantity (kg) *</label>
                <input type="number" name="quantityKg" value={formData.quantityKg} onChange={handleChange}
                  required step="0.1" min="0"
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Lot Number</label>
                <input type="text" name="lotNumber" value={formData.lotNumber} onChange={handleChange}
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Manufacturing Date</label>
                <input type="date" name="manufacturingDate" value={formData.manufacturingDate} onChange={handleChange}
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Expiry Date</label>
                <input type="date" name="expiryDate" value={formData.expiryDate} onChange={handleChange}
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Received Date</label>
                <input type="date" name="receivedDate" value={formData.receivedDate} onChange={handleChange}
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Unit Price per kg</label>
                <div className="flex items-center space-x-2">
                  <input type="number" name="unitPricePerKg" value={formData.unitPricePerKg} onChange={handleChange}
                    step="0.01" min="0"
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm" />
                  <select name="currency" value={formData.currency} onChange={handleChange}
                    className="block w-20 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm">
                    <option value="NOK">NOK</option>
                    <option value="EUR">EUR</option>
                    <option value="USD">USD</option>
                    <option value="TRY">TRY</option>
                  </select>
                </div>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Storage Location</label>
              <input type="text" name="storageLocation" value={formData.storageLocation} onChange={handleChange}
                placeholder="e.g., Warehouse A, Shelf B3"
                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <textarea name="notes" value={formData.notes} onChange={handleChange} rows={2}
                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm" />
            </div>
            <div className="flex justify-end space-x-3 pt-4 border-t">
              <button type="button" onClick={onClose}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50">
                Cancel
              </button>
              <button type="submit" disabled={isSubmitting}
                className="px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50">
                {isSubmitting ? 'Adding...' : 'Add Inventory'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// CONSUME INVENTORY MODAL
// ============================================================================

interface ConsumeInventoryModalProps {
  inventory: FeedInventory;
  feedName: string;
  onSubmit: (data: any) => void;
  onClose: () => void;
  isSubmitting: boolean;
  error: Error | null;
}

const ConsumeInventoryModal: React.FC<ConsumeInventoryModalProps> = ({
  inventory, feedName, onSubmit, onClose, isSubmitting, error,
}) => {
  const [formData, setFormData] = useState({
    inventoryId: inventory.id,
    quantityKg: '',
    reason: 'FEEDING' as ConsumptionReason,
    notes: '',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4">
        <div className="fixed inset-0 bg-gray-500/75" onClick={onClose} />
        <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6 z-10">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">Consume Inventory</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-sm text-blue-800">
              <span className="font-medium">{feedName}</span> - Available: <span className="font-medium">{Number(inventory.quantityKg).toFixed(1)} kg</span>
              {inventory.lotNumber && <span className="ml-2">(Lot: {inventory.lotNumber})</span>}
            </p>
          </div>

          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
              {(error as Error).message}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Quantity (kg) *</label>
              <input type="number" name="quantityKg" value={formData.quantityKg} onChange={handleChange}
                required step="0.1" min="0.1" max={inventory.quantityKg}
                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Reason</label>
              <select name="reason" value={formData.reason} onChange={handleChange}
                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm">
                <option value="FEEDING">Feeding</option>
                <option value="WASTE">Waste</option>
                <option value="EXPIRED">Expired</option>
                <option value="TRANSFER">Transfer</option>
                <option value="ADJUSTMENT">Adjustment</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <textarea name="notes" value={formData.notes} onChange={handleChange} rows={2}
                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm" />
            </div>
            <div className="flex justify-end space-x-3 pt-4 border-t">
              <button type="button" onClick={onClose}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50">
                Cancel
              </button>
              <button type="submit" disabled={isSubmitting}
                className="px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-orange-600 hover:bg-orange-700 disabled:opacity-50">
                {isSubmitting ? 'Processing...' : 'Consume'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// ADJUST INVENTORY MODAL
// ============================================================================

interface AdjustInventoryModalProps {
  inventory: FeedInventory;
  feedName: string;
  onSubmit: (data: any) => void;
  onClose: () => void;
  isSubmitting: boolean;
  error: Error | null;
}

const AdjustInventoryModal: React.FC<AdjustInventoryModalProps> = ({
  inventory, feedName, onSubmit, onClose, isSubmitting, error,
}) => {
  const [formData, setFormData] = useState({
    inventoryId: inventory.id,
    adjustmentType: 'INCREASE' as AdjustmentType,
    quantity: '',
    reason: '',
    notes: '',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4">
        <div className="fixed inset-0 bg-gray-500/75" onClick={onClose} />
        <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6 z-10">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">Adjust Inventory</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-sm text-blue-800">
              <span className="font-medium">{feedName}</span> - Current: <span className="font-medium">{Number(inventory.quantityKg).toFixed(1)} kg</span>
            </p>
          </div>

          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
              {(error as Error).message}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Adjustment Type *</label>
              <select name="adjustmentType" value={formData.adjustmentType} onChange={handleChange}
                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm">
                <option value="INCREASE">Increase</option>
                <option value="DECREASE">Decrease</option>
                <option value="SET_QUANTITY">Set Exact Quantity</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {formData.adjustmentType === 'SET_QUANTITY' ? 'New Quantity (kg) *' : 'Amount (kg) *'}
              </label>
              <input type="number" name="quantity" value={formData.quantity} onChange={handleChange}
                required step="0.1" min="0"
                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Reason *</label>
              <input type="text" name="reason" value={formData.reason} onChange={handleChange}
                required placeholder="e.g., Stock count correction, spillage"
                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <textarea name="notes" value={formData.notes} onChange={handleChange} rows={2}
                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm" />
            </div>
            <div className="flex justify-end space-x-3 pt-4 border-t">
              <button type="button" onClick={onClose}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50">
                Cancel
              </button>
              <button type="submit" disabled={isSubmitting}
                className="px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50">
                {isSubmitting ? 'Adjusting...' : 'Apply Adjustment'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
