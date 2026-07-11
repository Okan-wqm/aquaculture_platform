/**
 * Escape Report Tab
 * Lists fish escape incidents and provides quick-entry modal for immediate reporting
 * Shows urgency indicator for large-scale escapes per Norwegian regulatory requirements
 */
import React, { useMemo, useState } from 'react';
import { useRegulatorySettings, useSubmitEscapeReport } from '../../../hooks/useRegulatory';
import { useReportPrefill, findFieldMeta, ReportPrefill } from '../../../hooks/useReportPrefill';
import { buildRegulatoryIdentity } from '../utils/regulatoryIdentity';
import { useStableClientReference } from '../../../hooks/useStableClientReference';
import { useEffectiveReportSite } from '../hooks/useEffectiveReportSite';
import { EscapeReport } from '../types/reports.types';
import { REGULATORY_CONTACTS } from '../utils/thresholds';
import { EscapeReportModal } from '../components/modals';
import { SubmissionHistorySection } from '../components/SubmissionHistorySection';
import { ProvenanceBadge } from '../components/common';

// ============================================================================
// Types
// ============================================================================

interface EscapeReportTabProps {
  siteId?: string;
}

/** Data portion of the server-assembled escape varsling (see EscapeReportAssembler). */
interface EscapePrefillPayload {
  incidentId: string | null;
  detectedAt: string | null;
  estimatedCount: number;
  species: string;
  avgWeightG: number | null;
  totalBiomassKg: number | null;
  cause: string;
  affectedUnits: string[];
  recoveryOngoing: boolean;
}

/**
 * Review-and-approve card (RPT-009): the escape varsling assembles from the
 * recorded escape_incident. The facts render READ-ONLY with provenance —
 * corrections flow to the incident in Fish Health, never the report. Blocking
 * MANUAL_REQUIRED fields (unmapped species, missing weight) surface here so the
 * operator fixes the source before filing.
 */
export const EscapeAssembledReview: React.FC<{
  prefill?: ReportPrefill<EscapePrefillPayload>;
}> = ({ prefill }) => {
  if (!prefill) return null;
  const p = prefill.draftPayload;
  const meta = (path: string) => findFieldMeta(prefill.fields, path);

  if (!p.incidentId) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
        No open, unreported escape incident on record for this site. Record the rømming in Fish
        Health (or the mobile app) before filing the varsling — the report assembles from the
        incident, it does not invent escape facts.
      </div>
    );
  }

  const rows: Array<{ label: string; path: string; value: React.ReactNode }> = [
    { label: 'Detected at', path: '/detectedAt', value: p.detectedAt },
    { label: 'Estimated escaped count', path: '/estimatedCount', value: p.estimatedCount },
    { label: 'Species (FAO code)', path: '/species', value: p.species || '—' },
    { label: 'Average weight (g)', path: '/avgWeightG', value: p.avgWeightG ?? '—' },
    { label: 'Escaped biomass (kg)', path: '/totalBiomassKg', value: p.totalBiomassKg ?? '—' },
    { label: 'Cause', path: '/cause', value: p.cause || '—' },
    {
      label: 'Affected units',
      path: '/affectedUnits',
      value: p.affectedUnits.length > 0 ? p.affectedUnits.join(', ') : '—',
    },
  ];

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h3 className="text-sm font-medium text-gray-900 mb-1">Assembled from the recorded incident</h3>
      <p className="text-xs text-gray-500 mb-3">
        These escape facts come from the escape_incident record — read-only here; corrections go to
        Fish Health.
      </p>
      <dl className="divide-y divide-gray-100">
        {rows.map((row) => {
          const m = meta(row.path);
          return (
            <div key={row.path} className="py-2 flex items-center justify-between gap-2">
              <dt className="flex items-center gap-2 text-sm text-gray-700">
                <span>{row.label}</span>
                {m && <ProvenanceBadge meta={m} />}
              </dt>
              <dd className="text-sm font-medium text-gray-900 text-right">{row.value}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
};

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
  const clientRef = useStableClientReference();

  // The escape varsling is incident-triggered; the period is nominal (the
  // assembler reads the latest open, unreported incident for the site).
  const { effectiveSiteId } = useEffectiveReportSite(siteId);
  const prefillPeriod = useMemo(() => ({ year: new Date().getFullYear() }), []);
  const { data: prefill } = useReportPrefill<EscapePrefillPayload>(
    'ESCAPE',
    effectiveSiteId,
    prefillPeriod,
  );

  const handleCreateReport = () => {
    setIsModalOpen(true);
  };

  const handleModalSubmit = async (data: Partial<EscapeReport>): Promise<void> => {
    // Resolve the Mattilsynet identity block — throws RegulatoryConfigError if
    // the tenant is not configured. The modal surfaces the thrown message and
    // stays open (it only closes when this promise RESOLVES).
    const reportSiteId = data.siteId || siteId || 'site-001';
    const identity = buildRegulatoryIdentity(regulatorySettings, reportSiteId);

    const result = await submitEscapeReport.mutateAsync({
      klientReferanse: clientRef.get(),
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

    // FARM-HIGH-126: rotate the client reference only after a confirmed success;
    // a thrown failure above keeps it stable so the operator's retry dedups.
    clientRef.reset();
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

      {/* Server-assembled incident (review-and-approve) */}
      <EscapeAssembledReview prefill={prefill} />

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
