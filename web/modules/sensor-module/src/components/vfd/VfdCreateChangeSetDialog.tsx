/**
 * VfdCreateChangeSetDialog
 *
 * Modal for reviewing draft items and creating a change set.
 * Includes title, description, optional scheduling, and items table.
 */

import React, { useState, useCallback } from 'react';
import {
  Modal,
  DataTable,
  type DataTableColumn,
  Spinner,
  Button,
  Input,
  Textarea,
} from '@aquaculture/shared-ui';
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
  const {
    draftItems,
    isCreateDialogOpen,
    closeCreateDialog,
    clearDraft,
    draftTitle,
    draftDescription,
    setDraftTitle,
    setDraftDescription,
  } = useVfdProgrammingStore();

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
            requestedValue:
              typeof item.newValue === 'string' ? parseFloat(item.newValue) : item.newValue,
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
    [
      draftDescription,
      items,
      scheduleEnabled,
      scheduledAt,
      onSubmit,
      clearDraft,
      closeCreateDialog,
    ],
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
    },
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
          <label
            htmlFor="cs-desc"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Description *
          </label>
          <Textarea
            fullWidth
            id="cs-desc"
            value={draftDescription}
            onChange={(e) => setDraftDescription(e.target.value)}
            rows={3}
            placeholder="Describe the purpose of these parameter changes..."
          />
        </div>

        {/* Schedule */}
        <div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={scheduleEnabled}
              onChange={(e) => setScheduleEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-primary-600"
            />
            <Calendar className="h-4 w-4 text-gray-400 dark:text-gray-500" />
            Schedule for later
          </label>
          {scheduleEnabled && (
            <Input
              fullWidth
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              aria-label="Scheduled date and time"
            />
          )}
        </div>

        {/* Items table */}
        <div>
          <h3 className="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">
            Parameter Changes ({items.length})
          </h3>
          <div className="max-h-48 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-700">
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
          <div
            className="flex items-center gap-2 rounded-md bg-error-50 dark:bg-error-900/20 px-3 py-2 text-xs text-error-700 dark:text-error-300"
            role="alert"
          >
            <AlertTriangle className="h-4 w-4" />
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3 border-t pt-4">
          <Button variant="secondary" type="button" onClick={closeCreateDialog}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={submitting || items.length === 0}>
            {submitting && <Spinner size="sm" color="inherit" />}
            Create Change Set
          </Button>
        </div>
      </form>
    </Modal>
  );
}
