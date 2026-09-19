/**
 * ExportSubmissionsButton (FARM-LOW-119)
 *
 * Downloads the active report tab's persisted submissions as CSV.
 * Disables itself when there is nothing to export — a dead-looking
 * button may not remain.
 */
import React from 'react';
import { Button } from '@aquaculture/shared-ui';
import {
  useRegulatoryReports,
  RegulatoryReportTypeValue,
} from '../../../hooks/useRegulatoryReports';
import { buildSubmissionsCsv, downloadCsv } from '../utils/submissionsCsv';
import { Download as DownloadIcon } from 'lucide-react';

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
    <Button
      variant="secondary"
      type="button"
      onClick={handleExport}
      disabled={rows.length === 0}
      title={rows.length === 0 ? 'No submissions to export yet' : 'Download submissions as CSV'}
    >
      <DownloadIcon className="w-4 h-4 mr-2" aria-hidden="true" />
      Export
    </Button>
  );
};

export default ExportSubmissionsButton;
