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
import React, { useMemo } from 'react';
import { Routes, Route, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { getReportSummary, getOverdueReports } from './mock/helpers';

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
  overdueCount: number;
  urgentCount: number;
}

const WarningBanner: React.FC<WarningBannerProps> = ({ overdueCount, urgentCount }) => {
  if (overdueCount === 0 && urgentCount === 0) return null;

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
            {overdueCount > 0 && (
              <span className="font-medium">
                {overdueCount} overdue {overdueCount === 1 ? 'report' : 'reports'}
              </span>
            )}
            {overdueCount > 0 && urgentCount > 0 && ' and '}
            {urgentCount > 0 && (
              <span className="font-medium">
                {urgentCount} {urgentCount === 1 ? 'report' : 'reports'} due soon
              </span>
            )}
            {'. '}
            Please submit pending reports to avoid regulatory penalties.
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

  // Get report summary for badges
  const summary = useMemo(() => getReportSummary(), []);
  const overdueReports = useMemo(() => getOverdueReports(), []);

  // Calculate tab badges
  const reportTabs: ReportTab[] = useMemo(() => {
    // For now, show total pending/overdue on urgent tabs
    return baseReportTabs.map((tab) => {
      const tabWithBadge: ReportTab = { ...tab };

      // Urgent tabs show any active incidents
      if (['welfare', 'disease', 'escape'].includes(tab.id)) {
        const urgentOverdue = overdueReports.filter(
          (r) => r.reportType === tab.id
        ).length;
        if (urgentOverdue > 0) {
          tabWithBadge.badge = urgentOverdue;
          tabWithBadge.badgeVariant = 'error';
        }
      }

      return tabWithBadge;
    });
  }, [overdueReports]);

  // Determine active tab from URL
  const currentPath = location.pathname.split('/').pop() || 'sea-lice';
  const activeTab = reportTabs.find((tab) => tab.path === currentPath)?.id || 'sea-lice';

  const handleTabChange = (tabPath: string) => {
    navigate(`/sites/reports/${tabPath}`);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Warning Banner */}
      <WarningBanner
        overdueCount={summary.totalOverdue}
        urgentCount={summary.urgentCount}
      />

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
                  <div className="text-2xl font-bold text-gray-900">{summary.totalPending}</div>
                  <div className="text-xs text-gray-500">Pending</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-red-600">{summary.totalOverdue}</div>
                  <div className="text-xs text-gray-500">Overdue</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-600">{summary.recentlySubmitted}</div>
                  <div className="text-xs text-gray-500">Submitted</div>
                </div>
              </div>

              {/* Export Button */}
              <button
                type="button"
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Export
              </button>
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
    </div>
  );
};

export default ReportsPage;
