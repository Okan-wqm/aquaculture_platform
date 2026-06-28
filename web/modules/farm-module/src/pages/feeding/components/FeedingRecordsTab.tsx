/**
 * Feeding Records Tab
 *
 * List of feeding records with filters, create/edit form modal.
 */
import React, { useState, useMemo } from 'react';
import {
  useFeedingRecordsList,
  useCreateFeedingRecord,
  useUpdateFeedingRecord,
  FeedingRecord,
  FeedingRecordFilterInput,
  CreateFeedingRecordInput,
  UpdateFeedingRecordInput,
  FeedingMethod,
} from '../../../hooks/useFeedingRecords';
import { useFeedList } from '../../../hooks/useFeeds';
import { isBlockingError } from '../../../utils/list-view-state';
import { useAuth } from '@aquaculture/shared-ui';
import type { Batch } from '../../../hooks/useBatches';

// ============================================================================
// TYPES
// ============================================================================

interface FeedingRecordsTabProps {
  siteId?: string;
  batchId?: string;
  batches: Batch[];
}

// ============================================================================
// FEEDING METHOD LABELS
// ============================================================================

/**
 * Feeding method labels — keyed by GraphQL enum KEYS (uppercase).
 * The backend FeedingMethod enum uses uppercase keys (MANUAL, AUTOMATIC, etc.).
 */
const feedingMethodLabels: Record<FeedingMethod, string> = {
  MANUAL: 'Manual',
  AUTOMATIC: 'Automatic',
  DEMAND: 'Demand',
  BROADCAST: 'Broadcast',
  SPOT: 'Spot',
};

// ============================================================================
// COMPONENT
// ============================================================================

