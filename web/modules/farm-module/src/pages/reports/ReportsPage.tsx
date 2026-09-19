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

// Scheduled report drafts due (RPT-003)
import { ReportsDueSection } from './components/ReportsDueSection';

// Scheduled Report Tabs
import { SeaLiceReportTab } from './tabs/SeaLiceReportTab';
import { BiomassReportTab } from './tabs/BiomassReportTab';
import { SmoltReportTab } from './tabs/SmoltReportTab';
import { CleanerFishReportTab } from './tabs/CleanerFishReportTab';
import { SlaughterReportTab } from './tabs/SlaughterReportTab';
import { PageHeader, Button } from '@aquaculture/shared-ui';
import {
  Box,
  Calendar,
  ChartColumn,
  DollarSign,
  FlaskConical,
  Settings as SettingsIcon,
  Sparkles,
  TriangleAlert,
  Zap,
} from 'lucide-react';

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

const SeaLiceIcon = () => <DollarSign className="w-5 h-5" aria-hidden="true" />;

const BiomassIcon = () => <ChartColumn className="w-5 h-5" aria-hidden="true" />;

const SmoltIcon = () => <Box className="w-5 h-5" aria-hidden="true" />;

const CleanerFishIcon = () => <Sparkles className="w-5 h-5" aria-hidden="true" />;

const SlaughterIcon = () => <Calendar className="w-5 h-5" aria-hidden="true" />;

const WelfareIcon = () => <TriangleAlert className="w-5 h-5" aria-hidden="true" />;

const DiseaseIcon = () => <FlaskConical className="w-5 h-5" aria-hidden="true" />;

const EscapeIcon = () => <Zap className="w-5 h-5" aria-hidden="true" />;

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
          <TriangleAlert className="h-5 w-5 text-red-400" aria-hidden="true" />
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
                {dueSoonCount} {dueSoonCount === 1 ? 'report type' : 'report types'} due within 3
                days
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

  const EXPORT_TYPES: Partial<
    Record<string, [RegulatoryReportTypeValue, RegulatoryReportTypeValue?]>
  > = {
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
    <div className="min-h-screen bg-gray-50 dark:bg-gray-800">
      {/* Warning Banner */}
      <WarningBanner failedCount={totals.failed} dueSoonCount={dueSoonCount} />

      {/* Page Header */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
        <div className="px-4 sm:px-6 py-6">
          <PageHeader
            title="Regulatory Reports"
            description="Norwegian aquaculture compliance reports for Mattilsynet and Fiskeridirektoratet"
            actions={
              <div className="flex items-center space-x-3">
                {/* Summary Stats */}
                <div className="hidden sm:flex items-center space-x-4 mr-4">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                      {totals.pending}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">Pending</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-red-600">{totals.failed}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">Failed</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-green-600">{totals.submitted}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">Submitted</div>
                  </div>
                </div>

                {/* Report Settings Button */}
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => setShowSettingsModal(true)}
                  title="Report Settings"
                >
                  <SettingsIcon className="w-4 h-4 mr-2" aria-hidden="true" />
                  Report Settings
                </Button>

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
            }
          />
        </div>
      </div>

      {/* Scheduled report drafts due (RPT-003) — assembled each period by the
          scheduler; approve & submit / refresh / dismiss from here. */}
      <ReportsDueSection />

      {/* Tab Navigation */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
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
                      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 hover:border-gray-300 dark:hover:border-gray-500'
                  }
                `}
                title={tab.description}
              >
                <span
                  className={`mr-2 ${
                    activeTab === tab.id
                      ? 'text-blue-500'
                      : 'text-gray-400 dark:text-gray-500 group-hover:text-gray-500 dark:group-hover:text-gray-300'
                  }`}
                >
                  {tab.icon}
                </span>
                {tab.label}
                {/* Deadline indicator */}
                {tab.deadline === 'immediate' && (
                  <span
                    className="ml-1.5 w-2 h-2 rounded-full bg-red-500"
                    title="Immediate reporting required"
                  />
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
