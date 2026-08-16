import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card } from '@aquaculture/shared-ui';
import { systemSettingsApi } from '../../services/adminApi';
import type { BackgroundJob } from '../../services/adminApi';
import type { AdminApiRouteResponse } from '../../services/types/generated/admin-route-contracts';
import { adminApiErrorMessage } from '../../services/http-client';

type JobDashboard = AdminApiRouteResponse<'GET /system/jobs/dashboard'>;

const statusVariant = (
  status: BackgroundJob['status'],
): 'success' | 'error' | 'warning' | 'info' | 'default' => {
  if (status === 'completed') return 'success';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running' || status === 'retrying') return 'info';
  if (status === 'pending' || status === 'scheduled') return 'warning';
  return 'default';
};

const JobQueuePage: React.FC = () => {
  const [dashboard, setDashboard] = useState<JobDashboard | null>(null);
  const [jobs, setJobs] = useState<readonly BackgroundJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [nextDashboard, jobPage] = await Promise.all([
        systemSettingsApi.getJobDashboard(),
        systemSettingsApi.getJobs({ limit: 50 }),
      ]);
      setDashboard(nextDashboard);
      setJobs(jobPage.items);
    } catch (cause: unknown) {
      setDashboard(null);
      setJobs([]);
      setError(adminApiErrorMessage(cause, 'Failed to load job queue state.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const retryJob = useCallback(
    async (job: BackgroundJob): Promise<void> => {
      setMutatingId(job.id);
      setError(null);
      try {
        await systemSettingsApi.retryJob(job.id);
        await loadData();
      } catch (cause: unknown) {
        setError(adminApiErrorMessage(cause, 'Failed to retry job.'));
      } finally {
        setMutatingId(null);
      }
    },
    [loadData],
  );

  const cancelJob = useCallback(
    async (job: BackgroundJob): Promise<void> => {
      setMutatingId(job.id);
      setError(null);
      try {
        await systemSettingsApi.cancelJob(job.id);
        await loadData();
      } catch (cause: unknown) {
        setError(adminApiErrorMessage(cause, 'Failed to cancel job.'));
      } finally {
        setMutatingId(null);
      }
    },
    [loadData],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Job Queue</h1>
          <p className="mt-1 text-sm text-gray-500">
            Queue throughput, failures, scheduling, and execution state.
          </p>
        </div>
        <Button size="sm" variant="secondary" disabled={loading} onClick={() => void loadData()}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
        {[
          ['Total', dashboard?.totalJobs],
          ['Pending', dashboard?.pendingJobs],
          ['Running', dashboard?.runningJobs],
          ['Failed', dashboard?.failedJobs],
          ['Completed 24h', dashboard?.completedLast24h],
          ['Average ms', dashboard?.avgProcessingTime],
        ].map(([label, value]) => (
          <Card key={label}>
            <div className="p-4">
              <p className="text-xs text-gray-500">{label}</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{value ?? '—'}</p>
            </div>
          </Card>
        ))}
      </div>
      <Card>
        <div className="border-b border-gray-200 p-4">
          <h2 className="font-semibold text-gray-900">Queues</h2>
        </div>
        <div className="divide-y divide-gray-100">
          {dashboard?.queueStats.map((queue) => (
            <div key={queue.queueName} className="grid grid-cols-7 gap-3 p-4 text-sm">
              <span className="font-medium text-gray-900">{queue.queueName}</span>
              <span>{queue.pending} pending</span>
              <span>{queue.running} running</span>
              <span>{queue.completed} completed</span>
              <span>{queue.failed} failed</span>
              <span>{queue.avgProcessingTime.toFixed(0)} ms</span>
              <span>{queue.throughput.toFixed(1)}/s</span>
            </div>
          ))}
          {!dashboard?.queueStats.length && (
            <p className="p-6 text-center text-sm text-gray-500">No queue metrics available.</p>
          )}
        </div>
      </Card>
      <Card>
        <div className="border-b border-gray-200 p-4">
          <h2 className="font-semibold text-gray-900">Jobs</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Queue</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Attempts</th>
                <th className="px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td className="px-4 py-3 font-medium text-gray-900">{job.name}</td>
                  <td className="px-4 py-3">{job.queueName}</td>
                  <td className="px-4 py-3">{job.jobType}</td>
                  <td className="px-4 py-3">
                    <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    {job.attempts}/{job.maxAttempts}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      {job.status === 'failed' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={mutatingId === job.id}
                          onClick={() => void retryJob(job)}
                        >
                          Retry
                        </Button>
                      )}
                      {['pending', 'scheduled', 'running', 'retrying'].includes(job.status) && (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={mutatingId === job.id}
                          onClick={() => void cancelJob(job)}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};

export { JobQueuePage };
export default JobQueuePage;
