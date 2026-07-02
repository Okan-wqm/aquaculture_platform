/**
 * Reports Page
 * Main regulatory reports page with tabbed navigation for Norwegian compliance reports.
 *
 * Report Types:
 * - Sea Lice (Weekly - due Tuesdays)
 * - Biomass (Monthly - due 7th)
 * - Smolt (Monthly - due 7th)
 * - Cleaner Fish (Monthly - due 7th)
 * - Slaughter (Event-based)
 * - Welfare Events (IMMEDIATE)
 * - Disease Outbreak (IMMEDIATE)
 * - Escape Report (IMMEDIATE)
 */
import React, { useMemo, useState } from 'react';
import { Routes, Route, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { ReportSettingsModal } from './components/ReportSettingsModal';
import { ExportSubmissionsButton } from './components/ExportSubmissionsButton';
import {
  useRegulatoryReportSummary,
  RegulatoryReportTypeValue,
} from '../../hooks/useRegulatoryReports';
import { getNextDeadline, getDaysUntilDeadline, REPORTING_DEADLINES } from './utils/thresholds';

// Urgent Report Tabs
import { WelfareEventTab } from './tabs/WelfareEventTab';
import { DiseaseOutbreakTab } from './tabs/DiseaseOutbreakTab';
import { EscapeReportTab } from './tabs/EscapeReportTab';

// Scheduled Report Tabs
import { SeaLiceReportTab } from './tabs/SeaLiceReportTab';
import { BiomassReportTab } from './tabs/BiomassReportTab';
import { SmoltReportTab } from './tabs/SmoltReportTab';
import { CleanerFishReportTab } from './tabs/CleanerFishReportTab';
import { SlaughterReportTab } from './tabs/SlaughterReportTab';

// ============================================================================
// Types
// ============================================================================

interface ReportTab {
  id: string;
  label: string;
  path: string;
  icon: React.ReactNode;
  description: string;
  deadline: 'weekly' | 'monthly' | 'event' | 'immediate';
  badge?: number;
  badgeVariant?: 'warning' | 'error';
}

// ============================================================================
// Icons
// ============================================================================

const SeaLiceIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const BiomassIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
  </svg>
);

const SmoltIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5" />
  </svg>
);

const CleanerFishIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
  </svg>
);

const SlaughterIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
  </svg>
);

const WelfareIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
  </svg>
);

const DiseaseIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
  </svg>
);

const EscapeIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
  </svg>
);

// ============================================================================
// Tab Configuration
// ============================================================================

const baseReportTabs: Omit<ReportTab, 'badge' | 'badgeVariant'>[] = [
  {
    id: 'sea-lice',
    label: 'Sea Lice',
    path: 'sea-lice',
    icon: <SeaLiceIcon />,
    description: 'Weekly lakselus count reports (due Tuesdays)',
    deadline: 'weekly',
  },
  {
    id: 'biomass',
    label: 'Biomass',
    path: 'biomass',
    icon: <BiomassIcon />,
    description: 'Monthly standing biomass reports',
    deadline: 'monthly',
  },
  {
    id: 'smolt',
    label: 'Smolt',
    path: 'smolt',
    icon: <SmoltIcon />,
    description: 'Monthly settefisk production reports',
    deadline: 'monthly',
  },
  {
    id: 'cleaner-fish',
    label: 'Cleaner Fish',
    path: 'cleaner-fish',
    icon: <CleanerFishIcon />,
    description: 'Monthly rensefisk deployment reports',
    deadline: 'monthly',
  },
  {
    id: 'slaughter',
    label: 'Slaughter',
    path: 'slaughter',
    icon: <SlaughterIcon />,
    description: 'Planned and completed harvest reports',
    deadline: 'event',
  },
  {
    id: 'welfare',
    label: 'Welfare Events',
    path: 'welfare',
    icon: <WelfareIcon />,
    description: 'Report welfare incidents immediately',
    deadline: 'immediate',
  },
  {
    id: 'disease',
    label: 'Disease',
    path: 'disease',
    icon: <DiseaseIcon />,
    description: 'Report disease outbreaks immediately',
    deadline: 'immediate',
  },
  {
    id: 'escape',
    label: 'Escape',
    path: 'escape',
    icon: <EscapeIcon />,
    description: 'Report fish escapes immediately',
    deadline: 'immediate',
  },
];

// ============================================================================
// Badge Component
// ============================================================================

interface BadgeProps {
  count: number;
  variant: 'warning' | 'error';
}

