/**
 * ExportSubmissionsButton (FARM-LOW-119)
 *
 * Downloads the active report tab's persisted submissions as CSV.
 * Disables itself when there is nothing to export — a dead-looking
 * button may not remain.
 */
import React from 'react';
import {
  useRegulatoryReports,
  RegulatoryReportTypeValue,
} from '../../../hooks/useRegulatoryReports';
import { buildSubmissionsCsv, downloadCsv } from '../utils/submissionsCsv';

export interface ExportSubmissionsButtonProps {
  /** One or two report types backing the active tab (slaughter has two). */
  primaryType: RegulatoryReportTypeValue;
  secondaryType?: RegulatoryReportTypeValue;
  filename: string;
}

export const ExportSubmissionsButton: React.FC<ExportSubmissionsButtonProps> = ({
  primaryType,
  secondaryType,
  filename,
}) => {
  const primary = useRegulatoryReports(primaryType);
  // Hooks must be called unconditionally — fall back to the primary type
  // and ignore the duplicate result below when no secondary type exists.
  const secondary = useRegulatoryReports(secondaryType ?? primaryType);

  const rows = secondaryType
    ? [...(primary.data ?? []), ...(secondary.data ?? [])]
    : (primary.data ?? []);

  const handleExport = (): void => {
    downloadCsv(filename, buildSubmissionsCsv(rows));
  };

  return (
    <button
      type="button"
      onClick={handleExport}
      disabled={rows.length === 0}
      title={rows.length === 0 ? 'No submissions to export yet' : 'Download submissions as CSV'}
      className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
        />
      </svg>
      Export
    </button>
  );
};

export default ExportSubmissionsButton;
