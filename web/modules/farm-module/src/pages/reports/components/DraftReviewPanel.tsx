/**
 * DraftReviewPanel (Phase 4) — review-and-approve for a scheduled report draft.
 *
 * Renders every field the assembler produced through PrefilledField, so
 * RECORDS/SENSOR values are read-only (with provenance) and only the
 * MANUAL_REQUIRED fields are editable. The operator fills the blocking manual
 * fields and saves them as overrides (persisted against the draft); approval +
 * submission stay on the Reports-due row.
 */
import React, { useMemo, useState } from 'react';

import {
  ReportDraft,
  useReportDrafts,
  useSaveReportDraftOverrides,
} from '../../../hooks/useReportDeadlines';
import type { ReportFieldMeta } from '../../../hooks/useReportPrefill';
import { PrefilledField } from './common/PrefilledField';

interface DraftReviewPanelProps {
  draftId: string;
}

/** Read a JSON-pointer value out of the assembled payload (RFC 6901, read-only). */
function getByPointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith('/')) return undefined;
  return pointer
    .slice(1)
    .split('/')
    .reduce<unknown>((node, token) => {
      if (node && typeof node === 'object') {
        return (node as Record<string, unknown>)[token];
      }
      return undefined;
    }, root);
}

function labelFromPointer(pointer: string): string {
  return pointer.replace(/^\//, '').replace(/\//g, ' › ') || '(root)';
}

function initialOverrides(draft: ReportDraft): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [pointer, value] of Object.entries(draft.manualOverrides ?? {})) {
    out[pointer] = value == null ? '' : String(value);
  }
  return out;
}

export const DraftReviewPanel: React.FC<DraftReviewPanelProps> = ({ draftId }) => {
  const { data: drafts, isLoading } = useReportDrafts();
  const draft = useMemo(() => drafts?.find((d) => d.id === draftId), [drafts, draftId]);
  const save = useSaveReportDraftOverrides();
  const [overrides, setOverrides] = useState<Record<string, string> | null>(null);
  const [saved, setSaved] = useState(false);

  const effectiveOverrides = overrides ?? (draft ? initialOverrides(draft) : {});
  const manualFields = useMemo(
    () => (draft?.fieldMeta ?? []).filter((f) => f.provenance === 'MANUAL_REQUIRED'),
    [draft],
  );

  if (isLoading) {
    return <p className="text-sm text-gray-500 px-2 py-3">Loading draft…</p>;
  }
  if (!draft) {
    return <p className="text-sm text-gray-500 px-2 py-3">Draft is no longer available.</p>;
  }

  const setOverride = (pointer: string, value: string): void => {
    setSaved(false);
    setOverrides({ ...effectiveOverrides, [pointer]: value });
  };

  const handleSave = (): void => {
    // Only MANUAL_REQUIRED pointers are persistable overrides (the server
    // rejects RECORDS/SENSOR pointers); send exactly those the operator filled.
    const manualPaths = new Set(manualFields.map((f) => f.path));
    const payload: Record<string, unknown> = {};
    for (const [pointer, value] of Object.entries(effectiveOverrides)) {
      if (manualPaths.has(pointer) && value !== '') payload[pointer] = value;
    }
    save.mutate({ draftId, overrides: payload }, { onSuccess: () => setSaved(true) });
  };

  return (
    <div className="bg-gray-50 rounded-md border border-gray-200 px-3 py-3 mt-2">
      <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">
        Review — {draft.fieldMeta.length} field(s)
      </p>
      <div className="divide-y divide-gray-100">
        {draft.fieldMeta.map((meta: ReportFieldMeta) => (
          <PrefilledField
            key={meta.path}
            label={labelFromPointer(meta.path)}
            meta={meta}
            value={getByPointer(draft.assembledPayload, meta.path)}
            overrideValue={
              meta.provenance === 'MANUAL_REQUIRED'
                ? (effectiveOverrides[meta.path] ?? '')
                : undefined
            }
            onOverrideChange={
              meta.provenance === 'MANUAL_REQUIRED'
                ? (value) => setOverride(meta.path, value)
                : undefined
            }
            disabled={save.isPending}
          />
        ))}
      </div>

      {manualFields.length > 0 && (
        <div className="flex items-center gap-3 mt-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={save.isPending}
            className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md text-white bg-gray-700 hover:bg-gray-800 disabled:opacity-50"
          >
            Save manual values
          </button>
          {saved && <span className="text-xs text-green-700">Saved</span>}
          {save.isError && <span className="text-xs text-red-600">{save.error.message}</span>}
        </div>
      )}
    </div>
  );
};

export default DraftReviewPanel;
