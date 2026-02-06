/**
 * Automation Programs Page
 *
 * List and manage IEC 61131-3 automation programs.
 * Features:
 * - Program list with filtering
 * - Status-based grouping
 * - Clone, archive, deploy actions
 */

import React, { useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Workflow,
  Search,
  Filter,
  Plus,
  MoreVertical,
  Play,
  Pause,
  Copy,
  Archive,
  Edit,
  Trash2,
  CheckCircle,
  Clock,
  AlertCircle,
  XCircle,
  Loader2,
  LayoutGrid,
  List,
  RefreshCw,
  ChevronDown,
  Upload,
  Download,
} from 'lucide-react';
import { useAuth } from '@aquaculture/shared-ui';

// ============================================================================
// GraphQL Fetch Helper
// ============================================================================

async function graphqlFetch<T>(
  query: string,
  variables: Record<string, unknown>,
  token?: string
): Promise<T> {
  const response = await fetch('/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL Error');
  }

  return result.data;
}

// ============================================================================
// Types
// ============================================================================

enum ProgramStatus {
  DRAFT = 'DRAFT',
  IN_REVIEW = 'IN_REVIEW',
  APPROVED = 'APPROVED',
  DEPLOYED = 'DEPLOYED',
  ARCHIVED = 'ARCHIVED',
  REJECTED = 'REJECTED',
}

enum ProgramType {
  SEQUENTIAL_FUNCTION_CHART = 'SEQUENTIAL_FUNCTION_CHART',
  LADDER_DIAGRAM = 'LADDER_DIAGRAM',
  FUNCTION_BLOCK = 'FUNCTION_BLOCK',
  STRUCTURED_TEXT = 'STRUCTURED_TEXT',
  INSTRUCTION_LIST = 'INSTRUCTION_LIST',
}

