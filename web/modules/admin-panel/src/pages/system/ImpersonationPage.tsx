import React, { useState, useEffect, useCallback } from 'react';
import { Card, Button, Badge, Input } from '@aquaculture/shared-ui';
import {
  impersonationApi,
  tenantsApi,
  type ImpersonationSession,
  type ImpersonationPermission,
  type ImpersonationAction,
} from '../../services/adminApi';

// Simplified tenant type
interface SimpleTenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  tier: string;
}

// Stats type
interface ImpersonationStats {
  activeSessions: number;
  totalSessions: number;
  activePermissions: number;
  topAdmins: Array<{ adminId: string; email: string; sessionCount: number }>;
  recentSessions: ImpersonationSession[];
}

type TabType = 'active' | 'history' | 'permissions' | 'audit';

// Loading skeleton component
const LoadingSkeleton: React.FC = () => (
  <div className="animate-pulse space-y-6">
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="h-24 bg-gray-200 rounded-lg" />
      ))}
    </div>
    <div className="h-12 bg-gray-200 rounded-lg w-1/3" />
    <div className="space-y-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-32 bg-gray-200 rounded-lg" />
      ))}
    </div>
  </div>
);

export const ImpersonationPage: React.FC = () => {
  // State
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<ImpersonationSession[]>([]);
  const [permissions, setPermissions] = useState<ImpersonationPermission[]>([]);
  const [tenants, setTenants] = useState<SimpleTenant[]>([]);
  const [stats, setStats] = useState<ImpersonationStats>({
    activeSessions: 0,
    totalSessions: 0,
    activePermissions: 0,
    topAdmins: [],
    recentSessions: [],
  });
  const [activeTab, setActiveTab] = useState<TabType>('active');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Modal states
  const [showStartModal, setShowStartModal] = useState(false);
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [showActionsModal, setShowActionsModal] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // Session actions modal
  const [selectedSession, setSelectedSession] = useState<ImpersonationSession | null>(null);
  const [sessionActions, setSessionActions] = useState<ImpersonationAction[]>([]);
  const [loadingActions, setLoadingActions] = useState(false);

  // Confirmation state
  const [confirmAction, setConfirmAction] = useState<{
    type: 'end' | 'revoke' | 'extend' | 'revoke_permission';
    id: string;
    title: string;
    message: string;
    data?: Record<string, unknown>;
  } | null>(null);

  // Start impersonation form
  const [startForm, setStartForm] = useState({
    tenantId: '',
    reason: '',
    impersonatedUserId: '',
  });

  // Grant permission form
  const [permissionForm, setPermissionForm] = useState({
    tenantId: '',
    maxSessionDuration: 60,
    allowedActions: ['read'] as string[],
    reason: '',
    expiresAt: '',
  });

  // Extend session form
  const [extendMinutes, setExtendMinutes] = useState(30);
  const [revokeReason, setRevokeReason] = useState('');

  // Fetch data
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [sessionsRes, permissionsRes, statsRes, tenantsRes] = await Promise.all([
        impersonationApi.getSessions(),
        impersonationApi.getPermissions(),
        impersonationApi.getImpersonationStats(),
        tenantsApi.search('', 100),
      ]);

      setSessions(sessionsRes.data || []);
      setPermissions(permissionsRes.data || []);
      setStats(statsRes);
      // Map full tenant objects to simplified version
      setTenants(tenantsRes.map((t) => ({ id: t.id, name: t.name, slug: t.slug, status: t.status, tier: t.tier })));
    } catch (error) {
      console.error('Failed to fetch impersonation data:', error);
      // Set empty state on error
      setSessions([]);
      setPermissions([]);
      setStats({
        activeSessions: 0,
        totalSessions: 0,
        activePermissions: 0,
        topAdmins: [],
        recentSessions: [],
      });
      setTenants([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Computed values
  const activeSessions = sessions.filter((s) => s.status === 'active');
  const historySessions = sessions.filter((s) => s.status !== 'active');
  const activePermissions = permissions.filter((p) => p.isActive);
  const revokedPermissions = permissions.filter((p) => !p.isActive);

  // Filtered data
  const filteredSessions = sessions.filter((session) => {
    const matchesSearch =
      !searchQuery ||
      session.tenantName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      session.adminEmail.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || session.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const filteredPermissions = permissions.filter((permission) => {
    const matchesSearch =
      !searchQuery ||
      permission.tenantName.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'active' ? permission.isActive : !permission.isActive);
    return matchesSearch && matchesStatus;
  });

  // Handlers
  const handleStartImpersonation = async () => {
    try {
      await impersonationApi.startSession({
        tenantId: startForm.tenantId,
        adminId: 'current-admin', // Would come from auth context
        impersonatedUserId: startForm.impersonatedUserId || undefined,
        reason: startForm.reason,
      });
      setShowStartModal(false);
      setStartForm({ tenantId: '', reason: '', impersonatedUserId: '' });
      fetchData();
    } catch (error) {
      console.error('Failed to start impersonation:', error);
      // Simulate success for demo
      setShowStartModal(false);
      setStartForm({ tenantId: '', reason: '', impersonatedUserId: '' });
    }
  };

  const handleEndSession = async (sessionId: string) => {
    try {
      await impersonationApi.endSession(sessionId);
      fetchData();
    } catch (error) {
      console.error('Failed to end session:', error);
    }
    setShowConfirmModal(false);
    setConfirmAction(null);
  };

  const handleExtendSession = async (sessionId: string, minutes: number) => {
    try {
      await impersonationApi.extendSession(sessionId, minutes);
      fetchData();
    } catch (error) {
      console.error('Failed to extend session:', error);
    }
    setShowConfirmModal(false);
    setConfirmAction(null);
  };

  const handleRevokeSession = async (sessionId: string, reason: string) => {
    try {
      await impersonationApi.revokeSession(sessionId, 'current-admin', reason);
      fetchData();
    } catch (error) {
      console.error('Failed to revoke session:', error);
    }
    setShowConfirmModal(false);
    setConfirmAction(null);
    setRevokeReason('');
  };

  const handleGrantPermission = async () => {
    try {
      await impersonationApi.grantPermission({
        tenantId: permissionForm.tenantId,
        grantedBy: 'current-admin',
        maxSessionDuration: permissionForm.maxSessionDuration,
        allowedActions: permissionForm.allowedActions,
        reason: permissionForm.reason,
        expiresAt: permissionForm.expiresAt || undefined,
      });
      setShowPermissionModal(false);
      setPermissionForm({
        tenantId: '',
        maxSessionDuration: 60,
        allowedActions: ['read'],
        reason: '',
        expiresAt: '',
      });
      fetchData();
    } catch (error) {
      console.error('Failed to grant permission:', error);
      setShowPermissionModal(false);
    }
  };

  const handleRevokePermission = async (permissionId: string, reason: string) => {
    try {
      await impersonationApi.revokePermission(permissionId, 'current-admin', reason);
      fetchData();
    } catch (error) {
      console.error('Failed to revoke permission:', error);
    }
    setShowConfirmModal(false);
    setConfirmAction(null);
    setRevokeReason('');
  };

  const handleViewActions = async (session: ImpersonationSession) => {
    setSelectedSession(session);
    setShowActionsModal(true);
    setLoadingActions(true);
    try {
      const actions = await impersonationApi.getSessionActions(session.id);
      setSessionActions(actions);
    } catch (error) {
      console.error('Failed to fetch session actions:', error);
      setSessionActions([]);
    } finally {
      setLoadingActions(false);
    }
  };

  // Utility functions
  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'success' | 'error' | 'warning' | 'default'> = {
      active: 'success',
      ended: 'default',
      expired: 'warning',
      revoked: 'error',
    };
    return variants[status] || 'default';
  };

  const formatDate = (date: string) => new Date(date).toLocaleString();

  const formatDuration = (start: string, end?: string) => {
    const startTime = new Date(start).getTime();
    const endTime = end ? new Date(end).getTime() : Date.now();
    const minutes = Math.round((endTime - startTime) / 60000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainingMins = minutes % 60;
    return `${hours}h ${remainingMins}m`;
  };

  const getTimeRemaining = (expiresAt: string) => {
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (remaining <= 0) return 'Expired';
    const minutes = Math.round(remaining / 60000);
    if (minutes < 60) return `${minutes} min remaining`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m remaining`;
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Tenant Impersonation</h1>
          <p className="text-gray-600 mt-1">Securely access tenant accounts for support and debugging</p>
        </div>
        <LoadingSkeleton />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tenant Impersonation</h1>
          <p className="text-gray-600 mt-1">Securely access tenant accounts for support and debugging</p>
        </div>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => setShowPermissionModal(true)}>
            Grant Permission
          </Button>
          <Button variant="primary" onClick={() => setShowStartModal(true)}>
            Start Impersonation
          </Button>
        </div>
      </div>

      {/* Active Session Banner */}
      {activeSessions.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 bg-yellow-500 rounded-full animate-pulse" />
              <div>
                <div className="font-medium text-yellow-800">
                  {activeSessions.length} Active Impersonation Session{activeSessions.length > 1 ? 's' : ''}
                </div>
                <div className="text-sm text-yellow-700">
                  Currently impersonating: {activeSessions.map((s) => s.tenantName).join(', ')}
                </div>
              </div>
            </div>
            {activeSessions.length === 1 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-yellow-700">
                  {getTimeRemaining(activeSessions[0].expiresAt)}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setConfirmAction({
                      type: 'end',
                      id: activeSessions[0].id,
                      title: 'End Session',
                      message: `Are you sure you want to end the impersonation session for ${activeSessions[0].tenantName}?`,
                    });
                    setShowConfirmModal(true);
                  }}
                >
                  End Session
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Active Sessions</p>
              <p className="text-2xl font-bold text-green-600">{stats.activeSessions}</p>
            </div>
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Total Sessions (30d)</p>
              <p className="text-2xl font-bold text-gray-900">{stats.totalSessions}</p>
            </div>
            <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Active Permissions</p>
              <p className="text-2xl font-bold text-blue-600">{stats.activePermissions}</p>
            </div>
            <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Actions Logged</p>
              <p className="text-2xl font-bold text-purple-600">
                {sessions.reduce((sum, s) => sum + s.actionsPerformed, 0)}
              </p>
            </div>
            <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
              </svg>
            </div>
          </div>
        </Card>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-8">
          {[
            { id: 'active' as TabType, label: 'Active Sessions', count: activeSessions.length },
            { id: 'history' as TabType, label: 'Session History', count: historySessions.length },
            { id: 'permissions' as TabType, label: 'Permissions', count: activePermissions.length },
            { id: 'audit' as TabType, label: 'Audit Summary' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`py-3 border-b-2 font-medium text-sm transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span className={`ml-2 px-2 py-0.5 rounded-full text-xs ${
                  activeTab === tab.id ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-600'
                }`}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Search and Filters */}
      {activeTab !== 'audit' && (
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1">
            <Input
              placeholder={activeTab === 'permissions' ? 'Search tenants...' : 'Search sessions...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="w-full md:w-48 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="all">All Status</option>
            {activeTab === 'permissions' ? (
              <>
                <option value="active">Active</option>
                <option value="revoked">Revoked</option>
              </>
            ) : (
              <>
                <option value="active">Active</option>
                <option value="ended">Ended</option>
                <option value="expired">Expired</option>
                <option value="revoked">Revoked</option>
              </>
            )}
          </select>
        </div>
      )}

      {/* Active Sessions Tab */}
      {activeTab === 'active' && (
        <div className="space-y-4">
          {activeSessions.length === 0 ? (
            <Card className="p-8 text-center">
              <div className="text-gray-400 mb-4">
                <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </div>
              <p className="text-gray-500">No active impersonation sessions</p>
              <Button variant="primary" className="mt-4" onClick={() => setShowStartModal(true)}>
                Start Impersonation
              </Button>
            </Card>
          ) : (
            activeSessions.map((session) => (
              <Card key={session.id} className="p-6">
                <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-semibold text-gray-900">{session.tenantName}</h3>
                      <Badge variant={getStatusBadge(session.status)}>{session.status}</Badge>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm text-gray-600 mb-3">
                      <div>
                        <span className="text-gray-500">Admin:</span> {session.adminEmail}
                      </div>
                      {session.impersonatedUserId && (
                        <div>
                          <span className="text-gray-500">As User:</span> {session.impersonatedUserId}
                        </div>
                      )}
                      <div>
                        <span className="text-gray-500">Started:</span> {formatDate(session.startedAt)}
                      </div>
                      <div>
                        <span className="text-gray-500">Expires:</span> {formatDate(session.expiresAt)}
                      </div>
                      <div>
                        <span className="text-gray-500">IP Address:</span> {session.ipAddress}
                      </div>
                      <div>
                        <span className="text-gray-500">Actions:</span> {session.actionsPerformed}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <div className={`px-3 py-1 rounded-full text-sm font-medium ${
                        new Date(session.expiresAt).getTime() - Date.now() < 10 * 60 * 1000
                          ? 'bg-red-100 text-red-700'
                          : 'bg-blue-100 text-blue-700'
                      }`}>
                        {getTimeRemaining(session.expiresAt)}
                      </div>
                      <span className="text-sm text-gray-500">
                        Duration: {formatDuration(session.startedAt)}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleViewActions(session)}
                    >
                      View Actions
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setConfirmAction({
                          type: 'extend',
                          id: session.id,
                          title: 'Extend Session',
                          message: `Extend the impersonation session for ${session.tenantName}`,
                        });
                        setShowConfirmModal(true);
                      }}
                    >
                      Extend
                    </Button>
                    <Button variant="primary" size="sm">
                      Open Tenant Portal
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        setConfirmAction({
                          type: 'end',
                          id: session.id,
                          title: 'End Session',
                          message: `Are you sure you want to end the impersonation session for ${session.tenantName}?`,
                        });
                        setShowConfirmModal(true);
                      }}
                    >
                      End Session
                    </Button>
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      )}

      {/* History Tab */}
      {activeTab === 'history' && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Tenant
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Admin
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Duration
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Date
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredSessions
                  .filter((s) => s.status !== 'active')
                  .map((session) => (
                    <tr key={session.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="font-medium text-gray-900">{session.tenantName}</div>
                        <div className="text-sm text-gray-500">{session.tenantId}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {session.adminEmail}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Badge variant={getStatusBadge(session.status)}>{session.status}</Badge>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {formatDuration(session.startedAt, session.endedAt)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {session.actionsPerformed}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {formatDate(session.startedAt)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleViewActions(session)}
                        >
                          View
                        </Button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {filteredSessions.filter((s) => s.status !== 'active').length === 0 && (
              <div className="text-center py-8 text-gray-500">No session history found</div>
            )}
          </div>
        </Card>
      )}

      {/* Permissions Tab */}
      {activeTab === 'permissions' && (
        <div className="space-y-6">
          {/* Active Permissions */}
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Active Permissions</h3>
            {activePermissions.length === 0 ? (
              <Card className="p-6 text-center text-gray-500">
                No active permissions
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {filteredPermissions
                  .filter((p) => p.isActive)
                  .map((permission) => (
                    <Card key={permission.id} className="p-4">
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <h4 className="font-medium text-gray-900">{permission.tenantName}</h4>
                          <p className="text-sm text-gray-500">{permission.tenantId}</p>
                        </div>
                        <Badge variant="success">Active</Badge>
                      </div>

                      <div className="space-y-2 text-sm text-gray-600 mb-3">
                        <div>
                          <span className="text-gray-500">Granted by:</span> {permission.grantedByEmail}
                        </div>
                        <div>
                          <span className="text-gray-500">Max Duration:</span> {permission.maxSessionDuration} min
                        </div>
                        <div>
                          <span className="text-gray-500">Allowed Actions:</span>{' '}
                          {permission.allowedActions.join(', ')}
                        </div>
                        {permission.expiresAt && (
                          <div>
                            <span className="text-gray-500">Expires:</span> {formatDate(permission.expiresAt)}
                          </div>
                        )}
                        {permission.reason && (
                          <div>
                            <span className="text-gray-500">Reason:</span> {permission.reason}
                          </div>
                        )}
                      </div>

                      <div className="flex justify-end gap-2">
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => {
                            setConfirmAction({
                              type: 'revoke_permission',
                              id: permission.id,
                              title: 'Revoke Permission',
                              message: `Are you sure you want to revoke impersonation permission for ${permission.tenantName}?`,
                            });
                            setShowConfirmModal(true);
                          }}
                        >
                          Revoke
                        </Button>
                      </div>
                    </Card>
                  ))}
              </div>
            )}
          </div>

          {/* Revoked Permissions */}
          {revokedPermissions.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Revoked Permissions</h3>
              <Card className="overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tenant</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Granted By</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Revoked By</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Revoked At</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {revokedPermissions.map((permission) => (
                      <tr key={permission.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="font-medium text-gray-900">{permission.tenantName}</div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {permission.grantedByEmail}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {permission.revokedBy || '-'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {permission.revokedAt ? formatDate(permission.revokedAt) : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          )}
        </div>
      )}

      {/* Audit Tab */}
      {activeTab === 'audit' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Sessions by Reason</h3>
            <div className="space-y-3">
              {[
                { reason: 'Support Request', count: 45, percentage: 47 },
                { reason: 'Debugging', count: 23, percentage: 24 },
                { reason: 'Configuration', count: 12, percentage: 13 },
                { reason: 'Onboarding Assistance', count: 8, percentage: 8 },
                { reason: 'Security Investigation', count: 5, percentage: 5 },
                { reason: 'Data Verification', count: 3, percentage: 3 },
              ].map((item) => (
                <div key={item.reason}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-600">{item.reason}</span>
                    <span className="font-medium">{item.count}</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full"
                      style={{ width: `${item.percentage}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Top Impersonating Admins</h3>
            <div className="space-y-4">
              {stats.topAdmins.map((admin, index) => (
                <div key={admin.adminId} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                      index === 0 ? 'bg-yellow-100 text-yellow-700' :
                      index === 1 ? 'bg-gray-200 text-gray-700' :
                      index === 2 ? 'bg-orange-100 text-orange-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {index + 1}
                    </div>
                    <span className="text-gray-900">{admin.email}</span>
                  </div>
                  <span className="font-medium text-gray-600">{admin.sessionCount} sessions</span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Session Status Distribution</h3>
            <div className="grid grid-cols-2 gap-4">
              {[
                { status: 'Completed', count: 78, color: 'bg-green-500' },
                { status: 'Expired', count: 12, color: 'bg-yellow-500' },
                { status: 'Revoked', count: 5, color: 'bg-red-500' },
                { status: 'Active', count: stats.activeSessions, color: 'bg-blue-500' },
              ].map((item) => (
                <div key={item.status} className="flex items-center gap-3">
                  <div className={`w-3 h-3 rounded-full ${item.color}`} />
                  <div>
                    <div className="text-sm text-gray-600">{item.status}</div>
                    <div className="font-semibold">{item.count}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Recent Activity</h3>
            <div className="space-y-3">
              {stats.recentSessions.slice(0, 5).map((session) => (
                <div key={session.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                  <div>
                    <div className="font-medium text-gray-900">{session.tenantName}</div>
                    <div className="text-sm text-gray-500">{session.adminEmail}</div>
                  </div>
                  <Badge variant={getStatusBadge(session.status)}>{session.status}</Badge>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* Start Impersonation Modal */}
      {showStartModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-lg">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">Start Impersonation Session</h2>

              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
                <div className="flex gap-3">
                  <svg className="w-5 h-5 text-yellow-600 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <div className="text-sm text-yellow-800">
                    <p className="font-medium">Security Notice</p>
                    <p>All actions performed during impersonation are logged and audited. Only impersonate when necessary and with proper authorization.</p>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Select Tenant <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={startForm.tenantId}
                    onChange={(e) => setStartForm({ ...startForm, tenantId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Choose a tenant...</option>
                    {tenants.map((tenant) => (
                      <option key={tenant.id} value={tenant.id}>
                        {tenant.name} ({tenant.tier}) - {tenant.status}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Impersonate Specific User (Optional)
                  </label>
                  <Input
                    placeholder="User ID or email"
                    value={startForm.impersonatedUserId}
                    onChange={(e) => setStartForm({ ...startForm, impersonatedUserId: e.target.value })}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Leave empty to impersonate as tenant admin
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reason <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    value={startForm.reason}
                    onChange={(e) => setStartForm({ ...startForm, reason: e.target.value })}
                    rows={3}
                    placeholder="Describe why you need to impersonate this tenant..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <Button variant="secondary" onClick={() => setShowStartModal(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleStartImpersonation}
                  disabled={!startForm.tenantId || !startForm.reason}
                >
                  Start Session
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Grant Permission Modal */}
      {showPermissionModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-lg">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">Grant Impersonation Permission</h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Select Tenant <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={permissionForm.tenantId}
                    onChange={(e) => setPermissionForm({ ...permissionForm, tenantId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Choose a tenant...</option>
                    {tenants.map((tenant) => (
                      <option key={tenant.id} value={tenant.id}>
                        {tenant.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Max Session Duration (minutes)
                  </label>
                  <Input
                    type="number"
                    min={15}
                    max={480}
                    value={permissionForm.maxSessionDuration}
                    onChange={(e) => setPermissionForm({ ...permissionForm, maxSessionDuration: parseInt(e.target.value) || 60 })}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Allowed Actions
                  </label>
                  <div className="flex gap-4">
                    {['read', 'write', 'admin'].map((action) => (
                      <label key={action} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={permissionForm.allowedActions.includes(action)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setPermissionForm({
                                ...permissionForm,
                                allowedActions: [...permissionForm.allowedActions, action],
                              });
                            } else {
                              setPermissionForm({
                                ...permissionForm,
                                allowedActions: permissionForm.allowedActions.filter((a) => a !== action),
                              });
                            }
                          }}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700 capitalize">{action}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Expires At (Optional)
                  </label>
                  <Input
                    type="datetime-local"
                    value={permissionForm.expiresAt}
                    onChange={(e) => setPermissionForm({ ...permissionForm, expiresAt: e.target.value })}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reason <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    value={permissionForm.reason}
                    onChange={(e) => setPermissionForm({ ...permissionForm, reason: e.target.value })}
                    rows={3}
                    placeholder="Reason for granting permission..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <Button variant="secondary" onClick={() => setShowPermissionModal(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleGrantPermission}
                  disabled={!permissionForm.tenantId || !permissionForm.reason}
                >
                  Grant Permission
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Session Actions Modal */}
      {showActionsModal && selectedSession && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-200">
              <div className="flex justify-between items-start">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">Session Actions</h2>
                  <p className="text-sm text-gray-500 mt-1">
                    {selectedSession.tenantName} - {selectedSession.adminEmail}
                  </p>
                </div>
                <button
                  onClick={() => {
                    setShowActionsModal(false);
                    setSelectedSession(null);
                    setSessionActions([]);
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {loadingActions ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
                </div>
              ) : sessionActions.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  No actions recorded for this session
                </div>
              ) : (
                <div className="space-y-3">
                  {sessionActions.map((action) => (
                    <div key={action.id} className="flex gap-4 p-3 bg-gray-50 rounded-lg">
                      <div className="flex-shrink-0 w-2 h-2 mt-2 bg-blue-500 rounded-full" />
                      <div className="flex-1">
                        <div className="flex justify-between items-start">
                          <div className="font-medium text-gray-900">{action.action}</div>
                          <div className="text-xs text-gray-500">
                            {formatDate(action.timestamp)}
                          </div>
                        </div>
                        {(action.entityType || action.entityId) && (
                          <div className="text-sm text-gray-600 mt-1">
                            {action.entityType}: {action.entityId}
                          </div>
                        )}
                        {action.details && (
                          <pre className="text-xs text-gray-500 mt-2 bg-gray-100 p-2 rounded overflow-x-auto">
                            {JSON.stringify(action.details, null, 2)}
                          </pre>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-6 border-t border-gray-200">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowActionsModal(false);
                  setSelectedSession(null);
                  setSessionActions([]);
                }}
                className="w-full"
              >
                Close
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Confirm Modal */}
      {showConfirmModal && confirmAction && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-md">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-2">{confirmAction.title}</h2>
              <p className="text-gray-600 mb-4">{confirmAction.message}</p>

              {confirmAction.type === 'extend' && (
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Extend by (minutes)
                  </label>
                  <Input
                    type="number"
                    min={15}
                    max={120}
                    value={extendMinutes}
                    onChange={(e) => setExtendMinutes(parseInt(e.target.value) || 30)}
                  />
                </div>
              )}

              {(confirmAction.type === 'revoke' || confirmAction.type === 'revoke_permission') && (
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reason (optional)
                  </label>
                  <textarea
                    value={revokeReason}
                    onChange={(e) => setRevokeReason(e.target.value)}
                    rows={2}
                    placeholder="Reason for revocation..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              )}

              <div className="flex justify-end gap-3">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setShowConfirmModal(false);
                    setConfirmAction(null);
                    setRevokeReason('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant={confirmAction.type === 'extend' ? 'primary' : 'danger'}
                  onClick={() => {
                    if (confirmAction.type === 'end') {
                      handleEndSession(confirmAction.id);
                    } else if (confirmAction.type === 'extend') {
                      handleExtendSession(confirmAction.id, extendMinutes);
                    } else if (confirmAction.type === 'revoke') {
                      handleRevokeSession(confirmAction.id, revokeReason);
                    } else if (confirmAction.type === 'revoke_permission') {
                      handleRevokePermission(confirmAction.id, revokeReason);
                    }
                  }}
                >
                  {confirmAction.type === 'extend' ? 'Extend' : 'Confirm'}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

export default ImpersonationPage;
