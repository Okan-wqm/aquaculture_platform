/**
 * Feeding Programs Page
 * Yemleme programlari listesi - CRUD islemleri ve filtreleme.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card,
  Button,
  Select,
  Badge,
  Spinner,
  Alert,
  ConfirmModal,
  useAuth,
  graphqlClient,
  formatDate,
} from '@aquaculture/shared-ui';
import type { DataTableColumn } from '@aquaculture/shared-ui';
import { DataTable } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

export type FeedingProgramStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

/** Valid status values for runtime validation */
const VALID_STATUSES: readonly FeedingProgramStatus[] = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'] as const;

export interface FeedAssignment {
  feedId: string;
  feedCode: string;
  feedName: string;
  minWeightG: number;
  maxWeightG: number;
  priority: number;
  notes?: string;
}

export interface ProgramSettings {
  autoTransition: boolean;
  transitionBuffer: number;
  notifyOnTransition: boolean;
  fcrSource: 'PROGRAM' | 'FEED';
  defaultMealsPerDay?: number;
  minFeedingRatePercent?: number;
  maxFeedingRatePercent?: number;
}

export interface FeedingProgram {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  description?: string;
  feedAssignments: FeedAssignment[];
  status: FeedingProgramStatus;
  startDate: string;
  endDate?: string;
  settings: ProgramSettings;
  totalTanks: number;
  totalFeedTransitions: number;
  totalFeedConsumed?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeedingProgramsFilter {
  status?: FeedingProgramStatus[];
  search?: string;
}

export interface FeedingProgramsResponse {
  items: FeedingProgram[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
}

// ============================================================================
// GraphQL Queries & Mutations
// ============================================================================

// NOTE: tenantId is automatically extracted from X-Tenant-Id header by @Tenant() decorator
// graphqlClient automatically sets this header from stored tenant context
const FEEDING_PROGRAMS_QUERY = `
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
      createdBy
      createdAt
      updatedAt
      settings
      feedAssignments
    }
  }
`;

const ACTIVATE_PROGRAM_MUTATION = `
  mutation ActivateFeedingProgram($id: ID!) {
    activateFeedingProgram(id: $id) {
      id
      status
    }
  }
`;

const PAUSE_PROGRAM_MUTATION = `
  mutation PauseFeedingProgram($id: ID!) {
    pauseFeedingProgram(id: $id) {
      id
      status
    }
  }
`;

const DELETE_PROGRAM_MUTATION = `
  mutation DeleteFeedingProgram($id: ID!) {
    deleteFeedingProgram(id: $id) {
      id
    }
  }
`;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Runtime validation for status filter
 */
function isValidStatus(value: string): value is FeedingProgramStatus {
  return VALID_STATUSES.includes(value as FeedingProgramStatus);
}

// ============================================================================
// Hooks
// ============================================================================

function useFeedingPrograms(
  tenantId: string | null,
  filter: FeedingProgramsFilter,
  _page: number = 1,
  _limit: number = 20
) {
  const { token } = useAuth();

  return useQuery({
    // Include tenantId in cache key to prevent cross-tenant cache issues
    queryKey: ['feeding-programs', tenantId, filter],
    queryFn: async () => {
      if (!tenantId) throw new Error('Tenant context required');
      // tenantId is automatically sent via X-Tenant-Id header by graphqlClient
      const data = await graphqlClient.request<{ feedingPrograms: FeedingProgram[] }>(
        FEEDING_PROGRAMS_QUERY,
        { filter }
      );
      // Wrap response for backward compatibility
      const items = data.feedingPrograms || [];
      return {
        items,
        total: items.length,
        page: 1,
        limit: items.length,
        totalPages: 1,
        hasNextPage: false,
      } as FeedingProgramsResponse;
    },
    enabled: !!token && !!tenantId,
    staleTime: 30000,
  });
}

function useActivateFeedingProgram(tenantId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!tenantId) throw new Error('Tenant context required');
      // tenantId is automatically sent via X-Tenant-Id header by graphqlClient
      const data = await graphqlClient.request<{ activateFeedingProgram: { id: string; status: string } }>(
        ACTIVATE_PROGRAM_MUTATION,
        { id }
      );
      return data.activateFeedingProgram;
    },
    onSuccess: () => {
      // Scope invalidation to specific tenant
      queryClient.invalidateQueries({ queryKey: ['feeding-programs', tenantId] });
    },
  });
}

function usePauseFeedingProgram(tenantId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!tenantId) throw new Error('Tenant context required');
      // tenantId is automatically sent via X-Tenant-Id header by graphqlClient
      const data = await graphqlClient.request<{ pauseFeedingProgram: { id: string; status: string } }>(
        PAUSE_PROGRAM_MUTATION,
        { id }
      );
      return data.pauseFeedingProgram;
    },
    onSuccess: () => {
      // Scope invalidation to specific tenant
      queryClient.invalidateQueries({ queryKey: ['feeding-programs', tenantId] });
    },
  });
}

