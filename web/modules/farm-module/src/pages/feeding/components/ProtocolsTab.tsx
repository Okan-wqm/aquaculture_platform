/**
 * Protocols Tab Component
 *
 * Lists feeding programs (protocols) with status, tank count, and feed assignments.
 * Provides navigation to create/edit protocols.
 */
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, useToast } from '@aquaculture/shared-ui';
import {
  ACTIVATE_FEEDING_PROGRAM,
  PAUSE_FEEDING_PROGRAM,
  CANCEL_FEEDING_PROGRAM,
} from '../../../graphql/feedingProgram.mutations';

// Simple query matching backend resolver signature (returns FeedingProgram[], not paginated)
const PROTOCOLS_LIST_QUERY = `
  query FeedingPrograms($filter: FeedingProgramFilterInput) {
    feedingPrograms(filter: $filter) {
      id
      tenantId
      name
      code
      description
      status
      startDate
      endDate
      totalTanks
      totalFeedTransitions
      totalFeedConsumed
      feedAssignments
      fcrTable
      settings
      createdAt
      updatedAt
    }
  }
`;

// ============================================================================
// Types
// ============================================================================

interface FeedingProgram {
  id: string;
  name: string;
  code: string;
  description?: string;
  status: string;
  startDate?: string;
  endDate?: string;
  totalTanks: number;
  totalFeedTransitions: number;
  totalFeedConsumed: number;
  feedAssignments: any;
  createdAt: string;
  updatedAt: string;
}

// Backend returns array directly (no pagination wrapper)

// ============================================================================
// Status Config
// ============================================================================

const statusConfig: Record<string, { label: string; color: string }> = {
  DRAFT: { label: 'Draft', color: 'bg-gray-100 text-gray-800' },
  ACTIVE: { label: 'Active', color: 'bg-green-100 text-green-800' },
  PAUSED: { label: 'Paused', color: 'bg-yellow-100 text-yellow-800' },
  COMPLETED: { label: 'Completed', color: 'bg-blue-100 text-blue-800' },
  CANCELLED: { label: 'Cancelled', color: 'bg-red-100 text-red-800' },
};

// ============================================================================
// Component
// ============================================================================

interface ProtocolsTabProps {
  siteId?: string;
}

export const ProtocolsTab: React.FC<ProtocolsTabProps> = ({ siteId }) => {
  const navigate = useNavigate();
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Fetch feeding programs (backend returns array, not paginated)
  const { data, isLoading, error } = useQuery({
    queryKey: ['feeding-programs', siteId, statusFilter],
    queryFn: async () => {
      const filter: Record<string, any> = {};
      if (statusFilter !== 'all') {
        filter.status = statusFilter;
      }
      if (siteId) {
        filter.siteId = siteId;
      }
      const result = await graphqlClient.request<{ feedingPrograms: FeedingProgram[] }>(
        PROTOCOLS_LIST_QUERY,
        { filter }
      );
      return result.feedingPrograms;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });

  // Mutations
  const activateMutation = useMutation({
    mutationFn: async (id: string) => {
      return graphqlClient.request(ACTIVATE_FEEDING_PROGRAM, { id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feeding-programs'] });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: async (id: string) => {
      return graphqlClient.request(PAUSE_FEEDING_PROGRAM, { id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feeding-programs'] });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      return graphqlClient.request(CANCEL_FEEDING_PROGRAM, { id, reason });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feeding-programs'] });
    },
  });

  const handleActivate = async (id: string) => {
    if (confirm('Activate this feeding program?')) {
      try {
        await activateMutation.mutateAsync(id);
      } catch (err) {
        if (import.meta.env.DEV) console.error('Failed to activate program:', err);
        toast({ title: 'Error', description: 'Failed to activate program. Please try again.', variant: 'error' });
      }
    }
  };

  const handlePause = async (id: string) => {
    if (confirm('Pause this feeding program?')) {
      try {
        await pauseMutation.mutateAsync(id);
      } catch (err) {
        if (import.meta.env.DEV) console.error('Failed to pause program:', err);
        toast({ title: 'Error', description: 'Failed to pause program. Please try again.', variant: 'error' });
      }
    }
  };

  const handleCancel = async (id: string) => {
    const reason = prompt('Enter cancellation reason:');
    if (reason) {
      try {
        await cancelMutation.mutateAsync({ id, reason });
      } catch (err) {
        if (import.meta.env.DEV) console.error('Failed to cancel program:', err);
        toast({ title: 'Error', description: 'Failed to cancel program. Please try again.', variant: 'error' });
      }
    }
  };

  const getFeedAssignmentsSummary = (assignments: any): string => {
    if (!assignments || !Array.isArray(assignments)) return '-';
    return assignments
      .map((a: any) => `${a.minWeightG || 0}-${a.maxWeightG || 0}g`)
      .join(', ');
  };

  const programs = data ?? [];

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex gap-4">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
          >
            <option value="all">All Status</option>
            <option value="DRAFT">Draft</option>
            <option value="ACTIVE">Active</option>
            <option value="PAUSED">Paused</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
        <button
          onClick={() => navigate('/sites/feeding/protocols/new')}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors text-sm"
        >
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Create Protocol
        </button>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load protocols. Please try again.</p>
        </div>
      )}

      {/* Table */}
      {!isLoading && !error && programs.length > 0 && (
        <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Name
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Code
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Tanks
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Feed Assignments
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Start Date
                  </th>
                  <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {programs.map((program) => {
                  const config = statusConfig[program.status] || statusConfig.DRAFT;
                  return (
                    <tr key={program.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">{program.name}</div>
                        {program.description && (
                          <div className="text-xs text-gray-500 truncate max-w-xs">{program.description}</div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {program.code}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.color}`}>
                          {config.label}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {program.totalTanks || 0}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        <span className="truncate max-w-xs block">
                          {getFeedAssignmentsSummary(program.feedAssignments)}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {program.startDate
                          ? new Date(program.startDate).toLocaleDateString('tr-TR')
                          : '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                        <div className="flex items-center justify-end gap-2">
                          {(program.status === 'DRAFT' || program.status === 'PAUSED') && (
                            <button
                              onClick={() => navigate(`/sites/feeding/protocols/${program.id}/edit`)}
                              className="text-blue-600 hover:text-blue-800"
                              title="Edit"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                          )}
                          {(program.status === 'DRAFT' || program.status === 'PAUSED') && (
                            <button
                              onClick={() => handleActivate(program.id)}
                              className="text-green-600 hover:text-green-800"
                              title="Activate"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            </button>
                          )}
                          {program.status === 'ACTIVE' && (
                            <button
                              onClick={() => handlePause(program.id)}
                              className="text-yellow-600 hover:text-yellow-800"
                              title="Pause"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            </button>
                          )}
                          {program.status !== 'COMPLETED' && program.status !== 'CANCELLED' && (
                            <button
                              onClick={() => handleCancel(program.id)}
                              className="text-red-600 hover:text-red-800"
                              title="Cancel"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && programs.length === 0 && (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">No protocols found</h3>
          <p className="mt-1 text-sm text-gray-500">Get started by creating a new feeding protocol.</p>
          <div className="mt-6">
            <button
              onClick={() => navigate('/sites/feeding/protocols/new')}
              className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
            >
              <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              Create Protocol
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProtocolsTab;
