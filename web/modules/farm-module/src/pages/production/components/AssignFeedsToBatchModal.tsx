/**
 * AssignFeedsToBatchModal
 *
 * Maps feed products to fish-weight ranges for the given batch. The
 * backend `assignFeedsToBatch` upsert covers both create and update
 * paths — if an active assignment already exists for the batch it
 * is overwritten. The caller can load the existing mapping via
 * `useBatchFeedAssignment(batchId)` and pass it as `existing` so the
 * modal opens with the current ranges prefilled.
 *
 * Client-side validation guarantees:
 *   - at least one entry
 *   - min < max for every entry
 *   - non-negative min weight
 *
 * Overlap/gap validation is deferred to the backend since the
 * priority field can legitimately disambiguate overlaps.
 *
 * Phase 3 Tier 1 of the "Farm modülü kalan kör noktalar" plan.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Button, useToast } from '@aquaculture/shared-ui';

import {
  BatchFeedAssignment,
  FeedAssignmentEntry,
  useAssignFeedsToBatch,
} from '../../../hooks/useBatchFeedAssignments';
import { FeedStatus, useFeedList } from '../../../hooks/useFeeds';

interface AssignFeedsToBatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  batchId: string;
  batchNumber: string;
  existing?: BatchFeedAssignment | null;
  onSuccess?: () => void;
}

interface FormEntry {
  key: string;
  feedId: string;
  minWeightG: number;
  maxWeightG: number;
  priority: number;
}

let keyCounter = 0;
const nextKey = () => `row-${++keyCounter}`;

function toFormEntries(existing?: BatchFeedAssignment | null): FormEntry[] {
  if (!existing?.feedAssignments?.length) {
    return [
      {
        key: nextKey(),
        feedId: '',
        minWeightG: 0,
        maxWeightG: 0,
        priority: 1,
      },
    ];
  }
  return existing.feedAssignments.map((entry) => ({
    key: nextKey(),
    feedId: entry.feedId,
    minWeightG: entry.minWeightG,
    maxWeightG: entry.maxWeightG,
    priority: entry.priority ?? 1,
  }));
}

export const AssignFeedsToBatchModal: React.FC<AssignFeedsToBatchModalProps> = ({
  isOpen,
  onClose,
  batchId,
  batchNumber,
  existing,
  onSuccess,
}) => {
  const feedList = useFeedList({ status: FeedStatus.AVAILABLE });
  const assign = useAssignFeedsToBatch();
  const { toast } = useToast();

  const [entries, setEntries] = useState<FormEntry[]>(toFormEntries(existing));
  const [notes, setNotes] = useState<string>(existing?.notes ?? '');

  useEffect(() => {
    setEntries(toFormEntries(existing));
    setNotes(existing?.notes ?? '');
  }, [existing, isOpen]);

  const errors = useMemo(() => {
    const errs: string[] = [];
    if (entries.length === 0) {
      errs.push('At least one feed assignment is required.');
      return errs;
    }
    entries.forEach((entry, index) => {
      const label = `Row ${index + 1}`;
      if (!entry.feedId) {
        errs.push(`${label}: choose a feed product.`);
      }
      if (entry.minWeightG < 0) {
        errs.push(`${label}: min weight cannot be negative.`);
      }
      if (entry.maxWeightG <= entry.minWeightG) {
        errs.push(`${label}: max weight must be greater than min weight.`);
      }
      if (entry.priority < 1 || entry.priority > 100) {
        errs.push(`${label}: priority must be between 1 and 100.`);
      }
    });
    return errs;
  }, [entries]);

  const isValid = errors.length === 0;

  const setField = <K extends keyof FormEntry>(
    idx: number,
    field: K,
    value: FormEntry[K],
  ) => {
    setEntries((prev) =>
      prev.map((entry, i) => (i === idx ? { ...entry, [field]: value } : entry)),
    );
  };

  const addRow = () => {
    const lastMax = entries.length
      ? entries[entries.length - 1].maxWeightG
      : 0;
    setEntries((prev) => [
      ...prev,
      {
        key: nextKey(),
        feedId: '',
        minWeightG: lastMax,
        maxWeightG: lastMax + 100,
        priority: 1,
      },
    ]);
  };

  const removeRow = (idx: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async () => {
    if (!isValid) return;
    try {
      const feedAssignments: FeedAssignmentEntry[] = entries.map((entry) => {
        const feed = feedList.data?.items.find((f) => f.id === entry.feedId);
        return {
          feedId: entry.feedId,
          feedCode: feed?.code ?? '',
          feedName: feed?.name ?? '',
          minWeightG: entry.minWeightG,
          maxWeightG: entry.maxWeightG,
          priority: entry.priority,
        };
      });
      await assign.mutateAsync({
        batchId,
        feedAssignments,
        notes: notes.trim() || undefined,
      });
      toast({
        title: 'Feed assignment saved',
        description: `${feedAssignments.length} range(s) assigned to batch ${batchNumber}.`,
        variant: 'success',
      });
      onSuccess?.();
      onClose();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to assign feeds to batch.';
      toast({ title: 'Error', description: message, variant: 'error' });
    }
  };

  const handleClose = () => {
    setEntries(toFormEntries(existing));
    setNotes(existing?.notes ?? '');
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Assign Feeds to Batch"
      size="lg"
    >
      <div className="space-y-6">
        <div className="bg-gray-50 rounded-lg p-4">
          <p className="text-sm text-gray-500">Batch</p>
          <p className="font-medium text-gray-900">{batchNumber}</p>
          <p className="text-xs text-gray-500 mt-1">
            Every row maps a fish weight range (min–max g) to a feed product.
            The active feed for a given fish is the row whose range covers the
            current average weight; overlapping ranges are disambiguated by
            priority (1 = highest).
          </p>
        </div>

        <div className="space-y-3">
          {entries.map((entry, idx) => (
            <div
              key={entry.key}
              className="border border-gray-200 rounded-lg p-3 grid grid-cols-12 gap-2 items-end"
            >
              <div className="col-span-5">
                <label
                  htmlFor={`feed-${entry.key}`}
                  className="block text-xs text-gray-600 mb-1"
                >
                  Feed
                </label>
                <select
                  id={`feed-${entry.key}`}
                  value={entry.feedId}
                  onChange={(e) => setField(idx, 'feedId', e.target.value)}
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
                >
                  <option value="">— Choose a feed —</option>
                  {feedList.data?.items.map((feed) => (
                    <option key={feed.id} value={feed.id}>
                      {feed.code} — {feed.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="col-span-2">
                <label
                  htmlFor={`min-${entry.key}`}
                  className="block text-xs text-gray-600 mb-1"
                >
                  Min (g)
                </label>
                <input
                  id={`min-${entry.key}`}
                  type="number"
                  min={0}
                  step="0.1"
                  value={entry.minWeightG || ''}
                  onChange={(e) =>
                    setField(idx, 'minWeightG', parseFloat(e.target.value) || 0)
                  }
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
                />
              </div>

              <div className="col-span-2">
                <label
                  htmlFor={`max-${entry.key}`}
                  className="block text-xs text-gray-600 mb-1"
                >
                  Max (g)
                </label>
                <input
                  id={`max-${entry.key}`}
                  type="number"
                  min={0}
                  step="0.1"
                  value={entry.maxWeightG || ''}
                  onChange={(e) =>
                    setField(idx, 'maxWeightG', parseFloat(e.target.value) || 0)
                  }
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
                />
              </div>

              <div className="col-span-2">
                <label
                  htmlFor={`prio-${entry.key}`}
                  className="block text-xs text-gray-600 mb-1"
                >
                  Priority
                </label>
                <input
                  id={`prio-${entry.key}`}
                  type="number"
                  min={1}
                  max={100}
                  value={entry.priority || ''}
                  onChange={(e) =>
                    setField(idx, 'priority', parseInt(e.target.value, 10) || 1)
                  }
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
                />
              </div>

              <div className="col-span-1 flex justify-end">
                <button
                  type="button"
                  onClick={() => removeRow(idx)}
                  disabled={entries.length <= 1}
                  className="text-sm text-red-600 hover:text-red-800 disabled:text-gray-400"
                  aria-label={`Remove row ${idx + 1}`}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={addRow}
            className="text-sm text-orange-600 hover:text-orange-800 font-medium"
          >
            + Add another range
          </button>
        </div>

        <div>
          <label htmlFor="feed-assign-notes" className="block text-sm font-medium text-gray-700">
            Notes (optional)
          </label>
          <textarea
            id="feed-assign-notes"
            rows={2}
            maxLength={2000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
          />
        </div>

        {errors.length > 0 && (
          <div className="bg-orange-50 border border-orange-200 rounded-lg p-3">
            <ul className="list-disc list-inside text-sm text-orange-600 space-y-1">
              {errors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-4 border-t">
          <Button variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!isValid || assign.isPending}
            className="bg-orange-600 hover:bg-orange-700"
          >
            {assign.isPending ? 'Saving…' : 'Save feed assignment'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default AssignFeedsToBatchModal;