function useDeleteFeedingProgram(tenantId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!tenantId) throw new Error('Tenant context required');
      // tenantId is automatically sent via X-Tenant-Id header by graphqlClient
      const data = await graphqlClient.request<{ deleteFeedingProgram: { id: string } }>(
        DELETE_PROGRAM_MUTATION,
        { id }
      );
      return data.deleteFeedingProgram;
    },
    onSuccess: () => {
      // Scope invalidation to specific tenant
      queryClient.invalidateQueries({ queryKey: ['feeding-programs', tenantId] });
    },
  });
}

// ============================================================================
// Status Config
// ============================================================================

const statusConfig: Record<FeedingProgramStatus, { label: string; variant: 'default' | 'success' | 'warning' | 'error' | 'info' }> = {
  DRAFT: { label: 'Taslak', variant: 'default' },
  ACTIVE: { label: 'Aktif', variant: 'success' },
  PAUSED: { label: 'Duraklatildi', variant: 'warning' },
  COMPLETED: { label: 'Tamamlandi', variant: 'info' },
  CANCELLED: { label: 'Iptal Edildi', variant: 'error' },
};

const statusLabels: Record<FeedingProgramStatus, string> = {
  DRAFT: 'Taslak',
  ACTIVE: 'Aktif',
  PAUSED: 'Duraklatildi',
  COMPLETED: 'Tamamlandi',
  CANCELLED: 'Iptal Edildi',
};

// ============================================================================
// ActionCell Component
// Issue #8: Column useMemo has too many dependencies causing re-renders
// Extract ActionCell component to reduce re-renders
// ============================================================================

interface ActionCellProps {
  program: FeedingProgram;
  canManagePrograms: boolean;
  onActivate: (program: FeedingProgram) => void;
  onPause: (program: FeedingProgram) => void;
  onEdit: (program: FeedingProgram) => void;
  onDelete: (program: FeedingProgram) => void;
  isActivating: boolean;
  isPausing: boolean;
  activatingId: string | null;
  pausingId: string | null;
}

