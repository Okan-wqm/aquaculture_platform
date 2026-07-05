/**
 * BatchScopeSelector — combined-batch operation scoping (FARM correctness fix).
 *
 * WHY: a tank can hold more than one batch at once (a COMBINED tank, e.g.
 * B-1 + B-2). Every stock-mutating tank operation (mortality / cull / transfer /
 * grading) must be attributed to ONE specific batch — silently defaulting to the
 * primary mis-books the loss/move against the wrong batch's ledger. This control
 * lets the operator pick which batch the operation targets; the owning modal then
 * clamps every quantity / biomass / avg-weight to that batch's share.
 *
 * WHAT: a single labelled <select> styled to match the host modal's form
 * controls. It renders NOTHING for a single-batch (or empty) tank, so a
 * non-combined tank keeps behaving exactly as before — the primary batch stays
 * the implicit, correct target and no extra control appears.
 */
import React from 'react';
import { BatchDetail } from '../types/batch.types';

/** Host-modal accent so the focus ring matches (mortality=red, cull=orange, …). */
export type BatchScopeAccent = 'red' | 'orange' | 'blue' | 'purple' | 'gray';

/**
 * Full literal focus classes per accent. Kept as whole strings (not built by
 * interpolation) so Tailwind's content scanner never purges them.
 */
const ACCENT_FOCUS: Record<BatchScopeAccent, string> = {
  red: 'focus:border-red-500 focus:ring-red-500',
  orange: 'focus:border-orange-500 focus:ring-orange-500',
  blue: 'focus:border-blue-500 focus:ring-blue-500',
  purple: 'focus:border-purple-500 focus:ring-purple-500',
  gray: 'focus:border-gray-500 focus:ring-gray-500',
};

interface BatchScopeSelectorProps {
  /** Every batch currently sharing the tank; more than one entry means combined. */
  batchDetails: BatchDetail[] | undefined;
  /** batchId the operation is currently scoped to. */
  selectedBatchId: string | undefined;
  /** Invoked with the chosen batchId when the operator re-scopes the operation. */
  onChange: (batchId: string) => void;
  /** Matches the host modal's form-control accent. Defaults to neutral gray. */
  accent?: BatchScopeAccent;
}

/** e.g. `B-1 — 3,200 fish · 145 g` */
function formatBatchOption(batch: BatchDetail): string {
  const fish = batch.quantity.toLocaleString();
  const weight = Math.round(batch.avgWeightG).toLocaleString();
  return `${batch.batchNumber} — ${fish} fish · ${weight} g`;
}

export const BatchScopeSelector: React.FC<BatchScopeSelectorProps> = ({
  batchDetails,
  selectedBatchId,
  onChange,
  accent = 'gray',
}) => {
  const batches = batchDetails ?? [];

  // A single-batch (or empty) tank offers no scope choice — the primary batch is
  // the implicit, correct target — so this control adds nothing and renders null.
  if (batches.length <= 1) {
    return null;
  }

  return (
    <div>
      <label htmlFor="batch-scope" className="block text-sm font-medium text-gray-700">
        Operating on batch <span className="font-normal text-gray-400">(combined tank)</span>
      </label>
      <select
        id="batch-scope"
        value={selectedBatchId ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 block w-full rounded-md border-gray-300 shadow-sm sm:text-sm ${ACCENT_FOCUS[accent]}`}
      >
        {batches.map((batch) => (
          <option key={batch.batchId} value={batch.batchId}>
            {formatBatchOption(batch)}
          </option>
        ))}
      </select>
      <p className="mt-1 text-xs text-gray-500">
        This tank holds {batches.length} batches — the operation applies only to the selected batch.
      </p>
    </div>
  );
};

export default BatchScopeSelector;
