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
import { useFeedList, type Feed } from '../../../hooks/useFeeds';
import { isBlockingError } from '../../../utils/list-view-state';
import { Modal, useAuth, DataTable, type DataTableColumn, Spinner, Button, Input, Select, Textarea } from '@aquaculture/shared-ui';
import type { Batch } from '../../../hooks/useBatches';

// ============================================================================
// TYPES
// ============================================================================

interface FeedingRecordsTabProps {
  siteId?: string;
  batchId?: string;
  batches: readonly Batch[];
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
  const filter = useMemo<FeedingRecordFilterInput>(
    () => ({
      batchId: batchId || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    }),
    [batchId, startDate, endDate],
  );

  // Data
  const { data, isLoading, error, refetch } = useFeedingRecordsList(filter, { page, limit: 20 });
  const { data: feeds } = useFeedList();
  const createMutation = useCreateFeedingRecord();
  const updateMutation = useUpdateFeedingRecord();

  // Feed lookup
  const feedMap = useMemo(() => {
    const map: Record<string, string> = {};
    feeds?.items?.forEach((f: any) => {
      map[f.id] = f.name || f.code;
    });
    return map;
  }, [feeds]);

  // Batch lookup
  const batchMap = useMemo(() => {
    const map: Record<string, string> = {};
    batches.forEach((b) => {
      map[b.id] = b.batchNumber;
    });
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
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="xl" />
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

  type RecordRow = NonNullable<NonNullable<typeof data>['items']>[number];
  const recordRowColumns: DataTableColumn<RecordRow>[] = [
    {
      key: 'date',
      header: 'Date',
      render: (_value, record) => formatDate(record.feedingDate),
    },
    {
      key: 'batch',
      header: 'Batch',
      render: (_value, record) => batchMap[record.batchId] || record.batchId.slice(0, 8),
    },
    {
      key: 'feed',
      header: 'Feed',
      render: (_value, record) => feedMap[record.feedId] || record.feedId.slice(0, 8),
    },
    {
      key: 'time',
      header: 'Time',
      render: (_value, record) => (
        <>
          {record.feedingTime} ({record.feedingSequence}/{record.totalMealsToday})
        </>
      ),
    },
    {
      key: 'plannedKg',
      header: 'Planned (kg)',
      align: 'right',
      render: (_value, record) => Number(record.plannedAmount).toFixed(1),
    },
    {
      key: 'actualKg',
      header: 'Actual (kg)',
      align: 'right',
      render: (_value, record) => Number(record.actualAmount).toFixed(1),
    },
    {
      key: 'variance',
      header: 'Variance',
      align: 'right',
      render: (_value, record) => (
        <>
          <span
            className={`${
              record.isVarianceAcceptable
                ? 'text-green-600'
                : record.isBelowPlan
                  ? 'text-red-600'
                  : 'text-orange-600'
            }`}
          >
            {Number(record.variancePercent) > 0 ? '+' : ''}
            {Number(record.variancePercent).toFixed(1)}%
          </span>
        </>
      ),
    },
    {
      key: 'method',
      header: 'Method',
      render: (_value, record) => feedingMethodLabels[record.feedingMethod] || record.feedingMethod,
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, record) => (
        <>
          {record.isVarianceAcceptable ? (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
              OK
            </span>
          ) : (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
              Variance
            </span>
          )}
        </>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, record) => (
        <>
          <Button variant="ghost" onClick={() => handleEdit(record)}>Edit</Button>
        </>
      ),
    }
  ];

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
            <Input type="date" value={startDate} onChange={(e) => {
        setStartDate(e.target.value);
        setPage(1);
       }} placeholder="Start Date" />
            <span className="text-gray-500 dark:text-gray-400">to</span>
            <Input type="date" value={endDate} onChange={(e) => {
        setEndDate(e.target.value);
        setPage(1);
       }} placeholder="End Date" />
          </div>
        </div>
        <Button variant="primary" onClick={handleCreate}><svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Record</Button>
      </div>

      {/* Records Table */}
      <div className="bg-white dark:bg-gray-900 shadow rounded-lg overflow-hidden">
        <DataTable<RecordRow>
          data={data?.items ?? []}
          columns={recordRowColumns}
          keyExtractor={(record) => record.id}
          emptyMessage="No records found"
          searchable={false}
          sortable={false}
          stickyHeader={false}
        />

        {/* Pagination */}
        {data && data.total > 20 && (
          <div className="bg-white dark:bg-gray-900 px-4 py-3 flex items-center justify-between border-t border-gray-200 dark:border-gray-700">
            <div className="text-sm text-gray-700 dark:text-gray-300">
              Showing {(page - 1) * 20 + 1} to {Math.min(page * 20, data.total)} of {data.total}{' '}
              records
            </div>
            <div className="flex space-x-2">
              <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>Previous</Button>
              <Button variant="secondary" size="sm" onClick={() => setPage((p) => p + 1)} disabled={!data.hasNextPage}>Next</Button>
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
          onClose={() => {
            setShowForm(false);
            setEditingRecord(null);
          }}
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
  batches: readonly Batch[];
  feeds: readonly Feed[];
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

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
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
      feedingDurationMinutes: formData.feedingDurationMinutes
        ? Number(formData.feedingDurationMinutes)
        : undefined,
      feedCost: formData.feedCost ? Number(formData.feedCost) : undefined,
    });
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isEdit ? 'Edit Feeding Record' : 'New Feeding Record'}
      size="lg"
    >
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
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Batch *</label>
              <select
                name="batchId"
                value={formData.batchId}
                onChange={handleChange}
                required
                className="block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              >
                <option value="">Select batch...</option>
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.batchNumber} - {b.name || 'Unnamed'}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Feed */}
          {!isEdit && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Feed *</label>
              <select
                name="feedId"
                value={formData.feedId}
                onChange={handleChange}
                required
                className="block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              >
                <option value="">Select feed...</option>
                {feeds.map((f: any) => (
                  <option key={f.id} value={f.id}>
                    {f.name || f.code}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Date */}
          {!isEdit && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Feeding Date *</label>
              <Input fullWidth type="date" name="feedingDate" value={formData.feedingDate} onChange={handleChange} required />
            </div>
          )}

          {/* Time */}
          {!isEdit && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Feeding Time *</label>
              <Input fullWidth type="time" name="feedingTime" value={formData.feedingTime} onChange={handleChange} required />
            </div>
          )}

          {/* Sequence */}
          {!isEdit && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Meal #</label>
              <div className="flex items-center space-x-2">
                <Input type="number" name="feedingSequence" value={formData.feedingSequence} onChange={handleChange} min={1} />
                <span className="text-gray-500 dark:text-gray-400">of</span>
                <Input type="number" name="totalMealsToday" value={formData.totalMealsToday} onChange={handleChange} min={1} />
              </div>
            </div>
          )}

          {/* Method */}
          {!isEdit && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Method</label>
              <Select fullWidth options={[{ value: 'MANUAL', label: 'Manual' }, { value: 'AUTOMATIC', label: 'Automatic' }, { value: 'DEMAND', label: 'Demand' }, { value: 'BROADCAST', label: 'Broadcast' }, { value: 'SPOT', label: 'Spot' }]} name="feedingMethod" value={formData.feedingMethod} onChange={handleChange} />
            </div>
          )}

          {/* Planned Amount */}
          {!isEdit && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Planned Amount (kg) *
              </label>
              <Input fullWidth type="number" name="plannedAmount" value={formData.plannedAmount} onChange={handleChange} required step="0.1" min="0" />
            </div>
          )}

          {/* Actual Amount */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Actual Amount (kg) *
            </label>
            <Input fullWidth type="number" name="actualAmount" value={formData.actualAmount} onChange={handleChange} required step="0.1" min="0" />
          </div>

          {/* Waste Amount */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Waste Amount (kg)
            </label>
            <Input fullWidth type="number" name="wasteAmount" value={formData.wasteAmount} onChange={handleChange} step="0.1" min="0" />
          </div>

          {/* Feed Cost */}
          {!isEdit && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Feed Cost</label>
              <div className="flex items-center space-x-2">
                <Input fullWidth type="number" name="feedCost" value={formData.feedCost} onChange={handleChange} step="0.01" min="0" />
                <Select options={[{ value: 'NOK', label: 'NOK' }, { value: 'EUR', label: 'EUR' }, { value: 'USD', label: 'USD' }, { value: 'TRY', label: 'TRY' }]} name="currency" value={formData.currency} onChange={handleChange} />
              </div>
            </div>
          )}
        </div>

        {/* Notes */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
          <Textarea fullWidth name="notes" value={formData.notes} onChange={handleChange} rows={2} placeholder="Optional notes..." />
        </div>

        {/* Actions */}
        <div className="flex justify-end space-x-3 pt-4 border-t">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Saving...' : isEdit ? 'Update Record' : 'Create Record'}</Button>
        </div>
      </form>
    </Modal>
  );
};