const ActionCell: React.FC<ActionCellProps> = ({
  program,
  canManagePrograms,
  onActivate,
  onPause,
  onEdit,
  onDelete,
  isActivating,
  isPausing,
  activatingId,
  pausingId,
}) => {
  // Issue #17: No loading state for individual rows during mutation
  const isThisRowActivating = isActivating && activatingId === program.id;
  const isThisRowPausing = isPausing && pausingId === program.id;

  // Issue #11: Delete button available for ACTIVE programs - Disable or warn
  const canDelete = program.status !== 'ACTIVE' && program.status !== 'COMPLETED';

  return (
    <div className="flex items-center justify-end space-x-2">
      {/* Activate button - only for DRAFT or PAUSED */}
      {/* Issue #5: No authorization check for action buttons */}
      {canManagePrograms && (program.status === 'DRAFT' || program.status === 'PAUSED') && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onActivate(program)}
          disabled={isActivating}
          title="Aktif Et"
          // Issue #10: Missing aria-labels for accessibility
          aria-label={`${program.name} programini aktif et`}
        >
          {isThisRowActivating ? (
            <Spinner size="sm" />
          ) : (
            <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
        </Button>
      )}

      {/* Pause button - only for ACTIVE */}
      {canManagePrograms && program.status === 'ACTIVE' && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onPause(program)}
          disabled={isPausing}
          title="Duraklat"
          // Issue #10: Missing aria-labels for accessibility
          aria-label={`${program.name} programini duraklat`}
        >
          {isThisRowPausing ? (
            <Spinner size="sm" />
          ) : (
            <svg className="w-4 h-4 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
        </Button>
      )}

      {/* Edit button */}
      {canManagePrograms && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onEdit(program)}
          title="Duzenle"
          // Issue #10: Missing aria-labels for accessibility
          aria-label={`${program.name} programini duzenle`}
        >
          <svg className="w-4 h-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </Button>
      )}

      {/* Delete button */}
      {/* Issue #11: Delete button available for ACTIVE programs - Disable with tooltip */}
      {canManagePrograms && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => canDelete && onDelete(program)}
          disabled={!canDelete}
          title={canDelete ? 'Sil' : 'Aktif veya tamamlanmis programlar silinemez'}
          // Issue #10: Missing aria-labels for accessibility
          aria-label={canDelete ? `${program.name} programini sil` : `${program.name} programi silinemez - aktif veya tamamlanmis`}
        >
          <svg
            className={`w-4 h-4 ${canDelete ? 'text-red-500' : 'text-gray-300'}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </Button>
      )}
    </div>
  );
};

// ============================================================================
// Toast/Notification State Interface
// Issue #3: No user-facing error notifications
// ============================================================================

interface NotificationState {
  show: boolean;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
}

// ============================================================================
// Component
// ============================================================================

export const FeedingProgramsPage: React.FC = () => {
  const navigate = useNavigate();
  // Issue #5: No authorization check for action buttons
  const { tenantId, hasPermission, hasAnyRole } = useAuth();

  // Authorization check
  const canManagePrograms = hasPermission('feeding:programs:manage') ||
    hasAnyRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'MODULE_MANAGER']);

  // Filter state
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [page, setPage] = useState(1);
  const [limit] = useState(20);

  // Modal state
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [selectedProgram, setSelectedProgram] = useState<FeedingProgram | null>(null);

  // Issue #3: No user-facing error notifications - Add notification state
  const [notification, setNotification] = useState<NotificationState>({
    show: false,
    type: 'info',
    message: '',
  });

  // Issue #17: Track which row is being mutated
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [pausingId, setPausingId] = useState<string | null>(null);

  // Issue #13: Unnecessary useMemo for simple filter object - Simplified
  // Build filter directly without useMemo since it's a simple object
  const filter: FeedingProgramsFilter = statusFilter && isValidStatus(statusFilter)
    ? { status: [statusFilter] }
    : {};

  // API hooks - Issue #1: Pass tenantId to hooks for proper schema name generation
  const { data, isLoading, error, refetch } = useFeedingPrograms(tenantId, filter, page, limit);

  // Issue #2: Fix stale closure by destructuring mutateAsync
  const { mutateAsync: activateAsync, isPending: isActivating } = useActivateFeedingProgram(tenantId);
  const { mutateAsync: pauseAsync, isPending: isPausing } = usePauseFeedingProgram(tenantId);
  const { mutateAsync: deleteAsync, isPending: isDeleting } = useDeleteFeedingProgram(tenantId);

  // Helper to show notification
  const showNotification = useCallback((type: NotificationState['type'], message: string) => {
    setNotification({ show: true, type, message });
    // Auto-hide after 5 seconds
    setTimeout(() => {
      setNotification(prev => ({ ...prev, show: false }));
    }, 5000);
  }, []);

  // Issue #2: Fix stale closure in useCallback dependencies - destructure mutateAsync
  const handleActivate = useCallback(async (program: FeedingProgram) => {
    try {
      setActivatingId(program.id);
      await activateAsync(program.id);
      // Issue #3: No user-facing error notifications - Add success toast
      showNotification('success', `"${program.name}" programi basariyla aktif edildi`);
    } catch (err) {
      console.error('Program aktif edilirken hata olustu:', err);
      // Issue #3: No user-facing error notifications - Add error toast
      showNotification('error', err instanceof Error ? err.message : 'Program aktif edilemedi');
    } finally {
      setActivatingId(null);
    }
  }, [activateAsync, showNotification]);

  const handlePause = useCallback(async (program: FeedingProgram) => {
    try {
      setPausingId(program.id);
      await pauseAsync(program.id);
      // Issue #3: No user-facing error notifications - Add success toast
      showNotification('success', `"${program.name}" programi basariyla duraklatildi`);
    } catch (err) {
      console.error('Program duraklatilirken hata olustu:', err);
      // Issue #3: No user-facing error notifications - Add error toast
      showNotification('error', err instanceof Error ? err.message : 'Program duraklatilamadi');
    } finally {
      setPausingId(null);
    }
  }, [pauseAsync, showNotification]);

  const handleDeleteClick = useCallback((program: FeedingProgram) => {
    setSelectedProgram(program);
    setDeleteModalOpen(true);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!selectedProgram) return;
    try {
      await deleteAsync(selectedProgram.id);
      // Issue #3: No user-facing error notifications - Add success toast
      showNotification('success', `"${selectedProgram.name}" programi basariyla silindi`);
      setDeleteModalOpen(false);
      setSelectedProgram(null);
    } catch (err) {
      console.error('Program silinirken hata olustu:', err);
      // Issue #3: No user-facing error notifications - Add error toast
      showNotification('error', err instanceof Error ? err.message : 'Program silinemedi');
    }
  }, [selectedProgram, deleteAsync, showNotification]);

  const handleEdit = useCallback((program: FeedingProgram) => {
    navigate(`/feeding/programs/${program.id}/edit`);
  }, [navigate]);

  // Issue #12: Unnecessary useCallback for handlePageChange - Simplified
  // Simple state setter doesn't need useCallback
  const handlePageChange = (newPage: number) => {
    setPage(newPage);
  };

  // Table columns
  // Issue #8: Extract ActionCell to reduce dependencies
  const columns: DataTableColumn<FeedingProgram>[] = useMemo(() => [
    {
      key: 'name',
      // Issue #15: Inconsistent language - Standardize to Turkish
      header: 'Ad',
      sortable: true,
      render: (_value, row) => (
        <Link
          to={`/feeding/programs/${row.id}`}
          className="text-blue-600 hover:text-blue-800 font-medium"
        >
          {row.name}
        </Link>
      ),
    },
    {
      key: 'code',
      // Issue #15: Inconsistent language - Standardize to Turkish
      header: 'Kod',
      sortable: true,
      render: (_value, row) => (
        <span className="font-mono text-sm text-gray-600">{row.code}</span>
      ),
    },
    {
      key: 'status',
      // Issue #15: Inconsistent language - Standardize to Turkish
      header: 'Durum',
      sortable: true,
      // Issue #14: Column filterType/filterOptions not used - Removed
      render: (_value, row) => {
        const config = statusConfig[row.status];
        return <Badge variant={config.variant}>{config.label}</Badge>;
      },
    },
    {
      key: 'totalTanks',
      // Issue #15: Inconsistent language - Standardize to Turkish
      header: 'Tank Sayisi',
      sortable: true,
      align: 'center',
      render: (_value, row) => (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
          {row.totalTanks}
        </span>
      ),
    },
    {
      key: 'startDate',
      // Issue #15: Inconsistent language - Standardize to Turkish
      header: 'Baslangic Tarihi',
      sortable: true,
      render: (_value, row) => (
        <span className="text-sm text-gray-600">
          {formatDate(row.startDate, 'short')}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (_value, row) => (
        <ActionCell
          program={row}
          canManagePrograms={canManagePrograms}
          onActivate={handleActivate}
          onPause={handlePause}
          onEdit={handleEdit}
          onDelete={handleDeleteClick}
          isActivating={isActivating}
          isPausing={isPausing}
          activatingId={activatingId}
          pausingId={pausingId}
        />
      ),
    },
  ], [canManagePrograms, handleActivate, handlePause, handleEdit, handleDeleteClick, isActivating, isPausing, activatingId, pausingId]);

  // Error state
  if (error) {
    return (
      <div className="p-6">
        <Alert type="error">
          Yemleme programlari yuklenirken bir hata olustu.
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Issue #3: Notification Toast */}
      {notification.show && (
        <div className="fixed top-4 right-4 z-50 animate-in fade-in slide-in-from-top-2">
          <Alert
            type={notification.type}
            dismissible
            onDismiss={() => setNotification(prev => ({ ...prev, show: false }))}
          >
            {notification.message}
          </Alert>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Yemleme Programlari</h1>
          <p className="text-sm text-gray-500 mt-1">
            Yemleme programlarini goruntuleyın ve yonetin
          </p>
        </div>
        {/* Issue #5: Authorization check for create button */}
        {canManagePrograms && (
          <Link to="/feeding/programs/new">
            <Button aria-label="Yeni yemleme programi olustur">
              <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              {/* Issue #15: Inconsistent language - Standardize to Turkish */}
              Yeni Program
            </Button>
          </Link>
        )}
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            options={[
              { value: '', label: 'Tum Durumlar' },
              ...Object.entries(statusLabels).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
            aria-label="Durum filtresi"
          />
        </div>
      </Card>

      {/* Table */}
      <Card>
        {isLoading ? (
          <div className="flex justify-center items-center py-12">
            <Spinner size="lg" />
          </div>
        ) : (
          <DataTable
            data={data?.items ?? []}
            columns={columns}
            keyExtractor={(row) => row.id}
            loading={isLoading}
            emptyMessage="Henüz yemleme programı bulunmuyor. Yemleme programı oluşturarak başlayın."
            striped
            hoverable
            pagination={data ? {
              page: data.page,
              limit: data.limit,
              total: data.total,
              totalPages: data.totalPages,
            } : undefined}
            onPageChange={handlePageChange}
            onRefresh={refetch}
          />
          // Issue #9: Duplicate pagination UI - Removed custom pagination, using DataTable's built-in
        )}
      </Card>

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        open={deleteModalOpen}
        onClose={() => {
          setDeleteModalOpen(false);
          setSelectedProgram(null);
        }}
        onConfirm={handleDeleteConfirm}
        title="Programi Sil"
        message={`"${selectedProgram?.name}" yemleme programini silmek istediginizden emin misiniz? Bu islem geri alinamaz.`}
        confirmText="Sil"
        confirmVariant="danger"
      />
    </div>
  );
};

export default FeedingProgramsPage;
