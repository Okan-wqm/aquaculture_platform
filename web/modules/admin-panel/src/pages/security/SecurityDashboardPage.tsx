/**
 * Security Dashboard Page
 *
 * Real-time security monitoring with threat intelligence, events, and incidents.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { securityApi } from '../../services/adminApi';

// Inline SVG icon components to match module pattern (replaces lucide-react dependency, PERF-011)
const Icon: React.FC<{ path: string; className?: string }> = ({ path, className = 'w-5 h-5' }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={path} />
  </svg>
);
const Shield = (p: { className?: string }) => <Icon path="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" {...p} />;
const AlertTriangle = (p: { className?: string }) => <Icon path="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" {...p} />;
const Activity = (p: { className?: string }) => <Icon path="M22 12h-4l-3 9L9 3l-3 9H2" {...p} />;
const RefreshCw = (p: { className?: string }) => <Icon path="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" {...p} />;
const Eye = (p: { className?: string }) => <Icon path="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" {...p} />;
const Search = (p: { className?: string }) => <Icon path="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" {...p} />;
const Filter = (p: { className?: string }) => <Icon path="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" {...p} />;
const Download = (p: { className?: string }) => <Icon path="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" {...p} />;
const Play = (p: { className?: string }) => <Icon path="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z M21 12a9 9 0 11-18 0 9 9 0 0118 0z" {...p} />;
const Pause = (p: { className?: string }) => <Icon path="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" {...p} />;
const Clock = (p: { className?: string }) => <Icon path="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" {...p} />;
const MapPin = (p: { className?: string }) => <Icon path="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z M15 11a3 3 0 11-6 0 3 3 0 016 0z" {...p} />;
const Globe = (p: { className?: string }) => <Icon path="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064" {...p} />;
const Server = (p: { className?: string }) => <Icon path="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" {...p} />;
const Lock = (p: { className?: string }) => <Icon path="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" {...p} />;
const Unlock = (p: { className?: string }) => <Icon path="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" {...p} />;
const AlertCircle = (p: { className?: string }) => <Icon path="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" {...p} />;
const CheckCircle2 = (p: { className?: string }) => <Icon path="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" {...p} />;
const XCircle = (p: { className?: string }) => <Icon path="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" {...p} />;
const Zap = (p: { className?: string }) => <Icon path="M13 10V3L4 14h7v7l9-11h-7z" {...p} />;
const Target = (p: { className?: string }) => <Icon path="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" {...p} />;
const BarChart3 = (p: { className?: string }) => <Icon path="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" {...p} />;
const TrendingUp = (p: { className?: string }) => <Icon path="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" {...p} />;
const TrendingDown = (p: { className?: string }) => <Icon path="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" {...p} />;
const Users = (p: { className?: string }) => <Icon path="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" {...p} />;
const X = (p: { className?: string }) => <Icon path="M6 18L18 6M6 6l12 12" {...p} />;

// ============================================================================
// Types
// ============================================================================

type EventSeverity = 'low' | 'medium' | 'high' | 'critical';
type EventStatus = 'new' | 'investigating' | 'resolved' | 'dismissed';
type IncidentStatus = 'open' | 'in_progress' | 'contained' | 'resolved' | 'closed';
type ThreatType = 'malware' | 'phishing' | 'brute_force' | 'data_exfiltration' | 'unauthorized_access' | 'anomaly';

interface SecurityEvent {
  id: string;
  eventType: string;
  severity: EventSeverity;
  status: EventStatus;
  source: string;
  sourceIp?: string;
  targetResource?: string;
  description: string;
  details?: Record<string, unknown>;
  tenantId?: string;
  tenantName?: string;
  userId?: string;
  userName?: string;
  geoLocation?: {
    country?: string;
    city?: string;
    latitude?: number;
    longitude?: number;
  };
  timestamp: string;
  detectedAt: string;
}

interface SecurityIncident {
  id: string;
  title: string;
  description: string;
  severity: EventSeverity;
  status: IncidentStatus;
  category: string;
  affectedSystems: string[];
  affectedUsers: number;
  relatedEvents: string[];
  assignedTo?: string;
  assignedToName?: string;
  timeline: Array<{
    action: string;
    timestamp: string;
    user?: string;
  }>;
  impactAssessment?: string;
  rootCause?: string;
  remediation?: string;
  createdAt: string;
  updatedAt?: string;
  resolvedAt?: string;
}

interface ThreatIndicator {
  id: string;
  type: ThreatType;
  indicator: string;
  source: string;
  confidence: number;
  severity: EventSeverity;
  description: string;
  firstSeen: string;
  lastSeen: string;
  hitCount: number;
  isActive: boolean;
  tags?: string[];
}

interface HealthMetric {
  name: string;
  status: 'healthy' | 'warning' | 'critical';
  value: number;
  unit: string;
  threshold: number;
  lastUpdated: string;
}

interface DashboardData {
  healthScore: number;
  healthStatus: 'healthy' | 'warning' | 'critical';
  metrics: HealthMetric[];
  stats: {
    totalEvents24h: number;
    criticalEvents24h: number;
    openIncidents: number;
    resolvedIncidents: number;
    activeThreatIndicators: number;
    blockedAttacks24h: number;
    uniqueSourceIps: number;
    affectedTenants: number;
  };
  trendData: Array<{
    date: string;
    events: number;
    incidents: number;
    blocked: number;
  }>;
}

// ============================================================================
// API Service - All calls via centralized securityApi (SEC-005, BUG-013)
// ============================================================================

async function fetchDashboardData(): Promise<DashboardData> {
  return securityApi.getMonitoringDashboard() as Promise<DashboardData>;
}

async function fetchSecurityEvents(params: {
  page?: number;
  limit?: number;
  severity?: string;
  status?: string;
  searchQuery?: string;
}): Promise<{ data: SecurityEvent[]; total: number }> {
  const apiParams: Record<string, unknown> = {};
  if (params.page) apiParams.page = params.page;
  if (params.limit) apiParams.limit = params.limit;
  if (params.severity && params.severity !== 'all') apiParams.severity = [params.severity];
  if (params.status && params.status !== 'all') apiParams.isResolved = params.status === 'resolved';

  const result = await securityApi.getSecurityEvents(apiParams);
  // Map API response to local SecurityEvent type
  const anyEvent = (e: typeof result.data[0]) => e as unknown as Record<string, unknown>;
  return {
    data: result.data.map((event) => {
      // Map API status to local EventStatus
      const apiStatus = anyEvent(event).status as string | undefined;
      const status: EventStatus = event.isResolved
        ? 'resolved'
        : (apiStatus === 'investigating' ? 'investigating' : apiStatus === 'dismissed' ? 'dismissed' : 'new');
      const timestamp = (anyEvent(event).timestamp as string) || (anyEvent(event).createdAt as string) || '';
      return {
        id: event.id,
        eventType: (anyEvent(event).eventType as string) || event.type,
        severity: event.severity as EventSeverity,
        status,
        source: (anyEvent(event).source as string) || 'unknown',
        sourceIp: event.sourceIp,
        description: (anyEvent(event).description as string) || '',
        details: event.metadata,
        tenantId: event.tenantId,
        userId: event.userId,
        timestamp,
        detectedAt: (anyEvent(event).detectedAt as string) || timestamp,
      };
    }),
    total: result.total,
  };
}

async function fetchIncidents(): Promise<SecurityIncident[]> {
  const result = await securityApi.getSecurityIncidents({});
  return result.data as unknown as SecurityIncident[];
}

async function fetchThreatIndicators(): Promise<ThreatIndicator[]> {
  const result = await securityApi.getThreatIndicators({});
  return result.data as unknown as ThreatIndicator[];
}

async function fetchHealthScore(): Promise<{ score: number; status: string; details: HealthMetric[] }> {
  const result = await securityApi.getHealthScore();
  return result as { score: number; status: string; details: HealthMetric[] };
}

// ============================================================================
// Components
// ============================================================================

const getSeverityColor = (severity: EventSeverity) => {
  switch (severity) {
    case 'critical':
      return 'bg-red-100 text-red-800 border-red-200';
    case 'high':
      return 'bg-orange-100 text-orange-800 border-orange-200';
    case 'medium':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200';
    case 'low':
      return 'bg-blue-100 text-blue-800 border-blue-200';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200';
  }
};

const getSeverityIcon = (severity: EventSeverity) => {
  switch (severity) {
    case 'critical':
      return <XCircle className="w-4 h-4 text-red-600" />;
    case 'high':
      return <AlertCircle className="w-4 h-4 text-orange-600" />;
    case 'medium':
      return <AlertTriangle className="w-4 h-4 text-yellow-600" />;
    case 'low':
      return <CheckCircle2 className="w-4 h-4 text-blue-600" />;
    default:
      return <Activity className="w-4 h-4 text-gray-600" />;
  }
};

const getStatusColor = (status: EventStatus | IncidentStatus) => {
  switch (status) {
    case 'resolved':
    case 'closed':
      return 'bg-green-100 text-green-800';
    case 'new':
    case 'open':
      return 'bg-blue-100 text-blue-800';
    case 'investigating':
    case 'in_progress':
      return 'bg-yellow-100 text-yellow-800';
    case 'contained':
      return 'bg-purple-100 text-purple-800';
    case 'dismissed':
      return 'bg-gray-100 text-gray-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
};

const formatTimeAgo = (dateString: string) => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
};

const formatDateTime = (dateString: string) => {
  return new Date(dateString).toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

// Health Score Gauge Component
const HealthGauge: React.FC<{ score: number; status: 'healthy' | 'warning' | 'critical' }> = ({ score, status }) => {
  const getColor = () => {
    if (status === 'healthy') return '#22c55e';
    if (status === 'warning') return '#eab308';
    return '#ef4444';
  };

  const circumference = 2 * Math.PI * 45;
  const safeScore = typeof score === 'number' && !isNaN(score) ? score : 0;
  const strokeDashoffset = circumference - (safeScore / 100) * circumference;

  return (
    <div className="relative w-32 h-32">
      <svg className="w-32 h-32 transform -rotate-90">
        <circle
          cx="64"
          cy="64"
          r="45"
          stroke="#e5e7eb"
          strokeWidth="10"
          fill="none"
        />
        <circle
          cx="64"
          cy="64"
          r="45"
          stroke={getColor()}
          strokeWidth="10"
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold text-gray-900">{safeScore}</span>
        <span className="text-xs text-gray-500">{status}</span>
      </div>
    </div>
  );
};

// Event Detail Modal
const EventDetailModal: React.FC<{
  event: SecurityEvent;
  onClose: () => void;
}> = ({ event, onClose }) => {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {getSeverityIcon(event.severity)}
              <h2 className="text-xl font-semibold text-gray-900">{event.eventType}</h2>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        <div className="p-6 space-y-6">
          {/* Basic Info */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium text-gray-500">Event ID</label>
              <p className="text-sm text-gray-900 font-mono">{event.id}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Timestamp</label>
              <p className="text-sm text-gray-900">{formatDateTime(event.timestamp)}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Severity</label>
              <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${getSeverityColor(event.severity)}`}>
                {getSeverityIcon(event.severity)}
                {event.severity}
              </span>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Status</label>
              <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(event.status)}`}>
                {event.status}
              </span>
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="text-sm font-medium text-gray-500">Description</label>
            <p className="text-sm text-gray-900 mt-1">{event.description}</p>
          </div>

          {/* Source Info */}
          <div className="bg-gray-50 rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Source Information</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-gray-500">Source</label>
                <p className="text-sm text-gray-900">{event.source}</p>
              </div>
              <div>
                <label className="text-xs text-gray-500">Source IP</label>
                <p className="text-sm text-gray-900 font-mono">{event.sourceIp || 'N/A'}</p>
              </div>
              <div>
                <label className="text-xs text-gray-500">Target Resource</label>
                <p className="text-sm text-gray-900">{event.targetResource || 'N/A'}</p>
              </div>
              <div>
                <label className="text-xs text-gray-500">Location</label>
                <p className="text-sm text-gray-900">
                  {event.geoLocation ? `${event.geoLocation.city}, ${event.geoLocation.country}` : 'N/A'}
                </p>
              </div>
            </div>
          </div>

          {/* User Info */}
          {event.userId && (
            <div className="bg-gray-50 rounded-lg p-4">
              <h3 className="text-sm font-medium text-gray-700 mb-3">User Information</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-gray-500">User</label>
                  <p className="text-sm text-gray-900">{event.userName}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500">Tenant</label>
                  <p className="text-sm text-gray-900">{event.tenantName || 'N/A'}</p>
                </div>
              </div>
            </div>
          )}

          {/* Details */}
          {event.details && typeof event.details === 'object' && Object.keys(event.details).length > 0 && (
            <div>
              <label className="text-sm font-medium text-gray-500">Additional Details</label>
              <pre className="text-xs text-gray-600 bg-gray-50 p-3 rounded-lg overflow-auto mt-1">
                {JSON.stringify(
                  // Whitelist primitive-valued keys only to guard against attacker-controlled nested objects (SEC-008)
                  Object.fromEntries(
                    Object.entries(event.details).filter(([, v]) =>
                      v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
                    )
                  ),
                  null,
                  2
                )}
              </pre>
            </div>
          )}
        </div>
        <div className="p-6 border-t border-gray-200 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const SecurityDashboardPage: React.FC = () => {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [incidents, setIncidents] = useState<SecurityIncident[]>([]);
  const [threatIndicators, setThreatIndicators] = useState<ThreatIndicator[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<SecurityEvent | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Filters
  const [severityFilter, setSeverityFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');

  const loadData = useCallback(async () => {
    setError(null);
    try {
      const [dashboardResult, eventsResult, incidentsResult, threatsResult] = await Promise.all([
        fetchDashboardData(),
        fetchSecurityEvents({
          severity: severityFilter,
          status: statusFilter,
          searchQuery: searchTerm || undefined,
          limit: 50,
        }),
        fetchIncidents(),
        fetchThreatIndicators(),
      ]);
      setDashboard(dashboardResult);
      setEvents(eventsResult.data);
      setIncidents(incidentsResult);
      setThreatIndicators(threatsResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load security data');
      console.error('Failed to load security data:', err);
    } finally {
      setLoading(false);
    }
  }, [severityFilter, statusFilter, searchTerm]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto refresh every 30 seconds — pause when browser tab is hidden (PERF-005)
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      if (!document.hidden) {
        loadData();
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [autoRefresh, loadData]);

  if (loading && !dashboard) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (error && !dashboard) {
    return (
      <div className="flex flex-col items-center justify-center h-64">
        <AlertTriangle className="w-12 h-12 text-red-500 mb-4" />
        <p className="text-red-600 mb-4">{error}</p>
        <button
          onClick={loadData}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Security Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">
            Real-time security monitoring and threat intelligence
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border ${
              autoRefresh
                ? 'bg-green-50 text-green-700 border-green-200'
                : 'bg-gray-50 text-gray-700 border-gray-200'
            }`}
          >
            {autoRefresh ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            Auto-refresh {autoRefresh ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Health Score & Stats */}
      {dashboard && (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Health Score Card */}
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <h3 className="text-sm font-medium text-gray-700 mb-4">Security Health Score</h3>
            <div className="flex items-center justify-center">
              <HealthGauge score={dashboard.healthScore} status={dashboard.healthStatus} />
            </div>
            <div className="mt-4 space-y-2">
              {(dashboard?.metrics ?? []).slice(0, 3).map((metric, idx) => (
                <div key={idx} className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">{metric.name}</span>
                  <span className={`font-medium ${
                    metric.status === 'healthy' ? 'text-green-600' :
                    metric.status === 'warning' ? 'text-yellow-600' : 'text-red-600'
                  }`}>
                    {metric.value}{metric.unit}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Stats Grid */}
          <div className="lg:col-span-3 grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Activity className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-xs text-gray-500">Events (24h)</p>
                  <p className="text-2xl font-bold text-gray-900">{dashboard?.stats?.totalEvents24h ?? 0}</p>
                </div>
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-red-100 rounded-lg">
                  <AlertCircle className="w-5 h-5 text-red-600" />
                </div>
                <div>
                  <p className="text-xs text-gray-500">Critical (24h)</p>
                  <p className="text-2xl font-bold text-red-600">{dashboard?.stats?.criticalEvents24h ?? 0}</p>
                </div>
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-orange-100 rounded-lg">
                  <Target className="w-5 h-5 text-orange-600" />
                </div>
                <div>
                  <p className="text-xs text-gray-500">Open Incidents</p>
                  <p className="text-2xl font-bold text-gray-900">{dashboard?.stats?.openIncidents ?? 0}</p>
                </div>
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-100 rounded-lg">
                  <Shield className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <p className="text-xs text-gray-500">Blocked (24h)</p>
                  <p className="text-2xl font-bold text-green-600">{dashboard?.stats?.blockedAttacks24h ?? 0}</p>
                </div>
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-100 rounded-lg">
                  <Zap className="w-5 h-5 text-purple-600" />
                </div>
                <div>
                  <p className="text-xs text-gray-500">Active Threats</p>
                  <p className="text-2xl font-bold text-gray-900">{dashboard?.stats?.activeThreatIndicators ?? 0}</p>
                </div>
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-100 rounded-lg">
                  <Globe className="w-5 h-5 text-indigo-600" />
                </div>
                <div>
                  <p className="text-xs text-gray-500">Unique IPs</p>
                  <p className="text-2xl font-bold text-gray-900">{dashboard?.stats?.uniqueSourceIps ?? 0}</p>
                </div>
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-cyan-100 rounded-lg">
                  <Users className="w-5 h-5 text-cyan-600" />
                </div>
                <div>
                  <p className="text-xs text-gray-500">Affected Tenants</p>
                  <p className="text-2xl font-bold text-gray-900">{dashboard?.stats?.affectedTenants ?? 0}</p>
                </div>
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-teal-100 rounded-lg">
                  <CheckCircle2 className="w-5 h-5 text-teal-600" />
                </div>
                <div>
                  <p className="text-xs text-gray-500">Resolved</p>
                  <p className="text-2xl font-bold text-gray-900">{dashboard?.stats?.resolvedIncidents ?? 0}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Security Events */}
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="p-4 border-b border-gray-200">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Recent Security Events</h3>
              <select
                value={severityFilter}
                onChange={(e) => setSeverityFilter(e.target.value)}
                className="text-sm border border-gray-300 rounded px-2 py-1"
              >
                <option value="all">All Severities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>
          <div className="divide-y divide-gray-200 max-h-96 overflow-y-auto">
            {events.length === 0 ? (
              <div className="p-8 text-center text-gray-500">No security events found</div>
            ) : (
              events.slice(0, 10).map((event) => (
                <div
                  key={event.id}
                  className="p-4 hover:bg-gray-50 cursor-pointer"
                  onClick={() => setSelectedEvent(event)}
                >
                  <div className="flex items-start gap-3">
                    {getSeverityIcon(event.severity)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {event.eventType}
                        </p>
                        <span className="text-xs text-gray-500">{formatTimeAgo(event.timestamp)}</span>
                      </div>
                      <p className="text-sm text-gray-500 truncate">{event.description}</p>
                      <div className="mt-1 flex items-center gap-2">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${getSeverityColor(event.severity)}`}>
                          {event.severity}
                        </span>
                        {event.sourceIp && (
                          <span className="text-xs text-gray-500 font-mono">{event.sourceIp}</span>
                        )}
                      </div>
                    </div>
                    <Eye className="w-4 h-4 text-gray-400" />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Active Incidents */}
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="p-4 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">Active Incidents</h3>
          </div>
          <div className="divide-y divide-gray-200 max-h-96 overflow-y-auto">
            {incidents.length === 0 ? (
              <div className="p-8 text-center text-gray-500">No active incidents</div>
            ) : (
              incidents.slice(0, 5).map((incident) => (
                <div key={incident.id} className="p-4 hover:bg-gray-50">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${getSeverityColor(incident.severity ?? 'medium')}`}>
                          {getSeverityIcon(incident.severity ?? 'medium')}
                          {incident.severity ?? 'Unknown'}
                        </span>
                        <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(incident.status ?? 'open')}`}>
                          {(incident.status ?? 'open').replace('_', ' ')}
                        </span>
                      </div>
                      <h4 className="text-sm font-medium text-gray-900 mt-2">{incident.title ?? 'Untitled Incident'}</h4>
                      <p className="text-sm text-gray-500 mt-1 line-clamp-2">{incident.description ?? ''}</p>
                      <div className="mt-2 flex items-center gap-4 text-xs text-gray-500">
                        <span>Category: {incident.category ?? 'Unknown'}</span>
                        <span>{incident.affectedUsers ?? 0} users affected</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between text-xs">
                    <span className="text-gray-500">
                      Created {incident.createdAt ? formatTimeAgo(incident.createdAt) : 'Unknown'}
                    </span>
                    <span className="text-gray-500">
                      Assigned to: {incident.assignedToName ?? 'Unassigned'}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Threat Intelligence */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">Threat Intelligence</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Indicator</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Source</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Confidence</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Severity</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Hits</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Seen</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {threatIndicators.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    No threat indicators found
                  </td>
                </tr>
              ) : (
                threatIndicators.slice(0, 10).map((threat) => (
                  <tr key={threat.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-sm font-medium text-gray-900 capitalize">
                        {(threat.type ?? 'unknown').replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm font-mono text-gray-600">{threat.indicator ?? '-'}</span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                      {threat.source ?? 'Unknown'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-2 bg-gray-200 rounded-full">
                          <div
                            className={`h-2 rounded-full ${
                              (threat.confidence ?? 0) >= 80 ? 'bg-green-500' :
                              (threat.confidence ?? 0) >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                            }`}
                            style={{ width: `${threat.confidence ?? 0}%` }}
                          />
                        </div>
                        <span className="text-sm text-gray-600">{threat.confidence ?? 0}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${getSeverityColor(threat.severity ?? 'medium')}`}>
                        {threat.severity ?? 'Unknown'}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 font-medium">
                      {threat.hitCount ?? 0}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                      {threat.lastSeen ? formatTimeAgo(threat.lastSeen) : 'Never'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${
                        (threat.isActive ?? false) ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-800'
                      }`}>
                        {(threat.isActive ?? false) ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Event Detail Modal */}
      {selectedEvent && (
        <EventDetailModal
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
        />
      )}
    </div>
  );
};

export default SecurityDashboardPage;
