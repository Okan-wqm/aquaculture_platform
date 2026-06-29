/**
 * Automation Programs Page
 *
 * List and manage IEC 61131-3 automation programs.
 * Features:
 * - Program list with filtering
 * - Status-based grouping
 * - Clone, archive, deploy actions
 * - Approve/reject workflow for pending programs
 * - Pagination controls
 */

import React, { useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Workflow,
  Search,
  Plus,
  MoreVertical,
  Play,
  Copy,
  Archive,
  Edit,
  Trash2,
  CheckCircle,
  Clock,
  Loader2,
  AlertCircle,
  LayoutGrid,
  List,
  RefreshCw,
  ThumbsUp,
  ThumbsDown,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useAuth, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';
import { graphqlFetch } from '../../config/api';
import {
  ProgramStatus,
  ProgramType,
  getStatusColor,
  getStatusText,
  getProgramTypeText,
} from '../../utils/automation.utils';
import {
  AUTOMATION_PROGRAMS_QUERY,
  DELETE_PROGRAM_MUTATION,
  CLONE_PROGRAM_MUTATION,
  ARCHIVE_PROGRAM_MUTATION,
  APPROVE_PROGRAM_MUTATION,
  REJECT_PROGRAM_MUTATION,
} from '../../graphql/automation.queries';

// ============================================================================
// Types
// ============================================================================

interface AutomationProgram {
  id: string;
  programCode: string;
  programName: string;
  description?: string;
  version: string;
  programType: ProgramType;
  status: ProgramStatus;
  stepCount?: number;
  transitionCount?: number;
  variableCount?: number;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvedBy?: string;
}

interface ProgramStats {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
}

type ViewMode = 'grid' | 'list';

// ============================================================================
// Helper Functions
// ============================================================================

const getStatusIcon = (status: ProgramStatus) => {
  const icons: Record<ProgramStatus, React.ReactNode> = {
    [ProgramStatus.DRAFT]: <Edit className="h-3.5 w-3.5" />,
    [ProgramStatus.PENDING_REVIEW]: <Clock className="h-3.5 w-3.5" />,
    [ProgramStatus.APPROVED]: <CheckCircle className="h-3.5 w-3.5" />,
    [ProgramStatus.DEPLOYING]: <Clock className="h-3.5 w-3.5" />,
    [ProgramStatus.DEPLOYED]: <Play className="h-3.5 w-3.5" />,
    [ProgramStatus.ARCHIVED]: <Archive className="h-3.5 w-3.5" />,
  };
  return icons[status] || icons[ProgramStatus.DRAFT];
};

const formatDate = (dateStr?: string): string => {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};

// ============================================================================
// Components
// ============================================================================

const StatusBadge: React.FC<{ status: ProgramStatus }> = ({ status }) => (
  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${getStatusColor(status)}`}>
    {getStatusIcon(status)}
    {getStatusText(status)}
  </span>
);

const StatCard: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
  <div className={`px-4 py-3 rounded-lg ${color}`}>
    <div className="text-2xl font-bold">{value}</div>
    <div className="text-sm opacity-80">{label}</div>
  </div>
);

const ProgramCard: React.FC<{
  program: AutomationProgram;
  onClone: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onApprove: () => void;
  onReject: () => void;
}> = ({ program, onClone, onArchive, onDelete, onApprove, onReject }) => {
  const [showMenu, setShowMenu] = useState(false);
  const navigate = useNavigate();

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <Workflow className="h-5 w-5 text-indigo-600" />
          <span className="text-xs text-gray-500 font-mono">
            {program.programCode}
          </span>
        </div>
        <div className="relative">
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="p-1 rounded hover:bg-gray-100"
          >
            <MoreVertical className="h-4 w-4 text-gray-500" />
          </button>
          {showMenu && (
            <div className="absolute right-0 top-8 w-40 bg-white border border-gray-200 rounded-lg shadow-lg z-10">
              <button
                onClick={() => { navigate(`/sensor/automation/${program.id}`); setShowMenu(false); }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 flex items-center gap-2"
              >
                <Edit className="h-4 w-4" /> Edit
              </button>
              <button
                onClick={() => { onClone(); setShowMenu(false); }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 flex items-center gap-2"
              >
                <Copy className="h-4 w-4" /> Clone
              </button>
              <button
                onClick={() => { onArchive(); setShowMenu(false); }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 flex items-center gap-2"
              >
                <Archive className="h-4 w-4" /> Archive
              </button>
              <hr className="my-1 border-gray-200" />
              <button
                onClick={() => { onDelete(); setShowMenu(false); }}
                className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
              >
                <Trash2 className="h-4 w-4" /> Delete
              </button>
            </div>
          )}
        </div>
      </div>

      <Link to={`/sensor/automation/${program.id}`}>
        <h3 className="font-semibold text-gray-900 hover:text-indigo-600 mb-1">
          {program.programName}
        </h3>
      </Link>

      {program.description && (
        <p className="text-sm text-gray-500 line-clamp-2 mb-3">
          {program.description}
        </p>
      )}

      <div className="flex items-center gap-2 mb-3">
        <StatusBadge status={program.status} />
        <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
          {getProgramTypeText(program.programType)}
        </span>
        <span className="text-xs text-gray-500">
          v{program.version}
        </span>
      </div>

      {/* Approve/Reject actions for pending programs */}
      {program.status === ProgramStatus.PENDING_REVIEW && (
        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={onApprove}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-green-700 bg-green-100 hover:bg-green-200 rounded-lg transition-colors"
          >
            <ThumbsUp className="h-3.5 w-3.5" />
            Approve
          </button>
          <button
            onClick={onReject}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-100 hover:bg-red-200 rounded-lg transition-colors"
          >
            <ThumbsDown className="h-3.5 w-3.5" />
            Reject
          </button>
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-gray-500 pt-3 border-t border-gray-100">
        <div className="flex items-center gap-3">
          <span>{program.stepCount ?? 0} steps</span>
          <span>{program.variableCount ?? 0} variables</span>
        </div>
        <span>{formatDate(program.updatedAt)}</span>
      </div>
    </div>
  );
};

const ProgramRow: React.FC<{
  program: AutomationProgram;
  onClone: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onApprove: () => void;
  onReject: () => void;
}> = ({ program, onClone, onArchive, onDelete, onApprove, onReject }) => {
  const navigate = useNavigate();

  return (
    <tr className="hover:bg-gray-50">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Workflow className="h-4 w-4 text-indigo-600" />
          <Link
            to={`/sensor/automation/${program.id}`}
            className="font-medium text-gray-900 hover:text-indigo-600"
          >
            {program.programName}
          </Link>
        </div>
        <div className="text-xs text-gray-500 font-mono mt-0.5">{program.programCode}</div>
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={program.status} />
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        {getProgramTypeText(program.programType)}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        v{program.version}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        {program.stepCount ?? 0}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        {formatDate(program.updatedAt)}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1">
          {program.status === ProgramStatus.PENDING_REVIEW && (
            <>
              <button
                onClick={onApprove}
                className="p-1.5 rounded hover:bg-green-100"
                title="Approve"
              >
                <ThumbsUp className="h-4 w-4 text-green-600" />
              </button>
              <button
                onClick={onReject}
                className="p-1.5 rounded hover:bg-red-100"
                title="Reject"
              >
                <ThumbsDown className="h-4 w-4 text-red-500" />
              </button>
            </>
          )}
          <button
            onClick={() => navigate(`/sensor/automation/${program.id}`)}
            className="p-1.5 rounded hover:bg-gray-100"
            title="Edit"
          >
            <Edit className="h-4 w-4 text-gray-500" />
          </button>
          <button
            onClick={onClone}
            className="p-1.5 rounded hover:bg-gray-100"
            title="Clone"
          >
            <Copy className="h-4 w-4 text-gray-500" />
          </button>
          <button
            onClick={onArchive}
            className="p-1.5 rounded hover:bg-gray-100"
            title="Archive"
          >
            <Archive className="h-4 w-4 text-gray-500" />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded hover:bg-red-100"
            title="Delete"
          >
            <Trash2 className="h-4 w-4 text-red-500" />
          </button>
        </div>
      </td>
    </tr>
  );
};

// ============================================================================
// Main Component
// ============================================================================

const AutomationProgramsPage: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { token, tenantId } = useAuth();

  // State
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProgramStatus | ''>('');
  const [typeFilter, setTypeFilter] = useState<ProgramType | ''>('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [page, setPage] = useState(1);
  const limit = 20;

  // Build filter — only include when there are actual filter values.
  // Sending filter: {} (empty object) can cause edge-case validation issues
  // on the backend with class-validator + class-transformer.
  const hasFilter = !!(statusFilter || typeFilter);
  const filterInput = hasFilter
    ? {
        ...(statusFilter && { status: statusFilter }),
        ...(typeFilter && { programType: typeFilter }),
      }
    : undefined;

  // Query
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'automationPrograms', statusFilter, typeFilter, page),
    queryFn: () =>
      graphqlFetch<{ automationPrograms: AutomationProgram[]; automationProgramStats: ProgramStats }>(
        AUTOMATION_PROGRAMS_QUERY,
        {
          ...(filterInput && { filter: filterInput }),
          page,
          limit,
        }
      ),
    enabled: !!token,
  });

  // Mutations
  const deleteMutation = useMutation({
    mutationFn: (id: string) => graphqlFetch(DELETE_PROGRAM_MUTATION, { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationPrograms') }),
  });

  const cloneMutation = useMutation({
    mutationFn: ({ id, newCode }: { id: string; newCode: string }) =>
      graphqlFetch(CLONE_PROGRAM_MUTATION, { id, newCode }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationPrograms') }),
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => graphqlFetch(ARCHIVE_PROGRAM_MUTATION, { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationPrograms') }),
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => graphqlFetch(APPROVE_PROGRAM_MUTATION, { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationPrograms') }),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      graphqlFetch(REJECT_PROGRAM_MUTATION, { id, reason }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationPrograms') }),
  });

  // Filtered programs — guard against non-array responses
  const filteredPrograms = useMemo(() => {
    const programs = Array.isArray(data?.automationPrograms) ? data.automationPrograms : [];
    if (programs.length === 0) return [];
    if (!searchTerm) return programs;

    const term = searchTerm.toLowerCase();
    return programs.filter(
      (p) =>
        p.programName.toLowerCase().includes(term) ||
        p.programCode.toLowerCase().includes(term) ||
        p.description?.toLowerCase().includes(term)
    );
  }, [data?.automationPrograms, searchTerm]);

  const rawStats = data?.automationProgramStats;
  const stats = rawStats ? {
    total: rawStats.total,
    byStatus: Array.isArray(rawStats.byStatus)
      ? Object.fromEntries((rawStats.byStatus as Array<{ status: string; count: number }>).map(s => [s.status, s.count]))
      : rawStats.byStatus,
    byType: Array.isArray(rawStats.byType)
      ? Object.fromEntries((rawStats.byType as Array<{ type: string; count: number }>).map(t => [t.type, t.count]))
      : rawStats.byType,
  } as ProgramStats : undefined;

  // Pagination
  const totalPrograms = stats?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalPrograms / limit));
  const isLastPage = page >= totalPages || (data?.automationPrograms?.length ?? 0) < limit;

  // Handlers
  const handleClone = (program: AutomationProgram) => {
    const newCode = `${program.programCode}_COPY_${Date.now()}`;
    cloneMutation.mutate({ id: program.id, newCode });
  };

  const handleDelete = (program: AutomationProgram) => {
    if (window.confirm(`Are you sure you want to delete "${program.programName}"?`)) {
      deleteMutation.mutate(program.id);
    }
  };

  const handleArchive = (program: AutomationProgram) => {
    archiveMutation.mutate(program.id);
  };

  const handleApprove = (program: AutomationProgram) => {
    if (window.confirm(`Are you sure you want to approve "${program.programName}"?`)) {
      approveMutation.mutate(program.id);
    }
  };

  const handleReject = (program: AutomationProgram) => {
    const reason = window.prompt(`Reason for rejecting "${program.programName}":`);
    if (reason !== null && reason.trim()) {
      rejectMutation.mutate({ id: program.id, reason: reason.trim() });
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Workflow className="h-6 w-6 text-indigo-600" />
            Automation Programs
          </h1>
          <p className="text-gray-500 mt-1">
            Manage IEC 61131-3 compliant automation programs
          </p>
        </div>
        <button
          onClick={() => navigate('/sensor/automation/new')}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4" />
          New Program
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          <StatCard label="Total" value={stats.total} color="bg-gray-100 text-gray-900" />
          <StatCard label="Draft" value={stats.byStatus?.draft ?? 0} color="bg-gray-100 text-gray-700" />
          <StatCard label="Approved" value={stats.byStatus?.approved ?? 0} color="bg-blue-100 text-blue-700" />
          <StatCard label="Deployed" value={stats.byStatus?.deployed ?? 0} color="bg-green-100 text-green-700" />
          <StatCard label="Pending Review" value={stats.byStatus?.pending_review ?? 0} color="bg-yellow-100 text-yellow-700" />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4 mb-6">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search programs..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg bg-white text-gray-900"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value as ProgramStatus | ''); setPage(1); }}
          className="px-3 py-2 border border-gray-200 rounded-lg bg-white text-gray-900"
        >
          <option value="">All Statuses</option>
          {Object.values(ProgramStatus).map((status) => (
            <option key={status} value={status}>
              {getStatusText(status)}
            </option>
          ))}
        </select>

        <select
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value as ProgramType | ''); setPage(1); }}
          className="px-3 py-2 border border-gray-200 rounded-lg bg-white text-gray-900"
        >
          <option value="">All Types</option>
          {Object.values(ProgramType).map((type) => (
            <option key={type} value={type}>
              {getProgramTypeText(type)}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => setViewMode('grid')}
            className={`p-2 rounded ${viewMode === 'grid' ? 'bg-white shadow' : ''}`}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`p-2 rounded ${viewMode === 'list' ? 'bg-white shadow' : ''}`}
          >
            <List className="h-4 w-4" />
          </button>
        </div>

        <button
          onClick={() => refetch()}
          className="p-2 rounded-lg border border-gray-200 hover:bg-gray-100"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
        </div>
      ) : isError ? (
        <div className="text-center py-12 bg-red-50 rounded-lg">
          <AlertCircle className="h-12 w-12 mx-auto text-red-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            Failed to load programs
          </h3>
          <p className="text-red-600 text-sm mb-4">
            {error instanceof Error ? error.message : 'Unknown error'}
          </p>
          <button
            onClick={() => refetch()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        </div>
      ) : filteredPrograms.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg">
          <Workflow className="h-12 w-12 mx-auto text-gray-500 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            No programs found
          </h3>
          <p className="text-gray-500 mb-4">
            Create a new automation program
          </p>
          <button
            onClick={() => navigate('/sensor/automation/new')}
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" />
            New Program
          </button>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredPrograms.map((program) => (
            <ProgramCard
              key={program.id}
              program={program}
              onClone={() => handleClone(program)}
              onArchive={() => handleArchive(program)}
              onDelete={() => handleDelete(program)}
              onApprove={() => handleApprove(program)}
              onReject={() => handleReject(program)}
            />
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Program</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Version</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Steps</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Updated</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filteredPrograms.map((program) => (
                <ProgramRow
                  key={program.id}
                  program={program}
                  onClone={() => handleClone(program)}
                  onArchive={() => handleArchive(program)}
                  onDelete={() => handleDelete(program)}
                  onApprove={() => handleApprove(program)}
                  onReject={() => handleReject(program)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination Controls */}
      {!isLoading && filteredPrograms.length > 0 && (
        <div className="flex items-center justify-between mt-6 px-1">
          <span className="text-sm text-gray-500">
            {totalPrograms > 0
              ? `${(page - 1) * limit + 1} - ${Math.min(page * limit, totalPrograms)} / ${totalPrograms} programs`
              : `${filteredPrograms.length} programs`}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </button>
            <span className="text-sm text-gray-700 px-2">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={isLastPage}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AutomationProgramsPage;
