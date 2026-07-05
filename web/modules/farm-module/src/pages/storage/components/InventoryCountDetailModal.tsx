/**
 * Inventory Count Detail Modal
 *
 * Serves three distinct modes based on the count's lifecycle status:
 *
 * 1. COUNTING MODE (PLANNED / IN_PROGRESS):
 *    Counter enters actual quantities per item. Supports incremental saves
 *    so work is not lost if the session is interrupted. Once all items are
 *    counted, the counter can submit for supervisor review.
 *
 * 2. REVIEW/APPROVE MODE (COMPLETED):
 *    Supervisor reviews variances and either approves (triggering automatic
 *    stock adjustments) or sends back for recount. Shows warning when
 *    total variance exceeds the configurable threshold.
 *
 * 3. VIEW MODE (APPROVED):
 *    Read-only audit trail. Shows who counted, who approved, and all
 *    variance details for compliance record-keeping.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Modal, useToast, useAuth } from '@aquaculture/shared-ui';
import {
  useInventoryCount,
  useUpdateInventoryCountItems,
  useSubmitInventoryCount,
  useApproveInventoryCount,
  InventoryCountStatus,
  InventoryCountItem,
} from '../../../hooks/useInventoryCounts';

/**
 * Variance threshold as a percentage — items exceeding this are flagged red.
 * Aquaculture regulatory bodies (BAP/ASC) typically require investigation
 * when variance exceeds 10% of expected quantity.
 */
const VARIANCE_THRESHOLD_PERCENT = 10;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** The count ID to load details for */
  countId: string | null;
}

/** Local state for an item row — tracks user edits before save */
interface EditableItem {
  itemId: string;
  itemName: string;
  unit: string;
  lotNumber?: string;
  expectedQuantity: number;
  actualQuantity: number | null;
  notes: string;
}

/**
 * Returns a Tailwind CSS class based on variance severity.
 * Green = no variance, amber = within threshold, red = exceeds threshold.
 */
function getVarianceBadgeClass(variance: number, expectedQuantity: number): string {
  if (variance === 0) return 'bg-green-100 text-green-800';
  /* Avoid division by zero for items with zero expected quantity */
  if (expectedQuantity === 0) return 'bg-red-100 text-red-800';
  const pct = Math.abs(variance / expectedQuantity) * 100;
  if (pct <= VARIANCE_THRESHOLD_PERCENT) return 'bg-amber-100 text-amber-800';
  return 'bg-red-100 text-red-800';
}

