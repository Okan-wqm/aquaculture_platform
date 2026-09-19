/**
 * VfdCreateChangeSetDialog
 *
 * Modal for reviewing draft items and creating a change set.
 * Includes title, description, optional scheduling, and items table.
 */

import React, { useState, useCallback } from 'react';
import { Modal, DataTable, type DataTableColumn, Spinner } from '@aquaculture/shared-ui';
import { Calendar, AlertTriangle } from 'lucide-react';
import { useVfdProgrammingStore } from '../../store/vfdProgrammingStore';

// ============================================================================
// Props
// ============================================================================

interface VfdCreateChangeSetDialogProps {
  onSubmit: (data: {
    description: string;
    scheduledAt: string | null;
    items: Array<{ parameterName: string; requestedValue: number }>;
  }) => Promise<unknown>;
}

// ============================================================================
// Component
// ============================================================================

export function VfdCreateChangeSetDialog({ onSubmit }: VfdCreateChangeSetDialogProps) {
  const { draftItems, isCreateDialogOpen, closeCreateDialog, clearDraft, draftTitle, draftDescription, setDraftTitle, setDraftDescription } =
    useVfdProgrammingStore();

  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = Array.from(draftItems.values());

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!draftDescription.trim()) {
        setError('Description is required');
        return;
      }
      if (items.length === 0) {
        setError('No parameter changes to submit');
        return;
      }

      setSubmitting(true);
      setError(null);

      try {
        await onSubmit({
          description: draftDescription.trim(),
          scheduledAt: scheduleEnabled && scheduledAt ? scheduledAt : null,
          items: items.map((item) => ({
            parameterName: item.parameterName,
            requestedValue: typeof item.newValue === 'string' ? parseFloat(item.newValue) : item.newValue,
          })),
        });
        clearDraft();
        closeCreateDialog();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create change set');
      } finally {
        setSubmitting(false);
      }
    },
    [draftDescription, items, scheduleEnabled, scheduledAt, onSubmit, clearDraft, closeCreateDialog],
  );

  if (!isCreateDialogOpen) return null;

  type PendingParameterChange = (typeof items)[number];
  const pendingParameterChangeColumns: DataTableColumn<PendingParameterChange>[] = [
    {
      key: 'parameter',
      header: 'Parameter',
      render: (_value, item) => item.parameterName,
    },
    {
      key: 'current',
      header: 'Current',
      render: (_value, item) => String(item.originalValue),
    },
    {
      key: 'new',
      header: 'New',
      render: (_value, item) => String(item.newValue),
    }
  ];

  return (
    <Modal
      isOpen={isCreateDialogOpen}
      onClose={closeCreateDialog}
      size="md"
      className="max-h-[90vh] overflow-y-auto"
      title="Create Change Set"
    >
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Description */}
          <div>
            <label htmlFor="cs-desc" className="block text-sm font-medium text-gray-700">
              Description *
            </label>
            <textarea
              id="cs-desc"
              value={draftDescription}
              onChange={(e) => setDraftDescription(e.target.value)}
              rows={3}
              placeholder="Describe the purpose of these parameter changes..."
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>

          {/* Schedule */}
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={scheduleEnabled}
                onChange={(e) => setScheduleEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-indigo-600"
              />
              <Calendar className="h-4 w-4 text-gray-400" />
              Schedule for later
            </label>
            {scheduleEnabled && (
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                aria-label="Scheduled date and time"
              />
            )}
          </div>

          {/* Items table */}
          <div>
            <h3 className="mb-2 text-sm font-medium text-gray-900">
              Parameter Changes ({items.length})
            </h3>
            <div className="max-h-48 overflow-y-auto rounded-md border border-gray-200">
              <DataTable<PendingParameterChange>
                data={items}
                columns={pendingParameterChangeColumns}
                keyExtractor={(item) => item.parameterName}
                emptyMessage="No changes"
                searchable={false}
                sortable={false}
                stickyHeader={false}
                compact
              />
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
              <AlertTriangle className="h-4 w-4" />
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 border-t pt-4">
            <button
              type="button"
              onClick={closeCreateDialog}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || items.length === 0}
              className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting && <Spinner size="sm" color="inherit" />}
              Create Change Set
            </button>
          </div>
        </form>
    </Modal>
  );
}
