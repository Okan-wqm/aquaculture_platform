/**
 * VfdDraftBar
 *
 * Sticky bottom bar showing current draft parameter changes.
 * Allows clearing the draft or opening the create change set dialog.
 */

import React from 'react';
import { Button } from '@aquaculture/shared-ui';
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
      className="sticky bottom-0 z-40 border-t border-primary-200 dark:border-primary-800 bg-primary-50 dark:bg-primary-900/20 px-4 py-3 shadow-lg sm:px-6"
      role="status"
      aria-live="polite"
      data-testid="vfd-draft-bar"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FileText className="h-5 w-5 text-primary-600 dark:text-primary-400" />
          <div>
            <p className="text-sm font-medium text-primary-900 dark:text-primary-100">
              {count} change{count !== 1 ? 's' : ''} pending
            </p>
            <p className="text-xs text-primary-600 dark:text-primary-400">
              {summarizeDraft(draftItems)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="xs"
            leftIcon={<Trash2 className="h-3.5 w-3.5" />}
            type="button"
            onClick={clearDraft}
            aria-label="Clear all draft changes"
          >
            Clear
          </Button>
          <Button
            variant="primary"
            size="xs"
            rightIcon={<ArrowRight className="h-3.5 w-3.5" />}
            type="button"
            onClick={openCreateDialog}
            aria-label="Review and create change set"
          >
            Review & Create Change Set
          </Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function summarizeDraft(
  items: Map<
    string,
    { parameterName: string; newValue: number | string; originalValue: number | string }
  >,
): string {
  const names = Array.from(items.values()).map((i) => i.parameterName);
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
}
