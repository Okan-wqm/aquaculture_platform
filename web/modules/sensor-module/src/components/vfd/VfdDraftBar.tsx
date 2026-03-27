/**
 * VfdDraftBar
 *
 * Sticky bottom bar showing current draft parameter changes.
 * Allows clearing the draft or opening the create change set dialog.
 */

import React from 'react';
import { FileText, Trash2, ArrowRight } from 'lucide-react';
import { useVfdProgrammingStore } from '../../store/vfdProgrammingStore';

// ============================================================================
// Component
// ============================================================================

export function VfdDraftBar() {
  const { draftItems, clearDraft, openCreateDialog, hasDraftChanges, getDraftItemCount } =
    useVfdProgrammingStore();

  const count = getDraftItemCount();

  if (!hasDraftChanges()) return null;

  return (
    <div
      className="sticky bottom-0 z-40 border-t border-indigo-200 bg-indigo-50 px-4 py-3 shadow-lg sm:px-6"
      role="status"
      aria-live="polite"
      data-testid="vfd-draft-bar"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FileText className="h-5 w-5 text-indigo-600" />
          <div>
            <p className="text-sm font-medium text-indigo-900">
              {count} change{count !== 1 ? 's' : ''} pending
            </p>
            <p className="text-xs text-indigo-600">
              {summarizeDraft(draftItems)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={clearDraft}
            className="inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
            aria-label="Clear all draft changes"
          >
            <Trash2 className="h-3.5 w-3.5" /> Clear
          </button>
          <button
            type="button"
            onClick={openCreateDialog}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
            aria-label="Review and create change set"
          >
            Review & Create Change Set <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function summarizeDraft(items: Map<string, { parameterName: string; newValue: number | string; originalValue: number | string }>): string {
  const names = Array.from(items.values()).map((i) => i.parameterName);
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
}
