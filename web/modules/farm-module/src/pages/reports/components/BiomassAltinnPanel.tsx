/**
 * BiomassAltinnPanel (RPT-001, Phase 5)
 *
 * The honest biomass submission surface. The monthly biomass report is NOT
 * transmitted electronically — it is submitted to Fiskeridirektoratet MANUALLY
 * via the Altinn FD-0001 form. This panel drives the three-step state machine
 * on a persisted period report:
 *
 *   DRAFT ─ Mark ready ─▶ READY ─ Confirm with Altinn receipt ─▶ CONFIRMED_SUBMITTED
 *     ▲                     │
 *     └──── Reopen ─────────┘
 *
 * In READY it renders the FD-0001 export (downloadable CSV + printable block)
 * the operator transcribes into Altinn, then captures the Altinn receipt
 * reference that moves the report to the terminal, immutable state.
 */
import React, { useState } from 'react';
import { Button, Input } from '@aquaculture/shared-ui';

import {
  BiomassReportListRow,
  isTerminalBiomassStatus,
  useBiomassReportAltinnExport,
  useConfirmBiomassReportSubmitted,
  useMarkBiomassReportReady,
  useRevertBiomassReportToDraft,
} from '../../../hooks/useBiomassReports';

interface BiomassAltinnPanelProps {
  report: BiomassReportListRow;
}

/** Trigger a browser download of the FD-0001 CSV without leaving the page. */
function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export const BiomassAltinnPanel: React.FC<BiomassAltinnPanelProps> = ({ report }) => {
  const markReady = useMarkBiomassReportReady();
  const revertToDraft = useRevertBiomassReportToDraft();
  const confirmSubmitted = useConfirmBiomassReportSubmitted();
  const [altinnReference, setAltinnReference] = useState('');

  const isReady = report.status === 'READY';
  const { data: exportData, isLoading: exportLoading } = useBiomassReportAltinnExport(report.id, {
    enabled: isReady,
  });

  const mutationError =
    markReady.error?.message ??
    revertToDraft.error?.message ??
    confirmSubmitted.error?.message ??
    null;

  // ── Terminal: submitted via Altinn ──────────────────────────────────────
  if (isTerminalBiomassStatus(report.status)) {
    return (
      <div className="bg-success-50 dark:bg-success-900/20 border border-success-200 dark:border-success-800 rounded-lg p-4">
        <p className="text-sm font-medium text-success-800 dark:text-success-200">
          Submitted to Fiskeridirektoratet via Altinn
        </p>
        {report.altinnReference ? (
          <p className="text-xs text-success-700 dark:text-success-300 mt-1">
            Altinn receipt reference: <span className="font-mono">{report.altinnReference}</span>
          </p>
        ) : (
          <p className="text-xs text-success-700 dark:text-success-300 mt-1">
            Confirmed submitted (legacy record — no Altinn reference on file).
          </p>
        )}
      </div>
    );
  }

  // ── DRAFT: prepare for the manual Altinn submission ──────────────────────
  if (report.status === 'DRAFT') {
    return (
      <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
        <div>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Manual Altinn submission (FD-0001)
          </p>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
            This biomass report is submitted to Fiskeridirektoratet manually via Altinn. Mark it
            ready to generate the FD-0001 export you transcribe into the Altinn form.
          </p>
        </div>
        {mutationError && (
          <p className="text-xs text-error-600 dark:text-error-400">{mutationError}</p>
        )}
        <Button
          variant="primary"
          type="button"
          onClick={() => markReady.mutate(report.id)}
          disabled={markReady.isPending}
        >
          {markReady.isPending ? 'Marking ready…' : 'Mark ready for Altinn'}
        </Button>
      </div>
    );
  }

  // ── READY: export + confirm-with-receipt ─────────────────────────────────
  const trimmedReference = altinnReference.trim();
  return (
    <div className="bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded-lg p-4 space-y-4">
      <div>
        <p className="text-sm font-medium text-info-900 dark:text-info-100">
          Ready for Altinn (FD-0001)
        </p>
        <p className="text-xs text-info-700 dark:text-info-300 mt-1">
          Download or print the FD-0001 export below, transcribe the values into the Altinn form,
          submit it there, then confirm the submission with the Altinn receipt reference.
        </p>
      </div>

      {mutationError && (
        <p className="text-xs text-error-600 dark:text-error-400">{mutationError}</p>
      )}

      {/* FD-0001 export */}
      {exportLoading ? (
        <p className="text-xs text-info-700 dark:text-info-300">Generating export…</p>
      ) : exportData ? (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="xs"
              type="button"
              onClick={() => downloadCsv(exportData.filename, exportData.csv)}
            >
              Download CSV ({exportData.filename})
            </Button>
            <span className="text-xs text-info-600 dark:text-info-400">
              Period {exportData.periodLabel}
            </span>
          </div>
          <pre className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md p-3 text-xs text-gray-800 dark:text-gray-200 overflow-x-auto whitespace-pre-wrap">
            {exportData.printable}
          </pre>
        </div>
      ) : null}

      {/* Confirm-with-receipt */}
      <div className="border-t border-info-200 dark:border-info-800 pt-3 space-y-2">
        <label
          htmlFor="altinn-reference"
          className="block text-xs font-medium text-info-900 dark:text-info-100"
        >
          Altinn receipt reference
        </label>
        <div className="flex items-center gap-3">
          <Input
            id="altinn-reference"
            type="text"
            value={altinnReference}
            onChange={(e) => setAltinnReference(e.target.value)}
            placeholder="e.g. AR123456789"
          />
          <Button
            variant="primary"
            type="button"
            onClick={() =>
              confirmSubmitted.mutate({ id: report.id, altinnReference: trimmedReference })
            }
            disabled={trimmedReference === '' || confirmSubmitted.isPending}
          >
            {confirmSubmitted.isPending ? 'Confirming…' : 'Confirm submitted'}
          </Button>
        </div>
        <Button
          variant="ghost"
          size="xs"
          type="button"
          onClick={() => revertToDraft.mutate(report.id)}
          disabled={revertToDraft.isPending}
        >
          Reopen to draft
        </Button>
      </div>
    </div>
  );
};

export default BiomassAltinnPanel;
