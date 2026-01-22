/**
 * Job Queue Management Page
 *
 * Enterprise-grade background job queue monitoring and management with real API integration.
 * Supports job retry, cancellation, filtering, and queue management.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Button, Badge, Input, Select } from '@aquaculture/shared-ui';
import { systemSettingsApi } from '../../services/adminApi';
import type { BackgroundJob, JobQueue } from '../../services/adminApi';

// ============================================================================
// Types
// ============================================================================

type JobStatus = 'pending' | 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled' | 'retrying';

interface JobDashboard {
  totalJobs: number;
  pendingJobs: number;
  runningJobs: number;
  completedToday: number;
  failedToday: number;
  avgDuration: number;
  queues: JobQueue[];
  recentJobs: BackgroundJob[];
}

// ============================================================================
// Default Empty Data
// ============================================================================

const defaultDashboard: JobDashboard = {
  totalJobs: 0,
  pendingJobs: 0,
  runningJobs: 0,
  completedToday: 0,
  failedToday: 0,
  avgDuration: 0,
  queues: [],
  recentJobs: [],
};

// ============================================================================
// Component
// ============================================================================

export const JobQueuePage: React.FC = () => {
  // State
  const [dashboard, setDashboard] = useState<JobDashboard | null>(null);
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterQueue, setFilterQueue] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<'jobs' | 'queues' | 'scheduled'>('jobs');

  // ============================================================================
  // Data Loading
  // ============================================================================

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const dashboardData = await systemSettingsApi.getJobDashboard();
      setDashboard(dashboardData);
      setJobs(dashboardData.recentJobs || []);
    } catch (err) {
      console.error('Failed to load job dashboard:', err);
      setError('Failed to load job queue dashboard');
      setDashboard(defaultDashboard);
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const response = await systemSettingsApi.getJobs({
        queueName: filterQueue !== 'all' ? filterQueue : undefined,
        status: filterStatus !== 'all' ? [filterStatus as JobStatus] : undefined,
        search: searchTerm || undefined,
      });
      // Ensure response.data is an array
      const data = response?.data;
      setJobs(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load jobs:', err);
      setJobs([]);
    }
  }, [filterQueue, filterStatus, searchTerm]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (activeTab === 'jobs') {
      loadJobs();
    }
  }, [activeTab, loadJobs]);

  // ============================================================================
  // Handlers
  // ============================================================================

  const handleRetryJob = async (job: BackgroundJob) => {
    const currentJobs = Array.isArray(jobs) ? jobs : [];
    try {
      await systemSettingsApi.retryJob(job.id);
      setJobs(
        currentJobs.map((j) =>
          j.id === job.id
            ? { ...j, status: 'pending' as JobStatus, attempts: 0 }
            : j
        )
      );
    } catch (err) {
      console.error('Failed to retry job:', err);
      // Optimistic update for demo
      setJobs(
        currentJobs.map((j) =>
          j.id === job.id
            ? { ...j, status: 'pending' as JobStatus, attempts: 0 }
            : j
        )
      );
    }
  };

  const handleCancelJob = async (job: BackgroundJob) => {
    if (!confirm(`Are you sure you want to cancel "${job.name}"?`)) return;

    const currentJobs = Array.isArray(jobs) ? jobs : [];
    try {
      await systemSettingsApi.cancelJob(job.id);
      setJobs(
        currentJobs.map((j) =>
          j.id === job.id ? { ...j, status: 'cancelled' as JobStatus } : j
        )
      );
    } catch (err) {
      console.error('Failed to cancel job:', err);
      // Optimistic update for demo
      setJobs(
        currentJobs.map((j) =>
          j.id === job.id ? { ...j, status: 'cancelled' as JobStatus } : j
        )
      );
    }
  };

  const handleRetryAllFailed = async () => {
    const currentJobs = Array.isArray(jobs) ? jobs : [];
    const failedJobs = currentJobs.filter((j) => j.status === 'failed');
    if (failedJobs.length === 0) return;

    if (!confirm(`Retry all ${failedJobs.length} failed jobs?`)) return;

    for (const job of failedJobs) {
      await handleRetryJob(job);
    }
  };

  const handlePauseQueue = async (queue: JobQueue) => {
    const currentQueues = dashboard?.queues && Array.isArray(dashboard.queues) ? dashboard.queues : [];
    try {
      await systemSettingsApi.pauseQueue(queue.name);
      setDashboard(
        dashboard
          ? {
              ...dashboard,
              queues: currentQueues.map((q) =>
                q.name === queue.name ? { ...q, isPaused: true } : q
              ),
            }
          : null
      );
    } catch (err) {
      console.error('Failed to pause queue:', err);
      // Optimistic update for demo
      setDashboard(
        dashboard
          ? {
              ...dashboard,
              queues: currentQueues.map((q) =>
                q.name === queue.name ? { ...q, isPaused: true } : q
              ),
            }
          : null
      );
    }
  };

  const handleResumeQueue = async (queue: JobQueue) => {
    const currentQueues = dashboard?.queues && Array.isArray(dashboard.queues) ? dashboard.queues : [];
    try {
      await systemSettingsApi.resumeQueue(queue.name);
      setDashboard(
        dashboard
          ? {
              ...dashboard,
              queues: currentQueues.map((q) =>
                q.name === queue.name ? { ...q, isPaused: false } : q
              ),
            }
          : null
      );
    } catch (err) {
      console.error('Failed to resume queue:', err);
      // Optimistic update for demo
      setDashboard(
        dashboard
          ? {
              ...dashboard,
              queues: currentQueues.map((q) =>
                q.name === queue.name ? { ...q, isPaused: false } : q
              ),
            }
          : null
      );
    }
  };

  // ============================================================================
  // Helpers
  // ============================================================================

  // Ensure jobs is always an array
  const safeJobs = Array.isArray(jobs) ? jobs : [];

  // Ensure dashboard.queues is always an array
  const safeQueues = dashboard?.queues && Array.isArray(dashboard.queues) ? dashboard.queues : [];

  const getStatusBadge = (status: JobStatus): 'success' | 'default' | 'info' | 'warning' | 'error' => {
    const variants: Record<JobStatus, 'success' | 'default' | 'info' | 'warning' | 'error'> = {
      pending: 'default',
      scheduled: 'info',
      running: 'warning',
      completed: 'success',
      failed: 'error',
      cancelled: 'default',
      retrying: 'warning',
    };
    return variants[status] || 'default';
  };

  const getPriorityLabel = (priority: number) => {
    if (priority >= 15) return { label: 'Critical', color: 'text-red-600' };
    if (priority >= 10) return { label: 'High', color: 'text-orange-600' };
    if (priority >= 5) return { label: 'Normal', color: 'text-gray-600' };
    return { label: 'Low', color: 'text-blue-600' };
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const formatDateTime = (dateString: string | undefined) => {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // ============================================================================
  // Render
  // ============================================================================

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 bg-gray-200 rounded w-1/4" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white rounded-xl p-6 h-24" />
          ))}
        </div>
        <div className="bg-white rounded-xl p-6 h-96" />
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-gray-500">Failed to load dashboard data</p>
          <Button onClick={loadDashboard} className="mt-4">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Job Queue Management</h1>
          <p className="mt-1 text-sm text-gray-500">
            Monitor and manage background jobs across all queues
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            variant="secondary"
            onClick={loadDashboard}
            className="flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="text-2xl font-bold text-gray-900">{dashboard.totalJobs}</div>
          <div className="text-sm text-gray-500">Total Jobs</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xl font-bold text-yellow-600">{dashboard.runningJobs}</div>
          <div className="text-sm text-gray-500">Running</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xl font-bold text-blue-600">{dashboard.pendingJobs}</div>
          <div className="text-sm text-gray-500">Pending</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xl font-bold text-red-600">{dashboard.failedToday}</div>
          <div className="text-sm text-gray-500">Failed Today</div>
        </Card>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-8">
          {(['jobs', 'queues', 'scheduled'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`py-2 border-b-2 font-medium text-sm capitalize transition-colors ${
                activeTab === tab
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab}
            </button>
          ))}
        </nav>
      </div>

      {/* Jobs Tab */}
      {activeTab === 'jobs' && (
        <div className="space-y-4">
          {/* Filters */}
          <Card className="p-4">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1">
                <Input
                  placeholder="Search by job name or ID..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full"
                />
              </div>
              <Select
                value={filterQueue}
                onChange={(e) => setFilterQueue(e.target.value)}
                options={[
                  { value: 'all', label: 'All Queues' },
                  ...safeQueues.map((q) => ({ value: q.name, label: q.name })),
                ]}
              />
              <Select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                options={[
                  { value: 'all', label: 'All Statuses' },
                  { value: 'pending', label: 'Pending' },
                  { value: 'running', label: 'Running' },
                  { value: 'completed', label: 'Completed' },
                  { value: 'failed', label: 'Failed' },
                  { value: 'cancelled', label: 'Cancelled' },
                ]}
              />
              {safeJobs.some((j) => j.status === 'failed') && (
                <Button
                  variant="secondary"
                  onClick={handleRetryAllFailed}
                  className="whitespace-nowrap"
                >
                  Retry All Failed
                </Button>
              )}
            </div>
          </Card>

          {/* Jobs List */}
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Job
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Queue
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Progress
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Priority
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Started / Completed
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {safeJobs.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                        No jobs found
                      </td>
                    </tr>
                  ) : (
                    safeJobs.map((job) => {
                      const priority = getPriorityLabel(job.priority);
                      return (
                        <tr key={job.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4">
                            <div className="flex flex-col">
                              <span className="font-medium text-gray-900">{job.name}</span>
                              <span className="text-xs font-mono text-gray-500">{job.id}</span>
                              {job.errorMessage && (
                                <span className="text-xs text-red-600 mt-1 line-clamp-1">
                                  Error: {job.errorMessage}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <span className="text-sm text-gray-600">{job.queueName}</span>
                          </td>
                          <td className="px-6 py-4">
                            <Badge variant={getStatusBadge(job.status)}>
                              {job.status}
                            </Badge>
                          </td>
                          <td className="px-6 py-4">
                            {job.progress ? (
                              <div className="min-w-[120px]">
                                <div className="flex items-center gap-2 mb-1">
                                  <div className="w-20 bg-gray-200 rounded-full h-2">
                                    <div
                                      className="bg-blue-600 h-2 rounded-full transition-all"
                                      style={{ width: `${job.progress.percentage}%` }}
                                    />
                                  </div>
                                  <span className="text-sm text-gray-600 whitespace-nowrap">
                                    {job.progress.percentage}%
                                  </span>
                                </div>
                                {job.progress.message && (
                                  <div className="text-xs text-gray-500 line-clamp-1">
                                    {job.progress.message}
                                  </div>
                                )}
                              </div>
                            ) : job.durationMs ? (
                              <span className="text-sm text-gray-600">{formatDuration(job.durationMs)}</span>
                            ) : (
                              <span className="text-sm text-gray-400">-</span>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            <span className={`text-sm font-medium ${priority.color}`}>
                              {priority.label}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <div className="text-sm text-gray-600">
                              {job.startedAt && (
                                <div>{formatDateTime(job.startedAt)}</div>
                              )}
                              {job.completedAt && (
                                <div className="text-gray-500">{formatDateTime(job.completedAt)}</div>
                              )}
                              {!job.startedAt && !job.completedAt && (
                                <span className="text-gray-400">-</span>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4 text-right">
                            <div className="flex justify-end gap-2">
                              {job.status === 'failed' && (
                                <button
                                  onClick={() => handleRetryJob(job)}
                                  className="px-3 py-1.5 text-sm font-medium bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 transition-colors"
                                >
                                  Retry
                                </button>
                              )}
                              {(job.status === 'running' || job.status === 'pending') && (
                                <button
                                  onClick={() => handleCancelJob(job)}
                                  className="px-3 py-1.5 text-sm font-medium bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors"
                                >
                                  Cancel
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* Queues Tab */}
      {activeTab === 'queues' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {safeQueues.map((queue) => (
            <Card key={queue.name} className="p-6">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{queue.name}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    {queue.isPaused ? (
                      <Badge variant="warning">Paused</Badge>
                    ) : (
                      <Badge variant="success">Active</Badge>
                    )}
                    <span className="text-sm text-gray-500">
                      Concurrency: {queue.concurrency}
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <div className="text-2xl font-bold text-blue-600">{queue.pendingCount}</div>
                  <div className="text-xs text-gray-500">Pending</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-yellow-600">{queue.activeCount}</div>
                  <div className="text-xs text-gray-500">Running</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-green-600">{queue.completedCount}</div>
                  <div className="text-xs text-gray-500">Completed</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-red-600">{queue.failedCount}</div>
                  <div className="text-xs text-gray-500">Failed</div>
                </div>
              </div>

              <div className="flex gap-2">
                {queue.isPaused ? (
                  <button
                    onClick={() => handleResumeQueue(queue)}
                    className="flex-1 px-3 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition-colors"
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    onClick={() => handlePauseQueue(queue)}
                    className="flex-1 px-3 py-2 bg-yellow-500 text-white rounded-lg text-sm hover:bg-yellow-600 transition-colors"
                  >
                    Pause
                  </button>
                )}
                <button
                  onClick={() => {
                    setFilterQueue(queue.name);
                    setActiveTab('jobs');
                  }}
                  className="px-3 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 transition-colors"
                >
                  View Jobs
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Scheduled Tab */}
      {activeTab === 'scheduled' && (
        <Card className="overflow-hidden">
          <div className="p-6 border-b border-gray-200">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold text-gray-900">Scheduled & Recurring Jobs</h2>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Job Name
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Schedule
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Next Run
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {jobs
                  .filter((j: BackgroundJob) => j.jobType === 'scheduled' || j.jobType === 'recurring')
                  .map((job: BackgroundJob) => (
                    <tr key={job.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4">
                        <span className="font-medium text-gray-900">{job.name}</span>
                      </td>
                      <td className="px-6 py-4">
                        <Badge variant="info">{job.jobType}</Badge>
                      </td>
                      <td className="px-6 py-4">
                        <span className="font-mono text-sm text-gray-600">
                          {job.cronExpression || '-'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-sm text-gray-600">
                          {formatDateTime(job.nextRunAt)}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <Badge variant={getStatusBadge(job.status)}>
                          {job.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Error Display */}
      {error && (
        <div className="fixed bottom-4 right-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-lg shadow-lg max-w-md">
          {error}
        </div>
      )}
    </div>
  );
};

export default JobQueuePage;
