/**
 * Welfare Event Tab
 * Lists welfare events and provides quick-entry modal for immediate reporting
 */
import React, { useState, useMemo } from 'react';
import { getMockReports } from '../mock/helpers';
import { WelfareEventReport, WelfareEventStatus } from '../types/reports.types';
import { REGULATORY_CONTACTS, MORTALITY_THRESHOLDS } from '../utils/thresholds';
import { ReportStatusBadge, ReportCard, DeadlineIndicator } from '../components/common';
import { WelfareEventModal } from '../components/modals';

// ============================================================================
// Types
// ============================================================================

interface WelfareEventTabProps {
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

function getEventTypeLabel(eventType: string): string {
  const labels: Record<string, string> = {
    mortality_threshold: 'Mortality Threshold Exceeded',
    equipment_failure: 'Equipment Failure',
    welfare_impact: 'Welfare Impact Event',
  };
  return labels[eventType] || eventType;
}

function getSeverityBadge(severity: string): React.ReactNode {
  const config = {
    critical: { bg: 'bg-red-100', text: 'text-red-800', label: 'CRITICAL' },
    high: { bg: 'bg-orange-100', text: 'text-orange-800', label: 'HIGH' },
  };
  const style = config[severity as keyof typeof config] || config.high;
  return (
    <span className={`px-2 py-0.5 text-xs font-semibold rounded ${style.bg} ${style.text}`}>
      {style.label}
    </span>
  );
}

// ============================================================================
// Event Detail Card Component
// ============================================================================

interface EventDetailCardProps {
  event: WelfareEventReport;
  onView: () => void;
}

const EventDetailCard: React.FC<EventDetailCardProps> = ({ event, onView }) => {
  const isActive = event.status !== 'approved' && !event.resolvedAt;

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
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="font-medium text-gray-900">{getEventTypeLabel(event.eventType)}</span>
            {getSeverityBadge(event.severity)}
          </div>
          <ReportStatusBadge status={event.status} size="sm" />
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-3">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-gray-500">Site:</span>
            <span className="ml-2 font-medium text-gray-900">{event.siteName}</span>
          </div>
          <div>
            <span className="text-gray-500">Detected:</span>
            <span className="ml-2 text-gray-700">{formatDate(event.detectedAt)}</span>
          </div>
          {event.reportedAt && (
            <div>
              <span className="text-gray-500">Reported:</span>
              <span className="ml-2 text-gray-700">{formatDate(event.reportedAt)}</span>
            </div>
          )}
          {event.acknowledgement && (
            <div>
              <span className="text-gray-500">Ref:</span>
              <span className="ml-2 text-gray-700">{event.acknowledgement.referenceNumber}</span>
            </div>
          )}
        </div>

        {/* Event-specific details */}
        <div className="mt-3 pt-3 border-t border-gray-100">
          {event.eventType === 'mortality_threshold' && event.mortalityData && (
            <div className="text-sm">
              <span className="text-red-600 font-medium">
                Mortality Rate: {event.mortalityData.actualRate}% ({event.mortalityData.period.replace('_', '-')})
              </span>
              <span className="text-gray-500 ml-2">
                Threshold: {event.mortalityData.threshold}%
              </span>
            </div>
          )}
          {event.eventType === 'equipment_failure' && event.equipmentData && (
            <div className="text-sm text-gray-600">
              {event.equipmentData.equipmentName} - {event.equipmentData.failureType}
              {event.equipmentData.injuredFishCount && (
                <span className="ml-2 text-red-600">
                  ({event.equipmentData.injuredFishCount} fish injured)
                </span>
              )}
            </div>
          )}
          {event.eventType === 'welfare_impact' && event.welfareData && (
            <div className="text-sm text-gray-600">
              {event.welfareData.description.substring(0, 100)}
              {event.welfareData.description.length > 100 && '...'}
            </div>
          )}
        </div>

        {/* Immediate Actions */}
        {event.immediateActions && event.immediateActions.length > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="text-xs font-medium text-gray-500 uppercase mb-2">Immediate Actions</div>
            <ul className="text-sm text-gray-600 space-y-1">
              {event.immediateActions.slice(0, 3).map((action, idx) => (
                <li key={idx} className="flex items-start">
                  <span className="text-green-500 mr-2">-</span>
                  {action}
                </li>
              ))}
              {event.immediateActions.length > 3 && (
                <li className="text-gray-400">+{event.immediateActions.length - 3} more...</li>
              )}
            </ul>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 rounded-b-lg">
        <div className="flex items-center justify-between">
          <div className="text-xs text-gray-500">
            {event.resolvedAt ? (
              <span className="text-green-600">Resolved: {formatDate(event.resolvedAt)}</span>
            ) : event.acknowledgement ? (
              <span className="text-blue-600">Acknowledged by {event.acknowledgement.acknowledgedBy}</span>
            ) : (
              <span className="text-red-600">Awaiting submission</span>
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
            className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-red-700 bg-red-100 hover:bg-red-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
          >
            Report Welfare Event
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
    <h3 className="mt-2 text-sm font-medium text-gray-900">No active welfare events</h3>
    <p className="mt-1 text-sm text-gray-500">
      When welfare incidents occur, report them immediately to {REGULATORY_CONTACTS.MATTILSYNET_EMAIL}
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
        Report Welfare Event
      </button>
    </div>
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

export const WelfareEventTab: React.FC<WelfareEventTabProps> = ({ siteId }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<WelfareEventReport | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'resolved'>('all');

  // Get welfare events
  const allEvents = useMemo(() => {
    return getMockReports<WelfareEventReport>('welfare', siteId ? { siteId } : undefined);
  }, [siteId]);

  // Filter events
  const filteredEvents = useMemo(() => {
    switch (filter) {
      case 'active':
        return allEvents.filter((e) => e.status !== 'approved' && !e.resolvedAt);
      case 'resolved':
        return allEvents.filter((e) => e.status === 'approved' || e.resolvedAt);
      default:
        return allEvents;
    }
  }, [allEvents, filter]);

  // Separate active and historical
  const activeEvents = useMemo(() => {
    return allEvents.filter((e) => e.status !== 'approved' && !e.resolvedAt);
  }, [allEvents]);

  const handleCreateReport = () => {
    setSelectedEvent(null);
    setIsModalOpen(true);
  };

  const handleViewEvent = (event: WelfareEventReport) => {
    setSelectedEvent(event);
    setIsModalOpen(true);
  };

  const handleModalSubmit = async (data: Partial<WelfareEventReport>): Promise<void> => {
    console.log('Submitting welfare event:', data);
    // In real app, this would call the API
    setIsModalOpen(false);
    setSelectedEvent(null);
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
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
        >
          <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Report Event
        </button>
      </div>

      {/* Threshold Information */}
      <ThresholdAlert onCreateReport={handleCreateReport} />

      {/* Active Events Alert */}
      {activeEvents.length > 0 && (
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
              {activeEvents.length} active welfare {activeEvents.length === 1 ? 'event' : 'events'} requiring attention
            </span>
          </div>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-8" aria-label="Filter tabs">
          {[
            { id: 'all', label: 'All Events', count: allEvents.length },
            { id: 'active', label: 'Active', count: activeEvents.length },
            { id: 'resolved', label: 'Resolved', count: allEvents.length - activeEvents.length },
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

      {/* Events List */}
      {filteredEvents.length === 0 ? (
        <EmptyState onCreateReport={handleCreateReport} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filteredEvents.map((event) => (
            <EventDetailCard
              key={event.id}
              event={event}
              onView={() => handleViewEvent(event)}
            />
          ))}
        </div>
      )}

      {/* Modal */}
      <WelfareEventModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setSelectedEvent(null);
        }}
        onSubmit={handleModalSubmit}
        siteId={siteId || 'site-001'}
        siteName="Default Site"
      />
    </div>
  );
};

export default WelfareEventTab;