const Badge: React.FC<BadgeProps> = ({ count, variant }) => {
  if (count === 0) return null;

  const variantClasses = {
    warning: 'bg-yellow-100 text-yellow-800',
    error: 'bg-red-100 text-red-800',
  };

  return (
    <span
      className={`ml-2 inline-flex items-center justify-center px-2 py-0.5 text-xs font-medium rounded-full ${variantClasses[variant]}`}
    >
      {count}
    </span>
  );
};

// ============================================================================
// Warning Banner Component
// ============================================================================

interface WarningBannerProps {
  failedCount: number;
  dueSoonCount: number;
}

const WarningBanner: React.FC<WarningBannerProps> = ({ failedCount, dueSoonCount }) => {
  if (failedCount === 0 && dueSoonCount === 0) return null;

  return (
    <div className="bg-red-50 border-l-4 border-red-400 p-4">
      <div className="flex">
        <div className="flex-shrink-0">
          <svg
            className="h-5 w-5 text-red-400"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
        </div>
        <div className="ml-3">
          <p className="text-sm text-red-700">
            {failedCount > 0 && (
              <span className="font-medium">
                {failedCount} failed {failedCount === 1 ? 'submission' : 'submissions'}
              </span>
            )}
            {failedCount > 0 && dueSoonCount > 0 && ' and '}
            {dueSoonCount > 0 && (
              <span className="font-medium">
                {dueSoonCount} {dueSoonCount === 1 ? 'report type' : 'report types'} due within 3 days
              </span>
            )}
            {'. '}
            Please review and resubmit to avoid regulatory penalties.
          </p>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const ReportsPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  // Persisted-submission summary (FARM-HIGH-125) — per-type status counts
  // + last submission timestamp from the backend record-of-submission.
  const { data: typeSummaries = [] } = useRegulatoryReportSummary();

  const summaryByType = useMemo(() => {
    const map = new Map<RegulatoryReportTypeValue, (typeof typeSummaries)[number]>();
    for (const entry of typeSummaries) map.set(entry.reportType, entry);
    return map;
  }, [typeSummaries]);

  const totals = useMemo(
    () =>
      typeSummaries.reduce(
        (acc, entry) => ({
          pending: acc.pending + entry.pendingCount,
          failed: acc.failed + entry.failedCount,
          submitted: acc.submitted + entry.submittedCount + entry.queuedCount,
        }),
        { pending: 0, failed: 0, submitted: 0 },
      ),
    [typeSummaries],
  );

  // "Due soon": a periodic report type whose next calendar deadline is
  // within 3 days and which has no successful submission inside the
  // current reporting period.
  const dueSoonCount = useMemo(() => {
    const periodic: Array<{
      type: RegulatoryReportTypeValue;
      calendarKey: keyof typeof REPORTING_DEADLINES;
      periodMs: number;
    }> = [
      { type: 'SEA_LICE', calendarKey: 'SEA_LICE', periodMs: 7 * 24 * 60 * 60 * 1000 },
      { type: 'SMOLT', calendarKey: 'SMOLT', periodMs: 31 * 24 * 60 * 60 * 1000 },
      { type: 'CLEANER_FISH', calendarKey: 'CLEANER_FISH', periodMs: 31 * 24 * 60 * 60 * 1000 },
    ];
    return periodic.filter(({ type, calendarKey, periodMs }) => {
      const deadline = getNextDeadline(calendarKey);
      const days = getDaysUntilDeadline(deadline);
      if (days > 3) return false;
      const last = summaryByType.get(type)?.lastSubmittedAt;
      if (!last) return true;
      const periodStart = deadline.getTime() - periodMs;
      return new Date(last).getTime() < periodStart;
    }).length;
  }, [summaryByType]);

  // Tab badges: failed submissions need operator action.
  const reportTabs: ReportTab[] = useMemo(() => {
    const typeByTabId: Partial<Record<string, RegulatoryReportTypeValue[]>> = {
      'sea-lice': ['SEA_LICE'],
      smolt: ['SMOLT'],
      'cleaner-fish': ['CLEANER_FISH'],
      slaughter: ['SLAUGHTER_PLANNED', 'SLAUGHTER_EXECUTED'],
      welfare: ['WELFARE_EVENT'],
      disease: ['DISEASE_OUTBREAK'],
      escape: ['ESCAPE'],
    };
    return baseReportTabs.map((tab) => {
      const tabWithBadge: ReportTab = { ...tab };
      const failed = (typeByTabId[tab.id] ?? []).reduce(
        (sum, type) => sum + (summaryByType.get(type)?.failedCount ?? 0),
        0,
      );
      if (failed > 0) {
        tabWithBadge.badge = failed;
        tabWithBadge.badgeVariant = 'error';
      }
      return tabWithBadge;
    });
  }, [summaryByType]);

  // Determine active tab from URL
  const currentPath = location.pathname.split('/').pop() || 'sea-lice';
  const activeTab = reportTabs.find((tab) => tab.path === currentPath)?.id || 'sea-lice';

  const EXPORT_TYPES: Partial<Record<string, [RegulatoryReportTypeValue, RegulatoryReportTypeValue?]>> = {
    'sea-lice': ['SEA_LICE'],
    smolt: ['SMOLT'],
    'cleaner-fish': ['CLEANER_FISH'],
    slaughter: ['SLAUGHTER_PLANNED', 'SLAUGHTER_EXECUTED'],
    welfare: ['WELFARE_EVENT'],
    disease: ['DISEASE_OUTBREAK'],
    escape: ['ESCAPE'],
  };
  const activeExportTypes = EXPORT_TYPES[activeTab];

  const handleTabChange = (tabPath: string) => {
    navigate(`/sites/reports/${tabPath}`);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Warning Banner */}
      <WarningBanner failedCount={totals.failed} dueSoonCount={dueSoonCount} />

      {/* Page Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="px-4 sm:px-6 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Regulatory Reports</h1>
              <p className="mt-1 text-sm text-gray-500">
                Norwegian aquaculture compliance reports for Mattilsynet and Fiskeridirektoratet
              </p>
            </div>
            <div className="flex items-center space-x-3">
              {/* Summary Stats */}
              <div className="hidden sm:flex items-center space-x-4 mr-4">
                <div className="text-center">
                  <div className="text-2xl font-bold text-gray-900">{totals.pending}</div>
                  <div className="text-xs text-gray-500">Pending</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-red-600">{totals.failed}</div>
                  <div className="text-xs text-gray-500">Failed</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-600">{totals.submitted}</div>
                  <div className="text-xs text-gray-500">Submitted</div>
                </div>
              </div>

              {/* Report Settings Button */}
              <button
                type="button"
                onClick={() => setShowSettingsModal(true)}
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                title="Report Settings"
              >
                <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Report Settings
              </button>

              {/* Export (FARM-LOW-119) — CSV of the active tab's persisted
                  submissions. Biomass keeps its own draft table and has no
                  regulatory_reports rows, so no export renders there. */}
              {activeExportTypes && (
                <ExportSubmissionsButton
                  primaryType={activeExportTypes[0]}
                  secondaryType={activeExportTypes[1]}
                  filename={`regulatory-submissions-${activeTab}.csv`}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="bg-white border-b border-gray-200">
        <div className="px-4 sm:px-6">
          <nav className="-mb-px flex space-x-8 overflow-x-auto" aria-label="Report tabs">
            {reportTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.path)}
                className={`
                  group inline-flex items-center py-4 px-1 border-b-2 font-medium text-sm whitespace-nowrap
                  ${
                    activeTab === tab.id
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }
                `}
                title={tab.description}
              >
                <span
                  className={`mr-2 ${
                    activeTab === tab.id
                      ? 'text-blue-500'
                      : 'text-gray-400 group-hover:text-gray-500'
                  }`}
                >
                  {tab.icon}
                </span>
                {tab.label}
                {/* Deadline indicator */}
                {tab.deadline === 'immediate' && (
                  <span className="ml-1.5 w-2 h-2 rounded-full bg-red-500" title="Immediate reporting required" />
                )}
                {/* Badge */}
                {tab.badge && tab.badgeVariant && (
                  <Badge count={tab.badge} variant={tab.badgeVariant} />
                )}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      <div className="px-4 sm:px-6 py-6">
        <Routes>
          <Route path="sea-lice" element={<SeaLiceReportTab />} />
          <Route path="biomass" element={<BiomassReportTab />} />
          <Route path="smolt" element={<SmoltReportTab />} />
          <Route path="cleaner-fish" element={<CleanerFishReportTab />} />
          <Route path="slaughter" element={<SlaughterReportTab />} />
          <Route path="welfare" element={<WelfareEventTab />} />
          <Route path="disease" element={<DiseaseOutbreakTab />} />
          <Route path="escape" element={<EscapeReportTab />} />
          {/* Default to sea-lice */}
          <Route index element={<Navigate to="sea-lice" replace />} />
          <Route path="*" element={<Navigate to="sea-lice" replace />} />
        </Routes>
      </div>

      {/* Report Settings Modal */}
      <ReportSettingsModal open={showSettingsModal} onClose={() => setShowSettingsModal(false)} />
    </div>
  );
};

export default ReportsPage;
