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
 * WHAT: the shared-ui Select, which carries the design system's label, focus
 * ring and dark pairing. It renders NOTHING for a single-batch (or empty) tank,
 * so a non-combined tank keeps behaving exactly as before — the primary batch
 * stays the implicit, correct target and no extra control appears.
 */
import React from 'react';
import { Select } from '@aquaculture/shared-ui';
import { BatchDetail } from '../types/batch.types';

interface BatchScopeSelectorProps {
  /** Every batch currently sharing the tank; more than one entry means combined. */
  batchDetails: BatchDetail[] | undefined;
  /** batchId the operation is currently scoped to. */
  selectedBatchId: string | undefined;
  /** Invoked with the chosen batchId when the operator re-scopes the operation. */
  onChange: (batchId: string) => void;
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
}) => {
  const batches = batchDetails ?? [];

  // A single-batch (or empty) tank offers no scope choice — the primary batch is
  // the implicit, correct target — so this control adds nothing and renders null.
  if (batches.length <= 1) {
    return null;
  }

  return (
    <Select
      id="batch-scope"
      label="Operating on batch"
      value={selectedBatchId ?? ''}
      onChange={(e) => onChange(e.target.value)}
      helperText={`This tank holds ${batches.length} batches — the operation applies only to the selected batch.`}
      options={batches.map((batch) => ({
        value: batch.batchId,
        label: formatBatchOption(batch),
      }))}
    />
  );
};

export default BatchScopeSelector;