interface AutomationProgram {
  id: string;
  programCode: string;
  name: string;
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
// GraphQL Queries
// ============================================================================

const PROGRAMS_QUERY = `
  query AutomationPrograms($filter: ProgramFilterInput, $page: Int, $limit: Int) {
    automationPrograms(filter: $filter, page: $page, limit: $limit) {
      id
      programCode
      name
      description
      version
      programType
      status
      stepCount
      transitionCount
      variableCount
      createdAt
      updatedAt
      approvedAt
      approvedBy
    }
    automationProgramStats {
      total
      byStatus {
        status
        count
      }
      byType {
        type
        count
      }
    }
  }
`;

const DELETE_PROGRAM = `
  mutation DeleteAutomationProgram($id: ID!) {
    deleteAutomationProgram(id: $id)
  }
`;

const CLONE_PROGRAM = `
  mutation CloneAutomationProgram($id: ID!, $newCode: String!) {
    cloneAutomationProgram(id: $id, newCode: $newCode) {
      id
      programCode
    }
  }
`;

const ARCHIVE_PROGRAM = `
  mutation ArchiveProgram($id: ID!) {
    archiveProgram(id: $id) {
      id
      status
    }
  }
`;

// ============================================================================
// Helper Functions
// ============================================================================

const getStatusColor = (status: ProgramStatus): string => {
  const colors: Record<ProgramStatus, string> = {
    [ProgramStatus.DRAFT]: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
    [ProgramStatus.IN_REVIEW]: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
    [ProgramStatus.APPROVED]: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
    [ProgramStatus.DEPLOYED]: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
    [ProgramStatus.ARCHIVED]: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
    [ProgramStatus.REJECTED]: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  };
  return colors[status] || colors[ProgramStatus.DRAFT];
};

const getStatusIcon = (status: ProgramStatus) => {
  const icons: Record<ProgramStatus, React.ReactNode> = {
    [ProgramStatus.DRAFT]: <Edit className="h-3.5 w-3.5" />,
    [ProgramStatus.IN_REVIEW]: <Clock className="h-3.5 w-3.5" />,
    [ProgramStatus.APPROVED]: <CheckCircle className="h-3.5 w-3.5" />,
    [ProgramStatus.DEPLOYED]: <Play className="h-3.5 w-3.5" />,
    [ProgramStatus.ARCHIVED]: <Archive className="h-3.5 w-3.5" />,
    [ProgramStatus.REJECTED]: <XCircle className="h-3.5 w-3.5" />,
  };
  return icons[status] || icons[ProgramStatus.DRAFT];
};

const getStatusText = (status: ProgramStatus): string => {
  const texts: Record<ProgramStatus, string> = {
    [ProgramStatus.DRAFT]: 'Taslak',
    [ProgramStatus.IN_REVIEW]: 'Inceleniyor',
    [ProgramStatus.APPROVED]: 'Onaylandi',
    [ProgramStatus.DEPLOYED]: 'Devrede',
    [ProgramStatus.ARCHIVED]: 'Arsivlendi',
    [ProgramStatus.REJECTED]: 'Reddedildi',
  };
  return texts[status] || status;
};

const getProgramTypeText = (type: ProgramType): string => {
  const texts: Record<ProgramType, string> = {
    [ProgramType.SEQUENTIAL_FUNCTION_CHART]: 'SFC',
    [ProgramType.LADDER_DIAGRAM]: 'Ladder',
    [ProgramType.FUNCTION_BLOCK]: 'FBD',
    [ProgramType.STRUCTURED_TEXT]: 'ST',
    [ProgramType.INSTRUCTION_LIST]: 'IL',
  };
  return texts[type] || type;
};

const formatDate = (dateStr?: string): string => {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('tr-TR', {
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
}> = ({ program, onClone, onArchive, onDelete }) => {
  const [showMenu, setShowMenu] = useState(false);
  const navigate = useNavigate();

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <Workflow className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
          <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
            {program.programCode}
          </span>
        </div>
        <div className="relative">
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <MoreVertical className="h-4 w-4 text-gray-500" />
          </button>
          {showMenu && (
            <div className="absolute right-0 top-8 w-40 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10">
              <button
                onClick={() => { navigate(`/sensor/automation/${program.id}`); setShowMenu(false); }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
              >
                <Edit className="h-4 w-4" /> Duzenle
              </button>
              <button
                onClick={() => { onClone(); setShowMenu(false); }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
              >
                <Copy className="h-4 w-4" /> Kopyala
              </button>
              <button
                onClick={() => { onArchive(); setShowMenu(false); }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
              >
                <Archive className="h-4 w-4" /> Arsivle
              </button>
              <hr className="my-1 border-gray-200 dark:border-gray-700" />
              <button
                onClick={() => { onDelete(); setShowMenu(false); }}
                className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2"
              >
                <Trash2 className="h-4 w-4" /> Sil
              </button>
            </div>
          )}
        </div>
      </div>

      <Link to={`/sensor/automation/${program.id}`}>
        <h3 className="font-semibold text-gray-900 dark:text-white hover:text-indigo-600 dark:hover:text-indigo-400 mb-1">
          {program.name}
        </h3>
      </Link>

      {program.description && (
        <p className="text-sm text-gray-500 dark:text-gray-400 line-clamp-2 mb-3">
          {program.description}
        </p>
      )}

      <div className="flex items-center gap-2 mb-3">
        <StatusBadge status={program.status} />
        <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">
          {getProgramTypeText(program.programType)}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          v{program.version}
        </span>
      </div>

      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 pt-3 border-t border-gray-100 dark:border-gray-700">
        <div className="flex items-center gap-3">
          <span>{program.stepCount ?? 0} adim</span>
          <span>{program.variableCount ?? 0} degisken</span>
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
}> = ({ program, onClone, onArchive, onDelete }) => {
  const navigate = useNavigate();

  return (
    <tr className="hover:bg-gray-50 dark:hover:bg-gray-800">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Workflow className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          <Link
            to={`/sensor/automation/${program.id}`}
            className="font-medium text-gray-900 dark:text-white hover:text-indigo-600"
          >
            {program.name}
          </Link>
        </div>
        <span className="text-xs text-gray-500 font-mono">{program.programCode}</span>
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={program.status} />
      </td>
      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
        {getProgramTypeText(program.programType)}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
        v{program.version}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
        {program.stepCount ?? 0}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
        {formatDate(program.updatedAt)}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1">
          <button
            onClick={() => navigate(`/sensor/automation/${program.id}`)}
            className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            title="Duzenle"
          >
            <Edit className="h-4 w-4 text-gray-500" />
          </button>
          <button
            onClick={onClone}
            className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            title="Kopyala"
          >
            <Copy className="h-4 w-4 text-gray-500" />
          </button>
          <button
            onClick={onArchive}
            className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            title="Arsivle"
          >
            <Archive className="h-4 w-4 text-gray-500" />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/20"
            title="Sil"
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
  const { token } = useAuth();

  // State
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProgramStatus | ''>('');
  const [typeFilter, setTypeFilter] = useState<ProgramType | ''>('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [page, setPage] = useState(1);
  const limit = 20;

  // Query
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['automationPrograms', statusFilter, typeFilter, page],
    queryFn: () =>
      graphqlFetch<{ automationPrograms: AutomationProgram[]; automationProgramStats: ProgramStats }>(
        PROGRAMS_QUERY,
        {
          filter: {
            ...(statusFilter && { status: statusFilter }),
            ...(typeFilter && { programType: typeFilter }),
          },
          page,
          limit,
        },
        token
      ),
    enabled: !!token,
  });

  // Mutations
  const deleteMutation = useMutation({
    mutationFn: (id: string) => graphqlFetch(DELETE_PROGRAM, { id }, token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['automationPrograms'] }),
  });

  const cloneMutation = useMutation({
    mutationFn: ({ id, newCode }: { id: string; newCode: string }) =>
      graphqlFetch(CLONE_PROGRAM, { id, newCode }, token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['automationPrograms'] }),
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => graphqlFetch(ARCHIVE_PROGRAM, { id }, token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['automationPrograms'] }),
  });

  // Filtered programs
  const filteredPrograms = useMemo(() => {
    if (!data?.automationPrograms) return [];
    if (!searchTerm) return data.automationPrograms;

    const term = searchTerm.toLowerCase();
    return data.automationPrograms.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
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

  // Handlers
  const handleClone = (program: AutomationProgram) => {
    const newCode = `${program.programCode}_COPY_${Date.now()}`;
    cloneMutation.mutate({ id: program.id, newCode });
  };

  const handleDelete = (program: AutomationProgram) => {
    if (window.confirm(`"${program.name}" programini silmek istediginize emin misiniz?`)) {
      deleteMutation.mutate(program.id);
    }
  };

  const handleArchive = (program: AutomationProgram) => {
    archiveMutation.mutate(program.id);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Workflow className="h-6 w-6 text-indigo-600" />
            Otomasyon Programlari
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">
            IEC 61131-3 uyumlu otomasyon programlarini yonetin
          </p>
        </div>
        <button
          onClick={() => navigate('/sensor/automation/new')}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4" />
          Yeni Program
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          <StatCard label="Toplam" value={stats.total} color="bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white" />
          <StatCard label="Taslak" value={stats.byStatus?.DRAFT ?? 0} color="bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300" />
          <StatCard label="Onaylandi" value={stats.byStatus?.APPROVED ?? 0} color="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300" />
          <StatCard label="Devrede" value={stats.byStatus?.DEPLOYED ?? 0} color="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300" />
          <StatCard label="Inceleniyor" value={stats.byStatus?.IN_REVIEW ?? 0} color="bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300" />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4 mb-6">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Program ara..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ProgramStatus | '')}
          className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
        >
          <option value="">Tum Durumlar</option>
          {Object.values(ProgramStatus).map((status) => (
            <option key={status} value={status}>
              {getStatusText(status)}
            </option>
          ))}
        </select>

        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as ProgramType | '')}
          className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
        >
          <option value="">Tum Tipler</option>
          {Object.values(ProgramType).map((type) => (
            <option key={type} value={type}>
              {getProgramTypeText(type)}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
          <button
            onClick={() => setViewMode('grid')}
            className={`p-2 rounded ${viewMode === 'grid' ? 'bg-white dark:bg-gray-700 shadow' : ''}`}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`p-2 rounded ${viewMode === 'list' ? 'bg-white dark:bg-gray-700 shadow' : ''}`}
          >
            <List className="h-4 w-4" />
          </button>
        </div>

        <button
          onClick={() => refetch()}
          className="p-2 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
        </div>
      ) : filteredPrograms.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 dark:bg-gray-800 rounded-lg">
          <Workflow className="h-12 w-12 mx-auto text-gray-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
            Program bulunamadi
          </h3>
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            Yeni bir otomasyon programi olusturun
          </p>
          <button
            onClick={() => navigate('/sensor/automation/new')}
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" />
            Yeni Program
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
            />
          ))}
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Program</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Durum</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tip</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Versiyon</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Adimlar</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Guncelleme</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Islemler</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {filteredPrograms.map((program) => (
                <ProgramRow
                  key={program.id}
                  program={program}
                  onClone={() => handleClone(program)}
                  onArchive={() => handleArchive(program)}
                  onDelete={() => handleDelete(program)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default AutomationProgramsPage;
