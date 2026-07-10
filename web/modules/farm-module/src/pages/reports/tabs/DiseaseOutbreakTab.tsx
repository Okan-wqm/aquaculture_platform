/**
 * Disease Outbreak Tab
 * Lists disease outbreaks and provides quick-entry modal for immediate reporting
 * Connected to Health Events system with tank context and urgency indicators
 */
import React, { useMemo, useState } from 'react';
import { useRegulatorySettings, useSubmitDiseaseOutbreak } from '../../../hooks/useRegulatory';
import { useReportPrefill, findFieldMeta, ReportPrefill } from '../../../hooks/useReportPrefill';
import { buildRegulatoryIdentity } from '../utils/regulatoryIdentity';
import { useStableClientReference } from '../../../hooks/useStableClientReference';
import { useEffectiveReportSite } from '../hooks/useEffectiveReportSite';
import { DiseaseOutbreakReport } from '../types/reports.types';
import { REGULATORY_CONTACTS, DISEASE_LISTS } from '../utils/thresholds';
import { DiseaseOutbreakModal } from '../components/modals';
import { SubmissionHistorySection } from '../components/SubmissionHistorySection';
import { ProvenanceBadge } from '../components/common';

/** Data portion of the server-assembled disease varsling (see DiseaseReportAssembler). */
interface DiseasePrefillPayload {
  healthEventId: string | null;
  eventDate: string | null;
  diseaseName: string;
  pathogenCategory: string | null;
  affectedPercentage: number | null;
  diseaseCategory: string;
  confirmation: string;
  affectedCount: number | null;
  description: string | null;
}

/**
 * Review-and-approve card (RPT-011): the disease varsling assembles from the
 * site's latest disease_outbreak health event (interim source, FARM-MEDIUM-152).
 * The disease name, affected percentage and pathogen category render READ-ONLY
 * with provenance; the regulator's A/C/F list category, confirmation and
 * affected count stay required manual entries (surfaced here via their badges).
 */
export const DiseaseAssembledReview: React.FC<{
  prefill?: ReportPrefill<DiseasePrefillPayload>;
}> = ({ prefill }) => {
  if (!prefill) return null;
  const p = prefill.draftPayload;
  const meta = (path: string): ReturnType<typeof findFieldMeta> => findFieldMeta(prefill.fields, path);

  if (!p.healthEventId) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
        No disease-outbreak health event on record for this site. Record it in Fish Health before
        filing the disease varsling — the report assembles from the health event.
      </div>
    );
  }

  const rows: Array<{ label: string; path: string; value: React.ReactNode }> = [
    { label: 'Event date', path: '/eventDate', value: p.eventDate },
    { label: 'Disease name', path: '/diseaseName', value: p.diseaseName || '—' },
    { label: 'Pathogen category', path: '/pathogenCategory', value: p.pathogenCategory || '—' },
    { label: 'Affected %', path: '/affectedPercentage', value: p.affectedPercentage ?? '—' },
    { label: 'Disease list (A/C/F)', path: '/diseaseCategory', value: p.diseaseCategory || '—' },
    { label: 'Confirmation', path: '/confirmation', value: p.confirmation || '—' },
    { label: 'Affected count', path: '/affectedCount', value: p.affectedCount ?? '—' },
  ];

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h3 className="text-sm font-medium text-gray-900 mb-1">
        Assembled from the latest health event
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        Disease name, affected percentage and pathogen category come from the health event —
        read-only here; corrections go to Fish Health.
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
// Types
// ============================================================================

interface DiseaseOutbreakTabProps {
  siteId?: string;
}

// ============================================================================
// Disease Info Component
// ============================================================================