export const FeedingRecordsTab: React.FC<FeedingRecordsTabProps> = ({
  siteId,
  batchId,
  batches,
}) => {
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingRecord, setEditingRecord] = useState<FeedingRecord | null>(null);

  // Build filter
  const filter = useMemo<FeedingRecordFilterInput>(() => ({
    batchId: batchId || undefined,
    startDate: startDate || undefined,
    endDate: endDate || undefined,
  }), [batchId, startDate, endDate]);

  // Data
  const { data, isLoading, error, refetch } = useFeedingRecordsList(filter, { page, limit: 20 });
  const { data: feeds } = useFeedList();
  const createMutation = useCreateFeedingRecord();
  const updateMutation = useUpdateFeedingRecord();

  // Feed lookup
  const feedMap = useMemo(() => {
    const map: Record<string, string> = {};
    feeds?.items?.forEach((f: any) => { map[f.id] = f.name || f.code; });
    return map;
  }, [feeds]);

  // Batch lookup
  const batchMap = useMemo(() => {
    const map: Record<string, string> = {};
    batches.forEach((b) => { map[b.id] = b.batchNumber; });
    return map;
  }, [batches]);

  // Handlers
  const handleCreate = () => {
    setEditingRecord(null);
    setShowForm(true);
  };

  const handleEdit = (record: FeedingRecord) => {
    setEditingRecord(record);
    setShowForm(true);
  };

  const handleFormSubmit = async (formData: any) => {
    try {
      if (editingRecord) {
        const input: UpdateFeedingRecordInput = {
          actualAmount: formData.actualAmount,
          wasteAmount: formData.wasteAmount || undefined,
          notes: formData.notes || undefined,
        };
        await updateMutation.mutateAsync({ id: editingRecord.id, input });
      } else {
        const input: CreateFeedingRecordInput = {
          batchId: formData.batchId,
          tankId: formData.tankId || undefined,
          feedingDate: formData.feedingDate,
          feedingTime: formData.feedingTime,
          feedingSequence: formData.feedingSequence || 1,
          totalMealsToday: formData.totalMealsToday || 1,
          feedId: formData.feedId,
          feedBatchNumber: formData.feedBatchNumber || undefined,
          plannedAmount: formData.plannedAmount,
          actualAmount: formData.actualAmount,
          wasteAmount: formData.wasteAmount || undefined,
          feedingMethod: formData.feedingMethod || 'MANUAL',
          feedingDurationMinutes: formData.feedingDurationMinutes || undefined,
          feedCost: formData.feedCost || undefined,
          currency: formData.currency || undefined,
          fedBy: user?.id || formData.fedBy,
          notes: formData.notes || undefined,
        };
        await createMutation.mutateAsync(input);
      }
      setShowForm(false);
      setEditingRecord(null);
    } catch (err) {
      console.error('Failed to save feeding record:', err);
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  // Blocking error state — ONLY when the initial load failed and there is no
  // cached data. A failed background refetch with cached records keeps rendering
  // the table and surfaces a non-blocking banner below (stale-on-error).
  if (isBlockingError(error, (data?.items?.length ?? 0) > 0)) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <p className="text-red-800">Failed to load feeding records: {(error as Error).message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Non-blocking refresh error — keeps the last-loaded records visible. */}
      {error && (
        <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-800">
            Couldn&apos;t refresh feeding records — showing the last loaded data.{' '}
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
          {/* Date Range */}
          <div className="flex items-center space-x-2">
            <input
              type="date"
              value={startDate}
              onChange={(e) => { setStartDate(e.target.value); setPage(1); }}
              className="rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder="Start Date"
            />
            <span className="text-gray-500">to</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => { setEndDate(e.target.value); setPage(1); }}
              className="rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder="End Date"
            />
          </div>
        </div>
        <button
          onClick={handleCreate}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
        >
          <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Record
        </button>
      </div>

      {/* Records Table */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Batch</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Feed</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Planned (kg)</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actual (kg)</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Variance</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Method</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {data?.items?.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-gray-500">
                    No feeding records found. Click "New Record" to create one.
                  </td>
                </tr>
              )}
              {data?.items?.map((record) => (
                <tr key={record.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                    {formatDate(record.feedingDate)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                    {batchMap[record.batchId] || record.batchId.slice(0, 8)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                    {feedMap[record.feedId] || record.feedId.slice(0, 8)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                    {record.feedingTime} ({record.feedingSequence}/{record.totalMealsToday})
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                    {Number(record.plannedAmount).toFixed(1)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                    {Number(record.actualAmount).toFixed(1)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-right">
                    <span className={`${
                      record.isVarianceAcceptable
                        ? 'text-green-600'
                        : record.isBelowPlan
                        ? 'text-red-600'
                        : 'text-orange-600'
                    }`}>
                      {Number(record.variancePercent) > 0 ? '+' : ''}{Number(record.variancePercent).toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                    {feedingMethodLabels[record.feedingMethod] || record.feedingMethod}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {record.isVarianceAcceptable ? (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        OK
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                        Variance
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-right text-sm">
                    <button
                      onClick={() => handleEdit(record)}
                      className="text-blue-600 hover:text-blue-900"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
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

      {/* Create/Edit Form Modal */}
      {showForm && (
        <FeedingRecordFormModal
          record={editingRecord}
          batches={batches}
          feeds={feeds?.items ?? []}
          userId={user?.id || ''}
          onSubmit={handleFormSubmit}
          onClose={() => { setShowForm(false); setEditingRecord(null); }}
          isSubmitting={createMutation.isPending || updateMutation.isPending}
          error={createMutation.error || updateMutation.error}
        />
      )}
    </div>
  );
};

// ============================================================================
// FORM MODAL
// ============================================================================

interface FeedingRecordFormModalProps {
  record: FeedingRecord | null;
  batches: Batch[];
  feeds: any[];
  userId: string;
  onSubmit: (data: any) => void;
  onClose: () => void;
  isSubmitting: boolean;
  error: Error | null;
}

const FeedingRecordFormModal: React.FC<FeedingRecordFormModalProps> = ({
  record,
  batches,
  feeds,
  userId,
  onSubmit,
  onClose,
  isSubmitting,
  error,
}) => {
  const isEdit = !!record;
  const today = new Date().toISOString().split('T')[0];

  const [formData, setFormData] = useState({
    batchId: record?.batchId || '',
    tankId: record?.tankId || '',
    feedingDate: record?.feedingDate?.split('T')[0] || today,
    feedingTime: record?.feedingTime || '08:00',
    feedingSequence: record?.feedingSequence || 1,
    totalMealsToday: record?.totalMealsToday || 1,
    feedId: record?.feedId || '',
    feedBatchNumber: record?.feedBatchNumber || '',
    plannedAmount: record?.plannedAmount || '',
    actualAmount: record?.actualAmount || '',
    wasteAmount: record?.wasteAmount || '',
    feedingMethod: record?.feedingMethod || 'MANUAL',
    feedingDurationMinutes: record?.feedingDurationMinutes || '',
    feedCost: record?.feedCost || '',
    currency: record?.currency || 'NOK',
    notes: record?.notes || '',
    fedBy: record?.fedBy || userId,
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      ...formData,
      plannedAmount: Number(formData.plannedAmount),
      actualAmount: Number(formData.actualAmount),
      wasteAmount: formData.wasteAmount ? Number(formData.wasteAmount) : undefined,
      feedingSequence: Number(formData.feedingSequence),
      totalMealsToday: Number(formData.totalMealsToday),
      feedingDurationMinutes: formData.feedingDurationMinutes ? Number(formData.feedingDurationMinutes) : undefined,
      feedCost: formData.feedCost ? Number(formData.feedCost) : undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4">
        {/* Backdrop */}
        <div className="fixed inset-0 bg-gray-500/75 transition-opacity" onClick={onClose} />

        {/* Modal */}
        <div className="relative bg-white rounded-lg shadow-xl max-w-2xl w-full p-6 z-10">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">
              {isEdit ? 'Edit Feeding Record' : 'New Feeding Record'}
            </h3>
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
              {/* Batch */}
              {!isEdit && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Batch *</label>
                  <select
                    name="batchId"
                    value={formData.batchId}
                    onChange={handleChange}
                    required
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                  >
                    <option value="">Select batch...</option>
                    {batches.map((b) => (
                      <option key={b.id} value={b.id}>{b.batchNumber} - {b.name || 'Unnamed'}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Feed */}
              {!isEdit && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Feed *</label>
                  <select
                    name="feedId"
                    value={formData.feedId}
                    onChange={handleChange}
                    required
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                  >
                    <option value="">Select feed...</option>
                    {feeds.map((f: any) => (
                      <option key={f.id} value={f.id}>{f.name || f.code}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Date */}
              {!isEdit && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Feeding Date *</label>
                  <input
                    type="date"
                    name="feedingDate"
                    value={formData.feedingDate}
                    onChange={handleChange}
                    required
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                  />
                </div>
              )}

              {/* Time */}
              {!isEdit && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Feeding Time *</label>
                  <input
                    type="time"
                    name="feedingTime"
                    value={formData.feedingTime}
                    onChange={handleChange}
                    required
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                  />
                </div>
              )}

              {/* Sequence */}
              {!isEdit && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Meal #</label>
                  <div className="flex items-center space-x-2">
                    <input
                      type="number"
                      name="feedingSequence"
                      value={formData.feedingSequence}
                      onChange={handleChange}
                      min={1}
                      className="block w-20 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                    />
                    <span className="text-gray-500">of</span>
                    <input
                      type="number"
                      name="totalMealsToday"
                      value={formData.totalMealsToday}
                      onChange={handleChange}
                      min={1}
                      className="block w-20 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                    />
                  </div>
                </div>
              )}

              {/* Method */}
              {!isEdit && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
                  <select
                    name="feedingMethod"
                    value={formData.feedingMethod}
                    onChange={handleChange}
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                  >
                    <option value="MANUAL">Manual</option>
                    <option value="AUTOMATIC">Automatic</option>
                    <option value="DEMAND">Demand</option>
                    <option value="BROADCAST">Broadcast</option>
                    <option value="SPOT">Spot</option>
                  </select>
                </div>
              )}

              {/* Planned Amount */}
              {!isEdit && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Planned Amount (kg) *</label>
                  <input
                    type="number"
                    name="plannedAmount"
                    value={formData.plannedAmount}
                    onChange={handleChange}
                    required
                    step="0.1"
                    min="0"
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                  />
                </div>
              )}

              {/* Actual Amount */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Actual Amount (kg) *</label>
                <input
                  type="number"
                  name="actualAmount"
                  value={formData.actualAmount}
                  onChange={handleChange}
                  required
                  step="0.1"
                  min="0"
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                />
              </div>

              {/* Waste Amount */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Waste Amount (kg)</label>
                <input
                  type="number"
                  name="wasteAmount"
                  value={formData.wasteAmount}
                  onChange={handleChange}
                  step="0.1"
                  min="0"
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                />
              </div>

              {/* Feed Cost */}
              {!isEdit && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Feed Cost</label>
                  <div className="flex items-center space-x-2">
                    <input
                      type="number"
                      name="feedCost"
                      value={formData.feedCost}
                      onChange={handleChange}
                      step="0.01"
                      min="0"
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                    />
                    <select
                      name="currency"
                      value={formData.currency}
                      onChange={handleChange}
                      className="block w-24 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                    >
                      <option value="NOK">NOK</option>
                      <option value="EUR">EUR</option>
                      <option value="USD">USD</option>
                      <option value="TRY">TRY</option>
                    </select>
                  </div>
                </div>
              )}
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <textarea
                name="notes"
                value={formData.notes}
                onChange={handleChange}
                rows={2}
                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                placeholder="Optional notes..."
              />
            </div>

            {/* Actions */}
            <div className="flex justify-end space-x-3 pt-4 border-t">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? 'Saving...' : isEdit ? 'Update Record' : 'Create Record'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
