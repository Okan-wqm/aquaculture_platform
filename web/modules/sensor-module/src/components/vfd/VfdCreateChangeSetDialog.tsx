/**
 * VfdCreateChangeSetDialog
 *
 * Modal for reviewing draft items and creating a change set.
 * Includes title, description, optional scheduling, and items table.
 */

import React, { useState, useCallback } from 'react';
import { X, Calendar, AlertTriangle, Loader2 } from 'lucide-react';
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Create change set"
    >
      <div className="absolute inset-0 bg-black/30" onClick={closeCreateDialog} aria-hidden="true" />
      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Create Change Set</h2>
          <button
            type="button"
            onClick={closeCreateDialog}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close dialog"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

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
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50">
                  <tr className="text-left text-gray-500">
                    <th className="px-3 py-2">Parameter</th>
                    <th className="px-3 py-2">Current</th>
                    <th className="px-3 py-2">New</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.parameterName} className="border-t border-gray-100">
                      <td className="px-3 py-1.5 font-mono font-medium">{item.parameterName}</td>
                      <td className="px-3 py-1.5 text-gray-600">{String(item.originalValue)}</td>
                      <td className="px-3 py-1.5 font-medium text-indigo-700">{String(item.newValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Create Change Set
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