const DiseaseInfoPanel: React.FC<{ onCreateReport: () => void }> = ({ onCreateReport }) => (
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
        <h3 className="text-sm font-medium text-red-800">Notifiable Disease Requirements</h3>
        <div className="mt-2 text-sm text-red-700">
          <p>Norwegian law requires immediate reporting of:</p>
          <ul className="list-disc list-inside mt-1 space-y-1">
            <li><strong>Liste A:</strong> Exotic diseases ({DISEASE_LISTS.A.diseases.slice(0, 3).map(d => d.code).join(', ')}...)</li>
            <li><strong>Liste C:</strong> Non-exotic notifiable ({DISEASE_LISTS.C.diseases.slice(0, 3).map(d => d.code).join(', ')}...)</li>
            <li><strong>Liste F:</strong> Other notifiable diseases</li>
          </ul>
        </div>
        <div className="mt-3">
          <button
            type="button"
            onClick={onCreateReport}
            className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-red-700 bg-red-100 hover:bg-red-200 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
          >
            Report Disease Outbreak
          </button>
        </div>
      </div>
    </div>
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

export const DiseaseOutbreakTab: React.FC<DiseaseOutbreakTabProps> = ({ siteId }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showHealthEventLink, setShowHealthEventLink] = useState(false);

  // Regulatory settings supply the Mattilsynet identity block; the mutation
  // dispatches the immediate disease varsling via the backend.
  const { data: regulatorySettings } = useRegulatorySettings();
  const submitDiseaseOutbreak = useSubmitDiseaseOutbreak();
  const clientRef = useStableClientReference();

  // Event-triggered varsling; the period is nominal (the assembler reads the
  // site's latest disease_outbreak health event).
  const { effectiveSiteId } = useEffectiveReportSite(siteId);
  const prefillPeriod = useMemo(() => ({ year: new Date().getFullYear() }), []);
  const { data: prefill } = useReportPrefill<DiseasePrefillPayload>(
    'DISEASE_OUTBREAK',
    effectiveSiteId,
    prefillPeriod,
  );

  const handleCreateReport = () => {
    setShowHealthEventLink(false);
    setIsModalOpen(true);
  };

  const handleCreateFromHealthEvent = () => {
    setShowHealthEventLink(true);
    setIsModalOpen(true);
  };

  const handleModalSubmit = async (data: Partial<DiseaseOutbreakReport>): Promise<void> => {
    // Resolve the Mattilsynet identity block — throws RegulatoryConfigError if
    // the tenant is not configured. The modal surfaces the thrown message and
    // stays open (it only closes when this promise RESOLVES).
    const reportSiteId = data.siteId || siteId || 'site-001';
    const identity = buildRegulatoryIdentity(regulatorySettings, reportSiteId);

    const result = await submitDiseaseOutbreak.mutateAsync({
      klientReferanse: clientRef.get(),
      organisasjonsnummer: identity.organisasjonsnummer,
      lokalitetsnummer: identity.lokalitetsnummer,
      siteId: reportSiteId,
      siteName: data.siteName || 'Unknown site',
      kontaktperson: identity.kontaktperson,
      siteManagerEmail: identity.siteManagerEmail,
      detectedAt: (data.detectedAt ?? new Date()).toISOString(),
      reportedBy: identity.kontaktperson.navn,
      diseaseCategory: data.disease?.category ?? 'F',
      diseaseName: data.disease?.name ?? 'Unknown disease',
      confirmation:
        data.disease?.suspectedOrConfirmed === 'lab_confirmed' ? 'confirmed' : 'suspected',
      affectedCount: data.affectedPopulation?.estimatedCount ?? 0,
      affectedPercentage: data.affectedPopulation?.percentage ?? 0,
      clinicalSigns: data.clinicalSigns ?? [],
      veterinarianNotified: data.veterinarianNotified ?? false,
      veterinarianName: data.veterinarianName,
    });

    // Surface a backend failure as an error so the modal stays open and shows
    // it — NEVER fake success.
    if (!result.success) {
      throw new Error(
        result.feilmelding || 'Mattilsynet rejected the disease report. Please review and retry.',
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
          <h2 className="text-lg font-medium text-gray-900">Disease Outbreaks</h2>
          <p className="mt-1 text-sm text-gray-500">
            Immediate reporting required for notifiable diseases to {REGULATORY_CONTACTS.MATTILSYNET_EMAIL}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCreateFromHealthEvent}
            className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
          >
            <svg className="w-4 h-4 mr-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
            Create from Health Event
          </button>
          <button
            type="button"
            onClick={handleCreateReport}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
          >
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Report Outbreak
          </button>
        </div>
      </div>

      {/* Disease Info */}
      <DiseaseInfoPanel onCreateReport={handleCreateReport} />

      {/* Submission History */}
      <DiseaseAssembledReview prefill={prefill} />

      <SubmissionHistorySection reportType="DISEASE_OUTBREAK" siteId={siteId} />

      {/* Modal */}
      <DiseaseOutbreakModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
        }}
        onSubmit={handleModalSubmit}
        siteId={siteId || 'site-001'}
        siteName="Default Site"
        showHealthEventLink={showHealthEventLink}
      />
    </div>
  );
};

export default DiseaseOutbreakTab;
