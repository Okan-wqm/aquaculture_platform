/**
 * Welfare Event Tab
 * Lists welfare events and provides quick-entry modal for immediate reporting
 */
import React, { useState, useMemo } from 'react';
import { useRegulatorySettings, useSubmitWelfareEvent } from '../../../hooks/useRegulatory';
import { buildVarslingIdentity } from '../utils/varslingIdentity';
import { WelfareEventReport } from '../types/reports.types';
import { REGULATORY_CONTACTS, MORTALITY_THRESHOLDS } from '../utils/thresholds';
import { WelfareEventModal } from '../components/modals';
import { SubmissionHistorySection } from '../components/SubmissionHistorySection';
import { useTanksList } from '../../../hooks/useTanks';

// ============================================================================
// Types
// ============================================================================

interface WelfareEventTabProps {
  siteId?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

function getEventTypeLabel(eventType: string): string {
  const labels: Record<string, string> = {
    mortality_threshold: 'Mortality Threshold Exceeded',
    equipment_failure: 'Equipment Failure',
    welfare_impact: 'Welfare Impact Event',
  };
  return labels[eventType] || eventType;
}

// ============================================================================
// Mortality Warning Banner Component
// ============================================================================

interface MortalityWarningBannerProps {
  tankNames: string[];
  onCreateReport: () => void;
}

const MortalityWarningBanner: React.FC<MortalityWarningBannerProps> = ({ tankNames, onCreateReport }) => {
  if (tankNames.length === 0) return null;

  const displayNames = tankNames.slice(0, 5).join(', ');
  const remaining = tankNames.length - 5;

  return (
    <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 mb-6">
      <div className="flex items-start">
        <div className="flex-shrink-0">
          <svg className="h-5 w-5 text-amber-500 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
        </div>
        <div className="ml-3 flex-1">
          <p className="text-sm font-medium text-amber-800">
            Elevated mortality detected in {displayNames}
            {remaining > 0 && ` and ${remaining} more`}
            . Review and report if threshold exceeded.
          </p>
          <div className="mt-2">
            <button
              type="button"
              onClick={onCreateReport}
              className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-amber-700 bg-amber-100 hover:bg-amber-200 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-amber-500"
            >
              Report Welfare Event
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Threshold Alert Component
// ============================================================================

interface ThresholdAlertProps {
  onCreateReport: () => void;
}

const ThresholdAlert: React.FC<ThresholdAlertProps> = ({ onCreateReport }) => (
  <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
    <div className="flex">
      <div className="flex-shrink-0">
        <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
            clipRule="evenodd"
          />
        </svg>
      </div>
      <div className="ml-3 flex-1">
        <h3 className="text-sm font-medium text-red-800">Reporting Thresholds</h3>
        <div className="mt-2 text-sm text-red-700">
          <p>Norwegian regulations require immediate reporting when:</p>
          <ul className="list-disc list-inside mt-1 space-y-1">
            <li>Daily mortality exceeds {MORTALITY_THRESHOLDS.DAILY.ELEVATED}%</li>
            <li>3-day mortality exceeds {MORTALITY_THRESHOLDS.MULTI_DAY.THREE_DAY_HIGH}%</li>
            <li>7-day mortality exceeds {MORTALITY_THRESHOLDS.MULTI_DAY.SEVEN_DAY_CRITICAL}%</li>
            <li>Significant equipment failure affecting fish welfare</li>
            <li>Any event seriously impacting fish welfare</li>
          </ul>
        </div>
        <div className="mt-3">
          <button
            type="button"
            onClick={onCreateReport}
            className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-red-700 bg-red-100 hover:bg-red-200 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
          >
            Report Welfare Event
          </button>
        </div>
      </div>
    </div>
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

export const WelfareEventTab: React.FC<WelfareEventTabProps> = ({ siteId }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Regulatory settings supply the Mattilsynet identity block; the mutation
  // dispatches the immediate welfare varsling via the backend.
  const { data: regulatorySettings } = useRegulatorySettings();
  const submitWelfareEvent = useSubmitWelfareEvent();

  // Fetch tank data for mortality warning banner
  const { data: tanksData } = useTanksList({ siteId, isActive: true });
  const tanks = tanksData?.items || [];

  // Tanks with high mortality rates
  const highMortalityTankNames = useMemo(() => {
    return tanks
      .filter(
        (t) =>
          t.batchMetrics?.mortalityRate != null &&
          t.batchMetrics.mortalityRate >= MORTALITY_THRESHOLDS.DAILY.ELEVATED
      )
      .map((t) => t.name);
  }, [tanks]);

  const handleCreateReport = () => {
    setIsModalOpen(true);
  };

  const handleModalSubmit = async (data: Partial<WelfareEventReport>): Promise<void> => {
    // Resolve the Mattilsynet identity block — throws VarslingConfigError if
    // the tenant is not configured. The modal surfaces the thrown message and
    // stays open (it only closes when this promise RESOLVES).
    const reportSiteId = data.siteId || siteId || 'site-001';
    const identity = buildVarslingIdentity(regulatorySettings, reportSiteId);

    const result = await submitWelfareEvent.mutateAsync({
      klientReferanse: crypto.randomUUID(),
      organisasjonsnummer: identity.organisasjonsnummer,
      lokalitetsnummer: identity.lokalitetsnummer,
      siteId: reportSiteId,
      siteName: data.siteName || 'Unknown site',
      kontaktperson: identity.kontaktperson,
      siteManagerEmail: identity.siteManagerEmail,
      detectedAt: (data.detectedAt ?? new Date()).toISOString(),
      reportedBy: identity.kontaktperson.navn,
      welfareEventType: data.eventType ?? 'welfare_impact',
      severity: data.severity ?? 'high',
      mortalityRate: data.mortalityData?.actualRate,
      mortalityPeriod: data.mortalityData?.period,
      affectedBatches: data.mortalityData?.affectedBatches?.map((b) => b.batchNumber),
      description:
        data.welfareData?.description ||
        data.equipmentData?.description ||
        getEventTypeLabel(data.eventType ?? 'welfare_impact'),
      immediateActions: data.immediateActions ?? [],
    });

    // Surface a backend failure as an error so the modal stays open and shows
    // it — NEVER fake success.
    if (!result.success) {
      throw new Error(
        result.feilmelding || 'Mattilsynet rejected the welfare report. Please review and retry.',
      );
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-gray-900">Welfare Events</h2>
          <p className="mt-1 text-sm text-gray-500">
            Immediate reporting required for welfare incidents to {REGULATORY_CONTACTS.MATTILSYNET_EMAIL}
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
          Report Event
        </button>
      </div>

      {/* Mortality Warning Banner */}
      <MortalityWarningBanner
        tankNames={highMortalityTankNames}
        onCreateReport={handleCreateReport}
      />

      {/* Threshold Information */}
      <ThresholdAlert onCreateReport={handleCreateReport} />

      {/* Submission History */}
      <SubmissionHistorySection reportType="WELFARE_EVENT" siteId={siteId} />

      {/* Modal */}
      <WelfareEventModal
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

export default WelfareEventTab;
