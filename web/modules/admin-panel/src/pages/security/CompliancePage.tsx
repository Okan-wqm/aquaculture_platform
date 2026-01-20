/**
 * Compliance Page
 *
 * GDPR compliance management, data subject requests, and compliance reporting.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Shield,
  FileText,
  Search,
  Filter,
  Download,
  RefreshCw,
  Plus,
  Eye,
  Check,
  X,
  Clock,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  User,
  Mail,
  Calendar,
  ChevronRight,
  BarChart3,
  Trash2,
  Database,
  Lock,
  Globe,
  FileCheck,
} from 'lucide-react';
import { securityApi } from '../../services/adminApi';

// ============================================================================
// Types
// ============================================================================

type ComplianceType = 'gdpr' | 'ccpa' | 'hipaa' | 'pci_dss' | 'iso27001' | 'soc2';
type DataRequestType = 'access' | 'rectification' | 'erasure' | 'portability' | 'restriction' | 'objection';
type DataRequestStatus = 'pending' | 'in_progress' | 'identity_verification' | 'processing' | 'completed' | 'rejected';

interface DataRequest {
  id: string;
  requestType: DataRequestType;
  complianceFramework: ComplianceType;
  status: DataRequestStatus;
  tenantId: string;
  tenantName: string;
  requesterId?: string;
  requesterName: string;
  requesterEmail: string;
  description: string;
  dataCategories?: string[];
  submittedAt: string;
  dueDate: string;
  assignedTo?: string;
  assignedToName?: string;
  identityVerified: boolean;
  verifiedAt?: string;
  completedAt?: string;
  deliveryFormat?: string;
  downloadUrl?: string;
  isOverdue: boolean;
}

interface ComplianceReport {
  id: string;
  complianceType: ComplianceType;
  reportPeriodStart: string;
  reportPeriodEnd: string;
  generatedAt: string;
  generatedBy: string;
  generatedByName: string;
  overallScore: number;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  warnings: number;
  findings: Array<{
    category: string;
    status: 'pass' | 'fail' | 'warning';
    description: string;
    recommendation?: string;
  }>;
}

interface ComplianceCheck {
  id: string;
  category: string;
  requirement: string;
  description: string;
  status: 'compliant' | 'non_compliant' | 'partial' | 'not_applicable';
  evidence?: string;
  lastChecked: string;
  nextReview: string;
}

interface ComplianceStats {
  totalRequests: number;
  pendingRequests: number;
  inProgressRequests: number;
  completedRequests: number;
  overdueRequests: number;
  averageResolutionTime: number;
}

// ============================================================================
// API Service - Using centralized securityApi with auth headers
// ============================================================================

async function fetchDataRequests(params: {
  page?: number;
  limit?: number;
  status?: string;
  requestType?: string;
  searchQuery?: string;
}): Promise<{ data: DataRequest[]; total: number; stats: ComplianceStats }> {
  const apiParams: Record<string, unknown> = {};
  if (params.page) apiParams.page = params.page;
  if (params.limit) apiParams.limit = params.limit;
  if (params.status && params.status !== 'all') apiParams.status = params.status;
  if (params.requestType && params.requestType !== 'all') apiParams.type = params.requestType;

  const result = await securityApi.getDataRequests(apiParams);
  return {
    data: result.data as unknown as DataRequest[],
    total: result.total,
    stats: {
      totalRequests: result.total,
      pendingRequests: 0,
      inProgressRequests: 0,
      completedRequests: 0,
      overdueRequests: 0,
      averageResolutionTime: 0,
    },
  };
}

async function fetchComplianceReports(): Promise<ComplianceReport[]> {
  return securityApi.getComplianceReports() as unknown as Promise<ComplianceReport[]>;
}

async function fetchComplianceChecks(framework: string): Promise<ComplianceCheck[]> {
  const token = localStorage.getItem('access_token');
  const response = await fetch(`/api/security/compliance/checks/${framework}`, {
    headers: {
      Authorization: token ? `Bearer ${token}` : '',
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error('Failed to fetch compliance checks');
  }
  return response.json();
}

// ============================================================================
// Components
// ============================================================================

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleDateString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
};

const formatDateTime = (dateString: string) => {
  return new Date(dateString).toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const getRequestTypeIcon = (type: DataRequestType) => {
  switch (type) {
    case 'access':
      return <Eye className="w-4 h-4" />;
    case 'erasure':
      return <Trash2 className="w-4 h-4" />;
    case 'portability':
      return <Download className="w-4 h-4" />;
    case 'rectification':
      return <FileCheck className="w-4 h-4" />;
    case 'restriction':
      return <Lock className="w-4 h-4" />;
    case 'objection':
      return <XCircle className="w-4 h-4" />;
    default:
      return <FileText className="w-4 h-4" />;
  }
};

const getRequestTypeLabel = (type: DataRequestType) => {
  const labels: Record<DataRequestType, string> = {
    access: 'Data Access',
    rectification: 'Rectification',
    erasure: 'Erasure (Right to be Forgotten)',
    portability: 'Data Portability',
    restriction: 'Processing Restriction',
    objection: 'Objection to Processing',
  };
  return labels[type];
};

const getStatusColor = (status: DataRequestStatus) => {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-800';
    case 'rejected':
      return 'bg-red-100 text-red-800';
    case 'pending':
      return 'bg-gray-100 text-gray-800';
    case 'in_progress':
    case 'processing':
      return 'bg-blue-100 text-blue-800';
    case 'identity_verification':
      return 'bg-yellow-100 text-yellow-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
};

const getComplianceStatusColor = (status: string) => {
  switch (status) {
    case 'compliant':
    case 'pass':
      return 'bg-green-100 text-green-800 border-green-200';
    case 'non_compliant':
    case 'fail':
      return 'bg-red-100 text-red-800 border-red-200';
    case 'partial':
    case 'warning':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200';
    case 'not_applicable':
      return 'bg-gray-100 text-gray-800 border-gray-200';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200';
  }
};

// Data Request Detail Modal
const DataRequestDetailModal: React.FC<{
  request: DataRequest;
  onClose: () => void;
  onAction: (action: string) => void;
}> = ({ request, onClose, onAction }) => {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Data Subject Request</h2>
              <p className="text-sm text-gray-500 mt-1">ID: {request.id}</p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        <div className="p-6 space-y-6">
          {/* Status Banner */}
          {request.isOverdue && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-red-600" />
              <div>
                <p className="font-medium text-red-800">This request is overdue</p>
                <p className="text-sm text-red-600">
                  Due date was {formatDate(request.dueDate)}
                </p>
              </div>
            </div>
          )}

          {/* Request Info */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium text-gray-500">Request Type</label>
              <div className="flex items-center gap-2 mt-1">
                {getRequestTypeIcon(request.requestType)}
                <span className="text-sm text-gray-900">
                  {getRequestTypeLabel(request.requestType)}
                </span>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Status</label>
              <span
                className={`inline-flex mt-1 px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(request.status)}`}
              >
                {request.status.replace('_', ' ')}
              </span>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Submitted</label>
              <p className="text-sm text-gray-900">{formatDateTime(request.submittedAt)}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Due Date</label>
              <p className={`text-sm ${request.isOverdue ? 'text-red-600 font-medium' : 'text-gray-900'}`}>
                {formatDate(request.dueDate)}
              </p>
            </div>
          </div>

          {/* Requester Info */}
          <div className="bg-gray-50 rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Requester Information</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex items-center gap-2">
                <User className="w-4 h-4 text-gray-400" />
                <span className="text-sm text-gray-900">{request.requesterName}</span>
              </div>
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-gray-400" />
                <span className="text-sm text-gray-900">{request.requesterEmail}</span>
              </div>
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-gray-400" />
                <span className="text-sm text-gray-900">{request.tenantName}</span>
              </div>
              <div className="flex items-center gap-2">
                {request.identityVerified ? (
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-yellow-600" />
                )}
                <span className="text-sm text-gray-900">
                  {request.identityVerified ? 'Identity Verified' : 'Identity Not Verified'}
                </span>
              </div>
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="text-sm font-medium text-gray-500">Description</label>
            <p className="text-sm text-gray-900 mt-1">{request.description}</p>
          </div>

          {/* Data Categories */}
          {request.dataCategories && request.dataCategories.length > 0 && (
            <div>
              <label className="text-sm font-medium text-gray-500">Data Categories</label>
              <div className="flex flex-wrap gap-2 mt-2">
                {request.dataCategories.map((cat) => (
                  <span
                    key={cat}
                    className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs font-medium"
                  >
                    {cat}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Assignment */}
          {request.assignedTo && (
            <div>
              <label className="text-sm font-medium text-gray-500">Assigned To</label>
              <p className="text-sm text-gray-900 mt-1">{request.assignedToName}</p>
            </div>
          )}

          {/* Timeline */}
          <div>
            <label className="text-sm font-medium text-gray-500 mb-3 block">Timeline</label>
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
                  <Check className="w-4 h-4 text-green-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900">Request Submitted</p>
                  <p className="text-xs text-gray-500">{formatDateTime(request.submittedAt)}</p>
                </div>
              </div>
              {request.verifiedAt && (
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
                    <Check className="w-4 h-4 text-green-600" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">Identity Verified</p>
                    <p className="text-xs text-gray-500">{formatDateTime(request.verifiedAt)}</p>
                  </div>
                </div>
              )}
              {request.completedAt && (
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
                    <Check className="w-4 h-4 text-green-600" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">Request Completed</p>
                    <p className="text-xs text-gray-500">{formatDateTime(request.completedAt)}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="p-6 border-t border-gray-200 flex justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
          >
            Close
          </button>
          <div className="flex gap-2">
            {!request.identityVerified && request.status !== 'completed' && (
              <button
                onClick={() => onAction('verify')}
                className="px-4 py-2 text-sm font-medium text-white bg-yellow-600 rounded-lg hover:bg-yellow-700"
              >
                Verify Identity
              </button>
            )}
            {request.status !== 'completed' && request.status !== 'rejected' && (
              <>
                <button
                  onClick={() => onAction('reject')}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700"
                >
                  Reject
                </button>
                <button
                  onClick={() => onAction('complete')}
                  className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700"
                >
                  Complete
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const CompliancePage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'requests' | 'reports' | 'checks'>('requests');
  const [dataRequests, setDataRequests] = useState<DataRequest[]>([]);
  const [reports, setReports] = useState<ComplianceReport[]>([]);
  const [checks, setChecks] = useState<ComplianceCheck[]>([]);
  const [stats, setStats] = useState<ComplianceStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<DataRequest | null>(null);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [requestsResult, reportsResult, checksResult] = await Promise.all([
        fetchDataRequests({
          status: statusFilter,
          requestType: typeFilter,
          searchQuery: searchTerm || undefined,
        }),
        fetchComplianceReports(),
        fetchComplianceChecks('gdpr'),
      ]);
      setDataRequests(requestsResult.data);
      setStats(requestsResult.stats);
      setReports(reportsResult);
      setChecks(checksResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load compliance data');
      console.error('Failed to load compliance data:', err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter, searchTerm]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRequestAction = (action: string) => {
    console.log('Action:', action, 'on request:', selectedRequest?.id);
    setSelectedRequest(null);
    loadData();
  };

  const filteredRequests = dataRequests.filter((req) => {
    const matchesSearch =
      searchTerm === '' ||
      req.requesterName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      req.requesterEmail.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = statusFilter === 'all' || req.status === statusFilter;
    const matchesType = typeFilter === 'all' || req.requestType === typeFilter;

    return matchesSearch && matchesStatus && matchesType;
  });

  if (loading && dataRequests.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (error && dataRequests.length === 0) {
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
          <h1 className="text-2xl font-bold text-gray-900">Compliance Management</h1>
          <p className="text-sm text-gray-500 mt-1">
            GDPR compliance, data subject requests, and regulatory reporting
          </p>
        </div>
        <div className="flex items-center gap-3">
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

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <FileText className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-xs text-gray-500">Total Requests</p>
                <p className="text-2xl font-bold text-gray-900">{stats.totalRequests}</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-gray-100 rounded-lg">
                <Clock className="w-5 h-5 text-gray-600" />
              </div>
              <div>
                <p className="text-xs text-gray-500">Pending</p>
                <p className="text-2xl font-bold text-gray-900">{stats.pendingRequests}</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <RefreshCw className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-xs text-gray-500">In Progress</p>
                <p className="text-2xl font-bold text-gray-900">{stats.inProgressRequests}</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <CheckCircle2 className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-xs text-gray-500">Completed</p>
                <p className="text-2xl font-bold text-gray-900">{stats.completedRequests}</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-red-100 rounded-lg">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <p className="text-xs text-gray-500">Overdue</p>
                <p className="text-2xl font-bold text-red-600">{stats.overdueRequests}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-8">
          {[
            { id: 'requests', label: 'Data Requests', icon: FileText },
            { id: 'reports', label: 'Compliance Reports', icon: BarChart3 },
            { id: 'checks', label: 'Compliance Checks', icon: Shield },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id as typeof activeTab)}
              className={`flex items-center gap-2 px-1 py-4 border-b-2 font-medium text-sm ${
                activeTab === id
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'requests' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search by name or email..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All Types</option>
                <option value="access">Data Access</option>
                <option value="erasure">Erasure</option>
                <option value="portability">Portability</option>
                <option value="rectification">Rectification</option>
              </select>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All Statuses</option>
                <option value="pending">Pending</option>
                <option value="in_progress">In Progress</option>
                <option value="identity_verification">Identity Verification</option>
                <option value="processing">Processing</option>
                <option value="completed">Completed</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
          </div>

          {/* Requests Table */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Request
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Requester
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Type
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Due Date
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Assigned To
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredRequests.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                      No data requests found
                    </td>
                  </tr>
                ) : (
                  filteredRequests.map((request) => (
                    <tr key={request.id} className={`hover:bg-gray-50 ${request.isOverdue ? 'bg-red-50' : ''}`}>
                      <td className="px-4 py-3">
                        <div className="text-sm font-medium text-gray-900">{request.id}</div>
                        <div className="text-xs text-gray-500">{formatDate(request.submittedAt)}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm text-gray-900">{request.requesterName}</div>
                        <div className="text-xs text-gray-500">{request.requesterEmail}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {getRequestTypeIcon(request.requestType)}
                          <span className="text-sm text-gray-900 capitalize">
                            {request.requestType}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(request.status)}`}
                        >
                          {request.status.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className={`text-sm ${request.isOverdue ? 'text-red-600 font-medium' : 'text-gray-900'}`}>
                          {formatDate(request.dueDate)}
                        </div>
                        {request.isOverdue && (
                          <div className="text-xs text-red-500">Overdue</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {request.assignedToName || '-'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setSelectedRequest(request)}
                          className="text-blue-600 hover:text-blue-800"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'reports' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">
              <Plus className="w-4 h-4" />
              Generate Report
            </button>
          </div>

          <div className="grid gap-4">
            {reports.length === 0 ? (
              <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
                No compliance reports found
              </div>
            ) : (
              reports.map((report) => (
                <div
                  key={report.id}
                  className="bg-white rounded-lg border border-gray-200 p-6"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-3">
                        <h3 className="text-lg font-semibold text-gray-900 uppercase">
                          {report.complianceType} Compliance Report
                        </h3>
                        <span
                          className={`px-3 py-1 rounded-full text-sm font-medium ${
                            report.overallScore >= 80
                              ? 'bg-green-100 text-green-800'
                              : report.overallScore >= 60
                              ? 'bg-yellow-100 text-yellow-800'
                              : 'bg-red-100 text-red-800'
                          }`}
                        >
                          Score: {report.overallScore}%
                        </span>
                      </div>
                      <p className="text-sm text-gray-500 mt-1">
                        Period: {formatDate(report.reportPeriodStart)} - {formatDate(report.reportPeriodEnd)}
                      </p>
                    </div>
                    <button className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">
                      <Download className="w-4 h-4" />
                      Download
                    </button>
                  </div>

                  <div className="mt-4 grid grid-cols-4 gap-4">
                    <div className="bg-gray-50 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-gray-900">{report.totalChecks}</p>
                      <p className="text-xs text-gray-500">Total Checks</p>
                    </div>
                    <div className="bg-green-50 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-green-600">{report.passedChecks}</p>
                      <p className="text-xs text-gray-500">Passed</p>
                    </div>
                    <div className="bg-red-50 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-red-600">{report.failedChecks}</p>
                      <p className="text-xs text-gray-500">Failed</p>
                    </div>
                    <div className="bg-yellow-50 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-yellow-600">{report.warnings}</p>
                      <p className="text-xs text-gray-500">Warnings</p>
                    </div>
                  </div>

                  {report.findings.length > 0 && (
                    <div className="mt-4">
                      <h4 className="text-sm font-medium text-gray-700 mb-2">Key Findings</h4>
                      <div className="space-y-2">
                        {report.findings.slice(0, 3).map((finding, idx) => (
                          <div
                            key={idx}
                            className={`flex items-start gap-3 p-3 rounded-lg border ${getComplianceStatusColor(finding.status)}`}
                          >
                            {finding.status === 'pass' ? (
                              <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
                            ) : finding.status === 'fail' ? (
                              <XCircle className="w-5 h-5 flex-shrink-0" />
                            ) : (
                              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
                            )}
                            <div>
                              <p className="text-sm font-medium">{finding.category}</p>
                              <p className="text-sm">{finding.description}</p>
                              {finding.recommendation && (
                                <p className="text-xs mt-1 opacity-75">
                                  Recommendation: {finding.recommendation}
                                </p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="mt-4 pt-4 border-t border-gray-200 flex items-center justify-between text-sm text-gray-500">
                    <span>Generated by {report.generatedByName}</span>
                    <span>{formatDateTime(report.generatedAt)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {activeTab === 'checks' && (
        <div className="space-y-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">GDPR Compliance Checklist</h3>
                <p className="text-sm text-gray-500">
                  Current compliance status based on latest assessments
                </p>
              </div>
              <button className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">
                <RefreshCw className="w-4 h-4" />
                Run Assessment
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {checks.length === 0 ? (
              <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
                No compliance checks found
              </div>
            ) : (
              checks.map((check) => (
                <div
                  key={check.id}
                  className="bg-white rounded-lg border border-gray-200 p-4"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <span
                          className={`inline-flex px-2 py-1 rounded-full text-xs font-medium border ${getComplianceStatusColor(check.status)}`}
                        >
                          {check.status.replace('_', ' ')}
                        </span>
                        <span className="text-sm font-medium text-gray-900">{check.category}</span>
                      </div>
                      <p className="text-sm text-gray-700 mt-2">{check.requirement}</p>
                      <p className="text-sm text-gray-500 mt-1">{check.description}</p>
                      {check.evidence && (
                        <p className="text-xs text-gray-500 mt-2 bg-gray-50 p-2 rounded">
                          Evidence: {check.evidence}
                        </p>
                      )}
                    </div>
                    <div className="text-right text-xs text-gray-500 ml-4">
                      <p>Last checked: {formatDate(check.lastChecked)}</p>
                      <p>Next review: {formatDate(check.nextReview)}</p>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Modals */}
      {selectedRequest && (
        <DataRequestDetailModal
          request={selectedRequest}
          onClose={() => setSelectedRequest(null)}
          onAction={handleRequestAction}
        />
      )}
    </div>
  );
};

export default CompliancePage;