export const InventoryCountDetailModal: React.FC<Props> = ({ isOpen, onClose, countId }) => {
  const { toast } = useToast();
  const { user } = useAuth();

  /* Fetch the full count record with items */
  const { data: count, isLoading } = useInventoryCount(countId || undefined);

  const updateItems = useUpdateInventoryCountItems();
  const submitCount = useSubmitInventoryCount();
  const approveCount = useApproveInventoryCount();

  /* Local editable state for item quantities — only used in counting mode */
  const [editableItems, setEditableItems] = useState<EditableItem[]>([]);

  /**
   * Sync server data into local editable state whenever the count loads or updates.
   * This ensures the form always reflects the latest saved data.
   */
  useEffect(() => {
    if (count?.items) {
      setEditableItems(
        count.items.map((item: InventoryCountItem) => ({
          itemId: item.itemId,
          itemName: item.itemName,
          unit: item.unit,
          lotNumber: item.lotNumber,
          expectedQuantity: item.expectedQuantity,
          actualQuantity: item.actualQuantity ?? null,
          notes: item.notes || '',
        })),
      );
    }
  }, [count]);

  const isCountingMode =
    count?.status === InventoryCountStatus.PLANNED ||
    count?.status === InventoryCountStatus.IN_PROGRESS;
  const isReviewMode = count?.status === InventoryCountStatus.COMPLETED;
  const isViewMode = count?.status === InventoryCountStatus.APPROVED;

  /**
   * Segregation of duties: the person who performed the count should not
   * approve it. This is a fundamental internal control for inventory management.
   */
  const canApprove = isReviewMode && user?.id !== count?.performedBy;

  /** Update a single item's actual quantity in local state */
  const handleQuantityChange = useCallback((itemId: string, value: string) => {
    setEditableItems((prev) =>
      prev.map((item) =>
        item.itemId === itemId
          ? { ...item, actualQuantity: value === '' ? null : parseFloat(value) }
          : item,
      ),
    );
  }, []);

  /** Update a single item's notes in local state */
  const handleNotesChange = useCallback((itemId: string, value: string) => {
    setEditableItems((prev) =>
      prev.map((item) => (item.itemId === itemId ? { ...item, notes: value } : item)),
    );
  }, []);

  /** Calculate variance for display — matches backend calculation logic */
  const getVariance = useCallback((item: EditableItem): number | null => {
    if (item.actualQuantity === null) return null;
    return item.actualQuantity - item.expectedQuantity;
  }, []);

  /** Aggregate variance across all counted items */
  const totalVariance = useMemo(() => {
    return editableItems.reduce((sum, item) => {
      const v = getVariance(item);
      return sum + (v ?? 0);
    }, 0);
  }, [editableItems, getVariance]);

  /** Count how many items still need to be counted */
  const uncountedItems = useMemo(() => {
    return editableItems.filter((item) => item.actualQuantity === null).length;
  }, [editableItems]);

  /** Save current quantities without submitting — allows resume later */
  const handleSaveProgress = async () => {
    if (!count) return;

    const itemsToSave = editableItems
      .filter((item) => item.actualQuantity !== null)
      .map((item) => ({
        itemId: item.itemId,
        actualQuantity: item.actualQuantity as number,
        notes: item.notes || undefined,
      }));

    if (itemsToSave.length === 0) {
      toast({
        title: 'Nothing to Save',
        description: 'Please enter at least one actual quantity before saving.',
        variant: 'error',
      });
      return;
    }

    try {
      await updateItems.mutateAsync({
        countId: count.id,
        items: itemsToSave,
      });
      toast({
        title: 'Progress Saved',
        description: `${itemsToSave.length} item(s) saved. ${uncountedItems} remaining.`,
        variant: 'success',
      });
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to save count items:', err);
      toast({
        title: 'Error',
        description: 'Failed to save count progress. Please try again.',
        variant: 'error',
      });
    }
  };

  /** Submit the count for supervisor approval — saves first, then transitions status */
  const handleSubmit = async () => {
    if (!count) return;

    /* All items must be counted before submission */
    if (uncountedItems > 0) {
      toast({
        title: 'Incomplete Count',
        description: `${uncountedItems} item(s) have not been counted yet. Please count all items before submitting.`,
        variant: 'error',
      });
      return;
    }

    try {
      /* Save latest quantities before transitioning status */
      const itemsToSave = editableItems.map((item) => ({
        itemId: item.itemId,
        actualQuantity: item.actualQuantity as number,
        notes: item.notes || undefined,
      }));

      await updateItems.mutateAsync({
        countId: count.id,
        items: itemsToSave,
      });

      await submitCount.mutateAsync(count.id);
      toast({
        title: 'Count Submitted',
        description: 'Count has been submitted for supervisor approval.',
        variant: 'success',
      });
      onClose();
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to submit count:', err);
      toast({
        title: 'Error',
        description: 'Failed to submit count. Please try again.',
        variant: 'error',
      });
    }
  };

  /** Supervisor approves the count — triggers automatic stock adjustments on backend */
  const handleApprove = async () => {
    if (!count) return;

    try {
      await approveCount.mutateAsync(count.id);
      toast({
        title: 'Count Approved',
        description: 'Inventory has been adjusted based on the count results.',
        variant: 'success',
      });
      onClose();
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to approve count:', err);
      toast({
        title: 'Error',
        description: 'Failed to approve count. Please try again.',
        variant: 'error',
      });
    }
  };

  const isBusy = updateItems.isPending || submitCount.isPending || approveCount.isPending;

  return (
    <Modal
      isOpen={isOpen && !!countId}
      onClose={onClose}
      title={isLoading ? 'Loading...' : count?.countNumber || 'Inventory Count'}
      size="xl"
    >
      <div>
        {/* Subtitle + status badge row */}
        <div className="flex justify-between items-start mb-4">
          <div>
            {count && (
              <p className="text-sm text-gray-500">
                {count.locationName}
                {count.startedAt && ` — ${new Date(count.startedAt).toLocaleDateString('nb-NO')}`}
              </p>
            )}
          </div>
          {count && (
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                count.status === InventoryCountStatus.PLANNED
                  ? 'bg-gray-100 text-gray-800'
                  : count.status === InventoryCountStatus.IN_PROGRESS
                    ? 'bg-blue-100 text-blue-800'
                    : count.status === InventoryCountStatus.COMPLETED
                      ? 'bg-green-100 text-green-800'
                      : 'bg-purple-100 text-purple-800'
              }`}
            >
              {count.status.replace('_', ' ')}
            </span>
          )}
        </div>

        {/* Count metadata */}
        {count && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm mb-4">
            <div>
              <span className="text-gray-500">Performed by:</span>
              <span className="ml-1 text-gray-900">
                {count.performedByName || count.performedBy}
              </span>
            </div>
            {count.approvedByName && (
              <div>
                <span className="text-gray-500">Approved by:</span>
                <span className="ml-1 text-gray-900">{count.approvedByName}</span>
              </div>
            )}
            {count.approvedAt && (
              <div>
                <span className="text-gray-500">Approved at:</span>
                <span className="ml-1 text-gray-900">
                  {new Date(count.approvedAt).toLocaleDateString('nb-NO')}
                </span>
              </div>
            )}
            {count.notes && (
              <div className="col-span-2">
                <span className="text-gray-500">Notes:</span>
                <span className="ml-1 text-gray-900">{count.notes}</span>
              </div>
            )}
          </div>
        )}

        {/* Variance summary — shown in review and view modes for quick assessment */}
        {(isReviewMode || isViewMode) && count && (
          <div
            className={`p-3 rounded-lg mb-4 ${
              count.totalVariance === 0
                ? 'bg-green-50 border border-green-200'
                : Math.abs(count.totalVariance) > 0
                  ? 'bg-amber-50 border border-amber-200'
                  : 'bg-gray-50 border border-gray-200'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">Total Variance</span>
              <span
                className={`text-lg font-bold ${
                  count.totalVariance === 0 ? 'text-green-700' : 'text-red-700'
                }`}
              >
                {count.totalVariance > 0 ? '+' : ''}
                {count.totalVariance}
              </span>
            </div>
            {/* Regulatory warning: large variance requires investigation documentation */}
            {isReviewMode && count.totalVariance !== 0 && (
              <p className="text-xs text-amber-700 mt-1">
                Variance detected. Approval will trigger automatic stock adjustments. Ensure
                discrepancies are documented for audit compliance.
              </p>
            )}
          </div>
        )}

        {/* Counting progress indicator — helps the counter track remaining work */}
        {isCountingMode && editableItems.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center justify-between text-sm mb-1">
              <span className="text-gray-600">
                Counted: {editableItems.length - uncountedItems} / {editableItems.length}
              </span>
              {uncountedItems > 0 && (
                <span className="text-amber-600">{uncountedItems} remaining</span>
              )}
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{
                  width: `${
                    editableItems.length > 0
                      ? ((editableItems.length - uncountedItems) / editableItems.length) * 100
                      : 0
                  }%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Loading state */}
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
          </div>
        )}

        {/* Items table — the core of the counting interface */}
        {!isLoading && editableItems.length > 0 && (
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                    Item
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                    Lot #
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">
                    Expected
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">
                    Actual
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">
                    Variance
                  </th>
                  {isCountingMode && (
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Notes
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {editableItems.map((item) => {
                  const variance = getVariance(item);
                  return (
                    <tr key={item.itemId}>
                      <td className="px-4 py-2 text-sm text-gray-900">{item.itemName}</td>
                      <td className="px-4 py-2 text-sm text-gray-500 font-mono text-xs">
                        {item.lotNumber || '-'}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-500 text-right">
                        {item.expectedQuantity} {item.unit}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {isCountingMode ? (
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={item.actualQuantity ?? ''}
                            onChange={(e) => handleQuantityChange(item.itemId, e.target.value)}
                            placeholder="0"
                            className="w-24 border border-gray-300 rounded px-2 py-1 text-sm text-right focus:ring-blue-500 focus:border-blue-500"
                          />
                        ) : (
                          <span className="text-sm text-gray-900">
                            {item.actualQuantity != null
                              ? `${item.actualQuantity} ${item.unit}`
                              : '-'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {variance !== null ? (
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${getVarianceBadgeClass(
                              variance,
                              item.expectedQuantity,
                            )}`}
                          >
                            {variance > 0 ? '+' : ''}
                            {variance}
                          </span>
                        ) : (
                          <span className="text-gray-400 text-sm">-</span>
                        )}
                      </td>
                      {isCountingMode && (
                        <td className="px-4 py-2">
                          <input
                            type="text"
                            value={item.notes}
                            onChange={(e) => handleNotesChange(item.itemId, e.target.value)}
                            placeholder="Notes..."
                            className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:ring-blue-500 focus:border-blue-500"
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-gray-50">
                <tr>
                  <td
                    className="px-4 py-2 text-sm font-medium text-gray-900"
                    colSpan={isCountingMode ? 4 : 4}
                  >
                    Total Variance
                  </td>
                  <td
                    className={`px-4 py-2 text-right text-sm font-bold ${
                      totalVariance === 0 ? 'text-green-600' : 'text-red-600'
                    }`}
                  >
                    {totalVariance > 0 ? '+' : ''}
                    {totalVariance}
                  </td>
                  {isCountingMode && <td />}
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* Empty state — shouldn't happen in normal flow, but handles edge case */}
        {!isLoading && editableItems.length === 0 && count && (
          <p className="text-sm text-gray-500 text-center py-6">
            No items found for this location. The location may have empty inventory.
          </p>
        )}
      </div>

      {/* Footer with action buttons — varies by mode */}
      <div className="mt-4 pt-4 border-t border-gray-200 flex justify-between items-center">
        <div>
          {/* Segregation of duties warning for review mode */}
          {isReviewMode && !canApprove && user?.id === count?.performedBy && (
            <p className="text-xs text-amber-600">
              You cannot approve your own count (segregation of duties).
            </p>
          )}
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 bg-white hover:bg-gray-50"
          >
            {isViewMode ? 'Close' : 'Cancel'}
          </button>

          {/* Counting mode: Save Progress + Submit */}
          {isCountingMode && (
            <>
              <button
                type="button"
                onClick={handleSaveProgress}
                disabled={isBusy}
                className="px-4 py-2 border border-blue-300 rounded-md text-sm text-blue-700 bg-blue-50 hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {updateItems.isPending ? 'Saving...' : 'Save Progress'}
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={isBusy || uncountedItems > 0}
                className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitCount.isPending ? 'Submitting...' : 'Submit Count'}
              </button>
            </>
          )}

          {/* Review mode: Approve button (only if different user) */}
          {canApprove && (
            <button
              type="button"
              onClick={handleApprove}
              disabled={isBusy}
              className="px-4 py-2 bg-green-600 text-white rounded-md text-sm hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {approveCount.isPending ? 'Approving...' : 'Approve Count'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default InventoryCountDetailModal;
