/**
 * Disease Outbreak Tab
 * Lists disease outbreaks and provides quick-entry modal for immediate reporting
 */
import React, { useState, useMemo } from 'react';
import { getMockReports } from '../mock/helpers';
import { DiseaseOutbreakReport, DiseaseCategory, DiseaseStatus } from '../types/reports.types';
import { REGULATORY_CONTACTS, DISEASE_LISTS } from '../utils/thresholds';
import { ReportStatusBadge } from '../components/common';
import { DiseaseOutbreakModal } from '../components/modals';

// ============================================================================
// Types
// ============================================================================

interface DiseaseOutbreakTabProps {
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

function getCategoryBadge(category: DiseaseCategory): React.ReactNode {
  const config = {
    A: { bg: 'bg-red-100', text: 'text-red-800', label: 'Liste A (Exotic)' },
    C: { bg: 'bg-orange-100', text: 'text-orange-800', label: 'Liste C (Notifiable)' },
    F: { bg: 'bg-yellow-100', text: 'text-yellow-800', label: 'Liste F (Other)' },
  };
  const style = config[category];
  return (
    <span className={`px-2 py-0.5 text-xs font-semibold rounded ${style.bg} ${style.text}`}>
      {style.label}
    </span>
  );
}

function getStatusIcon(status: DiseaseStatus): React.ReactNode {
  const icons: Record<DiseaseStatus, React.ReactNode> = {
    detected: (
      <svg className="w-5 h-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
    reported: (
      <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    under_investigation: (
      <svg className="w-5 h-5 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    ),
    confirmed: (
      <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    resolved: (
      <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    ),
  };
  return icons[status] || icons.detected;
}

// ============================================================================
// Outbreak Detail Card Component
// ============================================================================

interface OutbreakDetailCardProps {
  outbreak: DiseaseOutbreakReport;
  onView: () => void;
}

const OutbreakDetailCard: React.FC<OutbreakDetailCardProps> = ({ outbreak, onView }) => {
  const isActive = outbreak.diseaseStatus !== 'resolved';

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
            {getStatusIcon(outbreak.diseaseStatus)}
            <span className="font-medium text-gray-900">{outbreak.disease.name}</span>
            {getCategoryBadge(outbreak.disease.category)}
          </div>
          <span
            className={`px-2 py-0.5 text-xs font-medium rounded ${
              outbreak.disease.suspectedOrConfirmed === 'lab_confirmed'
                ? 'bg-red-100 text-red-800'
                : 'bg-yellow-100 text-yellow-800'
            }`}
          >
            {outbreak.disease.suspectedOrConfirmed === 'lab_confirmed' ? 'Confirmed' : 'Suspected'}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-3">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-gray-500">Site:</span>
            <span className="ml-2 font-medium text-gray-900">{outbreak.siteName}</span>
          </div>
          <div>
            <span className="text-gray-500">Detected:</span>
            <span className="ml-2 text-gray-700">{formatDate(outbreak.detectedAt)}</span>
          </div>
          <div>
            <span className="text-gray-500">Affected:</span>
            <span className="ml-2 text-red-600 font-medium">
              {outbreak.affectedPopulation.estimatedCount.toLocaleString()} fish ({outbreak.affectedPopulation.percentage}%)
            </span>
          </div>
          {outbreak.acknowledgement && (
            <div>
              <span className="text-gray-500">Ref:</span>
              <span className="ml-2 text-gray-700">{outbreak.acknowledgement.referenceNumber}</span>
            </div>
          )}
        </div>

        {/* Clinical Signs */}
        {outbreak.clinicalSigns && outbreak.clinicalSigns.length > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="text-xs font-medium text-gray-500 uppercase mb-2">Clinical Signs</div>
            <div className="flex flex-wrap gap-1">
              {outbreak.clinicalSigns.slice(0, 4).map((sign, idx) => (
                <span
                  key={idx}
                  className="px-2 py-0.5 text-xs bg-gray-100 text-gray-700 rounded"
                >
                  {sign}
                </span>
              ))}
              {outbreak.clinicalSigns.length > 4 && (
                <span className="px-2 py-0.5 text-xs text-gray-400">
                  +{outbreak.clinicalSigns.length - 4} more
                </span>
              )}
            </div>
          </div>
        )}

        {/* Lab Results */}
        {outbreak.labResults && outbreak.labResults.length > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="text-xs font-medium text-gray-500 uppercase mb-2">Lab Results</div>
            <div className="text-sm text-gray-600">
              <span className="font-medium">{outbreak.labResults[0].labName}</span>
              {' - '}
              {outbreak.labResults[0].result}
            </div>
          </div>
        )}

        {/* Quarantine Status */}
        {outbreak.quarantineMeasures && outbreak.quarantineMeasures.length > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="flex items-center text-sm">
              <svg className="w-4 h-4 text-orange-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <span className="text-orange-700 font-medium">Quarantine Active</span>
              <span className="text-gray-500 ml-2">({outbreak.quarantineMeasures.length} measures)</span>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 rounded-b-lg">
        <div className="flex items-center justify-between">
          <div className="text-xs text-gray-500">
            {outbreak.veterinarianNotified ? (
              <span className="text-green-600 flex items-center">
                <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Vet: {outbreak.veterinarianName || 'Notified'}
              </span>
            ) : (
              <span className="text-red-600">Veterinarian not notified</span>
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
            className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-red-700 bg-red-100 hover:bg-red-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
          >
            Report Disease Outbreak
          </button>
        </div>
      </div>
    </div>
  </div>
);

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
    <h3 className="mt-2 text-sm font-medium text-gray-900">No disease outbreaks recorded</h3>
    <p className="mt-1 text-sm text-gray-500">
      When a notifiable disease is suspected, report immediately to {REGULATORY_CONTACTS.MATTILSYNET_EMAIL}
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
        Report Disease Outbreak
      </button>
    </div>
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

export const DiseaseOutbreakTab: React.FC<DiseaseOutbreakTabProps> = ({ siteId }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedOutbreak, setSelectedOutbreak] = useState<DiseaseOutbreakReport | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'resolved'>('all');
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'A' | 'C' | 'F'>('all');

  // Get disease outbreaks
  const allOutbreaks = useMemo(() => {
    return getMockReports<DiseaseOutbreakReport>('disease', siteId ? { siteId } : undefined);
  }, [siteId]);

  // Filter outbreaks
  const filteredOutbreaks = useMemo(() => {
    let result = allOutbreaks;

    // Filter by status
    switch (filter) {
      case 'active':
        result = result.filter((o) => o.diseaseStatus !== 'resolved');
        break;
      case 'resolved':
        result = result.filter((o) => o.diseaseStatus === 'resolved');
        break;
    }

    // Filter by category
    if (categoryFilter !== 'all') {
      result = result.filter((o) => o.disease.category === categoryFilter);
    }

    return result;
  }, [allOutbreaks, filter, categoryFilter]);

  // Separate active outbreaks
  const activeOutbreaks = useMemo(() => {
    return allOutbreaks.filter((o) => o.diseaseStatus !== 'resolved');
  }, [allOutbreaks]);

  const handleCreateReport = () => {
    setSelectedOutbreak(null);
    setIsModalOpen(true);
  };

  const handleViewOutbreak = (outbreak: DiseaseOutbreakReport) => {
    setSelectedOutbreak(outbreak);
    setIsModalOpen(true);
  };

  const handleModalSubmit = async (data: Partial<DiseaseOutbreakReport>): Promise<void> => {
    console.log('Submitting disease outbreak:', data);
    setIsModalOpen(false);
    setSelectedOutbreak(null);
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
        <button
          type="button"
          onClick={handleCreateReport}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
        >
          <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Report Outbreak
        </button>
      </div>

      {/* Disease Info */}
      <DiseaseInfoPanel onCreateReport={handleCreateReport} />

      {/* Active Outbreaks Alert */}
      {activeOutbreaks.length > 0 && (
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
              {activeOutbreaks.length} active disease {activeOutbreaks.length === 1 ? 'outbreak' : 'outbreaks'} requiring attention
            </span>
          </div>
        </div>
      )}

      {/* Filter Controls */}
      <div className="flex flex-wrap items-center gap-4">
        {/* Status Filter */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">Status:</span>
          <div className="flex rounded-md shadow-sm">
            {[
              { id: 'all', label: 'All' },
              { id: 'active', label: 'Active' },
              { id: 'resolved', label: 'Resolved' },
            ].map((tab, idx) => (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id as typeof filter)}
                className={`
                  px-3 py-1.5 text-sm font-medium border
                  ${idx === 0 ? 'rounded-l-md' : ''} ${idx === 2 ? 'rounded-r-md' : ''}
                  ${
                    filter === tab.id
                      ? 'bg-red-50 border-red-300 text-red-700 z-10'
                      : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                  }
                  ${idx !== 0 ? '-ml-px' : ''}
                `}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Category Filter */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">Category:</span>
          <div className="flex rounded-md shadow-sm">
            {[
              { id: 'all', label: 'All' },
              { id: 'A', label: 'Liste A' },
              { id: 'C', label: 'Liste C' },
              { id: 'F', label: 'Liste F' },
            ].map((tab, idx) => (
              <button
                key={tab.id}
                onClick={() => setCategoryFilter(tab.id as typeof categoryFilter)}
                className={`
                  px-3 py-1.5 text-sm font-medium border
                  ${idx === 0 ? 'rounded-l-md' : ''} ${idx === 3 ? 'rounded-r-md' : ''}
                  ${
                    categoryFilter === tab.id
                      ? 'bg-red-50 border-red-300 text-red-700 z-10'
                      : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                  }
                  ${idx !== 0 ? '-ml-px' : ''}
                `}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Results Count */}
        <div className="text-sm text-gray-500">
          {filteredOutbreaks.length} {filteredOutbreaks.length === 1 ? 'outbreak' : 'outbreaks'}
        </div>
      </div>

      {/* Outbreaks List */}
      {filteredOutbreaks.length === 0 ? (
        <EmptyState onCreateReport={handleCreateReport} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filteredOutbreaks.map((outbreak) => (
            <OutbreakDetailCard
              key={outbreak.id}
              outbreak={outbreak}
              onView={() => handleViewOutbreak(outbreak)}
            />
          ))}
        </div>
      )}

      {/* Modal */}
      <DiseaseOutbreakModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setSelectedOutbreak(null);
        }}
        onSubmit={handleModalSubmit}
        siteId={siteId || 'site-001'}
        siteName="Default Site"
      />
    </div>
  );
};

export default DiseaseOutbreakTab;
