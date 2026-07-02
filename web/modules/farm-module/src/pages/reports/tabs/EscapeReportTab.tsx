/**
 * Escape Report Tab
 * Lists fish escape incidents and provides quick-entry modal for immediate reporting
 * Shows urgency indicator for large-scale escapes per Norwegian regulatory requirements
 */
import React, { useState } from 'react';
import { useRegulatorySettings, useSubmitEscapeReport } from '../../../hooks/useRegulatory';
import { buildVarslingIdentity } from '../utils/varslingIdentity';
import { EscapeReport } from '../types/reports.types';
import { REGULATORY_CONTACTS } from '../utils/thresholds';
import { EscapeReportModal } from '../components/modals';
import { SubmissionHistorySection } from '../components/SubmissionHistorySection';

// ============================================================================
// Types
// ============================================================================

interface EscapeReportTabProps {
  siteId?: string;
}

// ============================================================================
// Escape Info Component
// ============================================================================

const EscapeInfoPanel: React.FC<{ onCreateReport: () => void }> = ({ onCreateReport }) => (
  <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
    <div className="flex">
      <div className="flex-shrink-0">
        <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
            clipRule="evenodd"
          />
        </svg>
      </div>
      <div className="ml-3 flex-1">
        <h3 className="text-sm font-medium text-red-800">Escape Reporting Requirements</h3>
        <div className="mt-2 text-sm text-red-700">
          <p>Norwegian regulations require immediate reporting of fish escapes:</p>
          <ul className="list-disc list-inside mt-1 space-y-1">
            <li>Report immediately upon detection</li>
            <li>Document estimated number and species</li>
            <li>Identify cause and affected units</li>
            <li>Initiate recovery efforts</li>
            <li>Assess environmental impact on wild populations</li>
          </ul>
        </div>
        <div className="mt-3">
          <button
            type="button"
            onClick={onCreateReport}
            className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-red-700 bg-red-100 hover:bg-red-200 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
          >
            Report Escape Incident
          </button>
        </div>
      </div>
    </div>
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

export const EscapeReportTab: React.FC<EscapeReportTabProps> = ({ siteId }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Regulatory settings supply the Mattilsynet identity block; the mutation
  // dispatches the immediate escape varsling via the backend.
  const { data: regulatorySettings } = useRegulatorySettings();
  const submitEscapeReport = useSubmitEscapeReport();

  const handleCreateReport = () => {
    setIsModalOpen(true);
  };

  const handleModalSubmit = async (data: Partial<EscapeReport>): Promise<void> => {
    // Resolve the Mattilsynet identity block — throws VarslingConfigError if
    // the tenant is not configured. The modal surfaces the thrown message and
    // stays open (it only closes when this promise RESOLVES).
    const reportSiteId = data.siteId || siteId || 'site-001';
    const identity = buildVarslingIdentity(regulatorySettings, reportSiteId);

    const result = await submitEscapeReport.mutateAsync({
      klientReferanse: crypto.randomUUID(),
      organisasjonsnummer: identity.organisasjonsnummer,
      lokalitetsnummer: identity.lokalitetsnummer,
      siteId: reportSiteId,
      siteName: data.siteName || 'Unknown site',
      kontaktperson: identity.kontaktperson,
      siteManagerEmail: identity.siteManagerEmail,
      detectedAt: (data.detectedAt ?? new Date()).toISOString(),
      reportedBy: identity.kontaktperson.navn,
      estimatedCount: data.escape?.estimatedCount ?? 0,
      species: data.escape?.species ?? 'Unknown',
      avgWeightG: data.escape?.avgWeightG ?? 0,
      totalBiomassKg: data.escape?.totalBiomassKg ?? 0,
      cause: data.escape?.cause ?? 'unknown',
      affectedUnits: data.affectedUnits?.map((u) => u.unitName) ?? [],
      recoveryOngoing: data.recovery?.ongoingEfforts ?? false,
    });

    // Surface a backend failure as an error so the modal stays open and shows
    // it — NEVER fake success.
    if (!result.success) {
      throw new Error(
        result.feilmelding || 'Mattilsynet rejected the escape report. Please review and retry.',
      );
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-gray-900">Escape Reports</h2>
          <p className="mt-1 text-sm text-gray-500">
            Immediate reporting required for fish escapes to {REGULATORY_CONTACTS.MATTILSYNET_EMAIL}
          </p>
        </div>
        <button
          type="button"
          onClick={handleCreateReport}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
        >
          <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Report Escape
        </button>
      </div>

      {/* Escape Info */}
      <EscapeInfoPanel onCreateReport={handleCreateReport} />

      {/* Submission History */}
      <SubmissionHistorySection reportType="ESCAPE" siteId={siteId} />

      {/* Modal */}
      <EscapeReportModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
        }}
        onSubmit={handleModalSubmit}
        siteId={siteId || 'site-001'}
        siteName="Default Site"
      />
    </div>
  );
};

export default EscapeReportTab;
