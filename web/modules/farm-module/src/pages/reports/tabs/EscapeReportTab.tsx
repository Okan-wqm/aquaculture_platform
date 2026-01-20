/**
 * Escape Report Tab
 * Lists fish escape incidents and provides quick-entry modal for immediate reporting
 */
import React, { useState, useMemo } from 'react';
import { getMockReports } from '../mock/helpers';
import { EscapeReport, EscapeStatus, EscapeCause } from '../types/reports.types';
import { REGULATORY_CONTACTS } from '../utils/thresholds';
import { ReportStatusBadge } from '../components/common';
import { EscapeReportModal } from '../components/modals';

// ============================================================================
// Types
// ============================================================================

interface EscapeReportTabProps {
  siteId?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getCauseLabel(cause: EscapeCause): string {
  const labels: Record<EscapeCause, string> = {
    equipment_failure: 'Equipment Failure',
    storm_damage: 'Storm Damage',
    predator_attack: 'Predator Attack',
    human_error: 'Human Error',
    unknown: 'Unknown Cause',
  };
  return labels[cause];
}

function getStatusBadge(status: EscapeStatus): React.ReactNode {
  const config = {
    detected: { bg: 'bg-red-100', text: 'text-red-800', icon: '!' },
    reported: { bg: 'bg-blue-100', text: 'text-blue-800', icon: '>' },
    investigation: { bg: 'bg-purple-100', text: 'text-purple-800', icon: '?' },
    closed: { bg: 'bg-green-100', text: 'text-green-800', icon: '✓' },
  };
  const style = config[status];
  return (
    <span className={`px-2 py-0.5 text-xs font-semibold rounded ${style.bg} ${style.text}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function formatNumber(num: number): string {
  return num.toLocaleString();
}

// ============================================================================
// Escape Detail Card Component
// ============================================================================

interface EscapeDetailCardProps {
  escape: EscapeReport;
  onView: () => void;
}

const EscapeDetailCard: React.FC<EscapeDetailCardProps> = ({ escape, onView }) => {
  const isActive = escape.escapeStatus !== 'closed';
  const recoveryPercentage = escape.escape.estimatedCount > 0
    ? Math.round((escape.recovery.recapturedCount / escape.escape.estimatedCount) * 100)
    : 0;

  return (
    <div
      className={`bg-white rounded-lg border shadow-sm hover:shadow-md transition-shadow ${
        isActive ? 'border-red-200' : 'border-gray-200'
      }`}
    >
      {/* Header */}
      <div className={`px-4 py-3 border-b ${isActive ? 'bg-red-50 border-red-100' : 'bg-gray-50 border-gray-100'}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className={`w-5 h-5 ${isActive ? 'text-red-500' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span className="font-medium text-gray-900">{escape.escape.species}</span>
            {getStatusBadge(escape.escapeStatus)}
          </div>
          <span className={`text-lg font-bold ${isActive ? 'text-red-600' : 'text-gray-600'}`}>
            {formatNumber(escape.escape.estimatedCount)} fish
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-3">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-gray-500">Site:</span>
            <span className="ml-2 font-medium text-gray-900">{escape.siteName}</span>
          </div>
          <div>
            <span className="text-gray-500">Detected:</span>
            <span className="ml-2 text-gray-700">{formatDate(escape.detectedAt)}</span>
          </div>
          <div>
            <span className="text-gray-500">Cause:</span>
            <span className="ml-2 text-gray-700">{getCauseLabel(escape.escape.cause)}</span>
          </div>
          <div>
            <span className="text-gray-500">Biomass:</span>
            <span className="ml-2 text-gray-700">{formatNumber(escape.escape.totalBiomassKg)} kg</span>
          </div>
        </div>

        {/* Affected Units */}
        {escape.affectedUnits && escape.affectedUnits.length > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="text-xs font-medium text-gray-500 uppercase mb-2">Affected Units</div>
            <div className="flex flex-wrap gap-2">
              {escape.affectedUnits.map((unit, idx) => (
                <span
                  key={idx}
                  className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded"
                >
                  {unit.unitName}: {formatNumber(unit.escapedCount)} fish
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Recovery Progress */}
        <div className="mt-3 pt-3 border-t border-gray-100">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-gray-500 uppercase">Recovery Progress</span>
            <span className="text-sm font-medium text-gray-700">{recoveryPercentage}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className={`h-2 rounded-full ${recoveryPercentage > 50 ? 'bg-green-500' : 'bg-yellow-500'}`}
              style={{ width: `${recoveryPercentage}%` }}
            />
          </div>
          <div className="flex justify-between mt-1 text-xs text-gray-500">
            <span>Recaptured: {formatNumber(escape.recovery.recapturedCount)}</span>
            <span>Remaining: {formatNumber(escape.recovery.estimatedRemaining)}</span>
          </div>
        </div>

        {/* Environmental Impact */}
        {escape.environmentalImpact && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="flex items-center text-sm">
              {escape.environmentalImpact.nearbyWildPopulations ? (
                <>
                  <svg className="w-4 h-4 text-orange-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span className="text-orange-700">Wild populations nearby - Assessment required</span>
                </>
              ) : (
                <>
                  <svg className="w-4 h-4 text-green-500 mr-2" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  <span className="text-green-700">No immediate environmental concern</span>
                </>
              )}
            </div>
            {escape.environmentalImpact.riverSystems && escape.environmentalImpact.riverSystems.length > 0 && (
              <div className="mt-1 text-xs text-gray-500">
                Nearby rivers: {escape.environmentalImpact.riverSystems.join(', ')}
              </div>
            )}
          </div>
        )}

        {/* Reference Number */}
        {escape.acknowledgement && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="flex items-center text-sm">
              <svg className="w-4 h-4 text-blue-500 mr-2" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              <span className="text-blue-700">Ref: {escape.acknowledgement.referenceNumber}</span>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 rounded-b-lg">
        <div className="flex items-center justify-between">
          <div className="text-xs text-gray-500">
            {escape.recovery.ongoingEfforts ? (
              <span className="text-blue-600 flex items-center">
                <svg className="w-3 h-3 mr-1 animate-pulse" fill="currentColor" viewBox="0 0 20 20">
                  <circle cx="10" cy="10" r="5" />
                </svg>
                Recovery efforts ongoing
              </span>
            ) : escape.escapeStatus === 'closed' ? (
              <span className="text-green-600">Case closed</span>
            ) : (
              <span className="text-gray-400">No active recovery</span>
            )}
          </div>
          <button
            type="button"
            onClick={onView}
            className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
          >
            View Details
          </button>
        </div>
      </div>
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
            className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-red-700 bg-red-100 hover:bg-red-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
          >
            Report Escape Incident
          </button>
        </div>
      </div>
    </div>
  </div>
);

// ============================================================================
// Summary Stats Component
// ============================================================================

interface SummaryStatsProps {
  escapes: EscapeReport[];
}

const SummaryStats: React.FC<SummaryStatsProps> = ({ escapes }) => {
  const stats = useMemo(() => {
    const active = escapes.filter((e) => e.escapeStatus !== 'closed');
    const totalEscaped = escapes.reduce((sum, e) => sum + e.escape.estimatedCount, 0);
    const totalRecovered = escapes.reduce((sum, e) => sum + e.recovery.recapturedCount, 0);
    const totalBiomass = escapes.reduce((sum, e) => sum + e.escape.totalBiomassKg, 0);
    const recoveryRate = totalEscaped > 0 ? Math.round((totalRecovered / totalEscaped) * 100) : 0;

    return {
      activeCount: active.length,
      totalEscaped,
      totalRecovered,
      totalBiomass,
      recoveryRate,
    };
  }, [escapes]);

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
      <div className="bg-white rounded-lg border border-gray-200 p-4 text-center">
        <div className="text-2xl font-bold text-red-600">{stats.activeCount}</div>
        <div className="text-xs text-gray-500">Active Cases</div>
      </div>
      <div className="bg-white rounded-lg border border-gray-200 p-4 text-center">
        <div className="text-2xl font-bold text-gray-900">{formatNumber(stats.totalEscaped)}</div>
        <div className="text-xs text-gray-500">Total Escaped</div>
      </div>
      <div className="bg-white rounded-lg border border-gray-200 p-4 text-center">
        <div className="text-2xl font-bold text-green-600">{formatNumber(stats.totalRecovered)}</div>
        <div className="text-xs text-gray-500">Recaptured</div>
      </div>
      <div className="bg-white rounded-lg border border-gray-200 p-4 text-center">
        <div className="text-2xl font-bold text-blue-600">{stats.recoveryRate}%</div>
        <div className="text-xs text-gray-500">Recovery Rate</div>
      </div>
      <div className="bg-white rounded-lg border border-gray-200 p-4 text-center">
        <div className="text-2xl font-bold text-orange-600">{formatNumber(stats.totalBiomass)}</div>
        <div className="text-xs text-gray-500">Total kg</div>
      </div>
    </div>
  );
};

// ============================================================================
// Empty State Component
// ============================================================================

const EmptyState: React.FC<{ onCreateReport: () => void }> = ({ onCreateReport }) => (
  <div className="text-center py-12">
    <svg
      className="mx-auto h-12 w-12 text-gray-400"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
    <h3 className="mt-2 text-sm font-medium text-gray-900">No escape incidents recorded</h3>
    <p className="mt-1 text-sm text-gray-500">
      If an escape occurs, report immediately to {REGULATORY_CONTACTS.MATTILSYNET_EMAIL}
    </p>
    <div className="mt-6">
      <button
        type="button"
        onClick={onCreateReport}
        className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
      >
        <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
        Report Escape Incident
      </button>
    </div>
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

export const EscapeReportTab: React.FC<EscapeReportTabProps> = ({ siteId }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedEscape, setSelectedEscape] = useState<EscapeReport | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'closed'>('all');

  // Get escape reports
  const allEscapes = useMemo(() => {
    return getMockReports<EscapeReport>('escape', siteId ? { siteId } : undefined);
  }, [siteId]);

  // Filter escapes
  const filteredEscapes = useMemo(() => {
    switch (filter) {
      case 'active':
        return allEscapes.filter((e) => e.escapeStatus !== 'closed');
      case 'closed':
        return allEscapes.filter((e) => e.escapeStatus === 'closed');
      default:
        return allEscapes;
    }
  }, [allEscapes, filter]);

  // Active count
  const activeCount = useMemo(() => {
    return allEscapes.filter((e) => e.escapeStatus !== 'closed').length;
  }, [allEscapes]);

  const handleCreateReport = () => {
    setSelectedEscape(null);
    setIsModalOpen(true);
  };

  const handleViewEscape = (escape: EscapeReport) => {
    setSelectedEscape(escape);
    setIsModalOpen(true);
  };

  const handleModalSubmit = async (data: Partial<EscapeReport>): Promise<void> => {
    console.log('Submitting escape report:', data);
    setIsModalOpen(false);
    setSelectedEscape(null);
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
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
        >
          <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Report Escape
        </button>
      </div>

      {/* Escape Info */}
      <EscapeInfoPanel onCreateReport={handleCreateReport} />

      {/* Summary Stats */}
      {allEscapes.length > 0 && <SummaryStats escapes={allEscapes} />}

      {/* Active Alert */}
      {activeCount > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-center">
            <svg className="h-5 w-5 text-yellow-400 mr-2" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            <span className="text-sm font-medium text-yellow-800">
              {activeCount} active escape {activeCount === 1 ? 'incident' : 'incidents'} requiring attention
            </span>
          </div>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-8" aria-label="Filter tabs">
          {[
            { id: 'all', label: 'All Incidents', count: allEscapes.length },
            { id: 'active', label: 'Active', count: activeCount },
            { id: 'closed', label: 'Closed', count: allEscapes.length - activeCount },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilter(tab.id as typeof filter)}
              className={`
                py-2 px-1 border-b-2 font-medium text-sm
                ${
                  filter === tab.id
                    ? 'border-red-500 text-red-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }
              `}
            >
              {tab.label}
              <span
                className={`ml-2 px-2 py-0.5 rounded-full text-xs ${
                  filter === tab.id ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-500'
                }`}
              >
                {tab.count}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {/* Escapes List */}
      {filteredEscapes.length === 0 ? (
        <EmptyState onCreateReport={handleCreateReport} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filteredEscapes.map((escape) => (
            <EscapeDetailCard
              key={escape.id}
              escape={escape}
              onView={() => handleViewEscape(escape)}
            />
          ))}
        </div>
      )}

      {/* Modal */}
      <EscapeReportModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setSelectedEscape(null);
        }}
        onSubmit={handleModalSubmit}
        siteId={siteId || 'site-001'}
        siteName="Default Site"
      />
    </div>
  );
};

export default EscapeReportTab;
