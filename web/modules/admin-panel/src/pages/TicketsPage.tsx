/**
 * Tickets Page
 *
 * Support ticket management sistemi.
 * Priority, SLA tracking, assignment, internal notes.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Ticket,
  Search,
  Clock,
  User,
  AlertTriangle,
  AlertCircle,
  MessageSquare,
  ChevronRight,
  X,
  Send,
  Paperclip,
  Building2,
  Target,
  Star,
  RefreshCw,
  Inbox,
} from 'lucide-react';
import {
  supportApi,
  type SupportTicket as ApiSupportTicket,
  type TicketComment as ApiTicketComment,
  type TicketStats as ApiTicketStats,
  type TicketPriority,
  type TicketStatus,
  type TicketCategory,
} from '../services/adminApi';
import { Spinner, PageHeader } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

// Extend API types with UI-specific computed fields
interface SupportTicket extends Omit<ApiSupportTicket, 'tenantName' | 'tags'> {
  tenantName: string;
  tags: string[];
  // Computed/aliased fields for UI backwards compatibility
  reportedBy?: string;
  reportedByName?: string;
  commentCount?: number;
  // SLA deadline fields computed from slaResponseMinutes/slaResolutionMinutes
  slaResponseDeadline?: string;
  slaResolutionDeadline?: string;
}

interface TicketComment
  extends Omit<ApiTicketComment, 'authorType' | 'attachments' | 'authorName'> {
  authorType: string; // Allow any string for flexibility
  authorName: string;
  attachments: TicketAttachment[];
}

interface TicketAttachment {
  id: string;
  filename: string;
  url: string;
  size: number;
}

interface TicketStats
  extends Omit<ApiTicketStats, 'avgFirstResponseMinutes' | 'avgResolutionMinutes'> {
  // Aliased fields for UI
  avgResponseMinutes: number;
  avgResolutionMinutes: number;
  slaComplianceRate: number;
  satisfactionAvg: number;
}

interface SupportTeamMember {
  id: string;
  name: string;
  activeTickets: number;
}

// ============================================================================
// Component
// ============================================================================

export const TicketsPage: React.FC = () => {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [stats, setStats] = useState<TicketStats | null>(null);
  const [supportTeam, setSupportTeam] = useState<SupportTeamMember[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(null);
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'all'>('all');
  const [priorityFilter, setPriorityFilter] = useState<TicketPriority | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<TicketCategory | 'all'>('all');
  const [newComment, setNewComment] = useState('');
  const [isInternalNote, setIsInternalNote] = useState(false);

  // Fetch tickets from API
  const fetchTickets = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const params: Record<string, unknown> = { limit: 100 };
      if (statusFilter !== 'all') params.status = [statusFilter];
      if (priorityFilter !== 'all') params.priority = [priorityFilter];
      if (categoryFilter !== 'all') params.category = [categoryFilter];

      const result = await supportApi.getTickets(params);
      // Map API response to UI type
      const mappedTickets: SupportTicket[] = result.data.map((ticket: ApiSupportTicket) => {
        // Compute SLA deadlines from createdAt + slaMinutes if available
        const createdDate = new Date(ticket.createdAt);
        const slaResponseDeadline = ticket.slaResponseMinutes
          ? new Date(createdDate.getTime() + ticket.slaResponseMinutes * 60 * 1000).toISOString()
          : undefined;
        const slaResolutionDeadline = ticket.slaResolutionMinutes
          ? new Date(createdDate.getTime() + ticket.slaResolutionMinutes * 60 * 1000).toISOString()
          : ticket.dueAt;
        return {
          ...ticket,
          tenantName: ticket.tenantName || '',
          tags: ticket.tags || [],
          reportedBy: ticket.createdBy,
          reportedByName: ticket.createdByName || '',
          commentCount: 0, // Not provided by API
          slaResponseDeadline,
          slaResolutionDeadline,
        };
      });
      setTickets(mappedTickets);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setTickets([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, priorityFilter, categoryFilter]);

  // Fetch stats from API
  const fetchStats = useCallback(async () => {
    try {
      const data = await supportApi.getTicketStats();
      // Map API response to UI type
      const mappedStats: TicketStats = {
        ...data,
        avgResponseMinutes: data.avgFirstResponseMinutes || data.avgResponseTime || 0,
        avgResolutionMinutes: data.avgResolutionMinutes || data.avgResolutionTime || 0,
        slaComplianceRate: data.slaBreachCount
          ? 100 - (data.slaBreachCount / Math.max(data.total, 1)) * 100
          : 100,
        satisfactionAvg: data.avgSatisfactionRating || data.satisfactionScore || 0,
      };
      setStats(mappedStats);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  }, []);

  // Fetch support team
  const fetchSupportTeam = useCallback(async () => {
    try {
      const data = await supportApi.getTicketTeam();
      setSupportTeam(data || []);
    } catch (err) {
      console.error('Failed to fetch support team:', err);
    }
  }, []);

  // Fetch comments for a ticket
  const fetchComments = useCallback(async (ticketId: string) => {
    try {
      setCommentsLoading(true);
      const data = await supportApi.getTicketComments(ticketId);
      // Map API response to UI type - handle flexible response format
      const mappedComments: TicketComment[] = (data || []).map(
        (comment: Record<string, unknown>) => ({
          id: comment.id as string,
          ticketId: comment.ticketId as string,
          authorId: comment.authorId as string,
          authorName: (comment.authorName as string) || '',
          authorType: comment.authorType as string,
          content: comment.content as string,
          isInternal: comment.isInternal as boolean,
          createdAt: comment.createdAt as string,
          attachments: ((comment.attachments as Array<Record<string, unknown>>) || []).map(
            (att) => ({
              id: att.id as string,
              filename: (att.fileName || att.filename) as string,
              url: att.url as string,
              size: (att.fileSize || att.size || 0) as number,
            }),
          ),
        }),
      );
      setComments(mappedComments);
    } catch (err) {
      console.error('Failed to fetch comments:', err);
    } finally {
      setCommentsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTickets();
    fetchStats();
    fetchSupportTeam();
  }, [fetchTickets, fetchStats, fetchSupportTeam]);

  useEffect(() => {
    if (selectedTicket) {
      fetchComments(selectedTicket.id);
    }
  }, [selectedTicket, fetchComments]);

  const filteredTickets = tickets.filter((ticket) => {
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      if (
        !ticket.subject.toLowerCase().includes(query) &&
        !ticket.ticketNumber.toLowerCase().includes(query) &&
        !ticket.tenantName.toLowerCase().includes(query)
      ) {
        return false;
      }
    }
    return true;
  });

  const getPriorityColor = (priority: TicketPriority) => {
    switch (priority) {
      case 'critical':
        return 'bg-error-100 dark:bg-error-900/40 text-error-700 dark:text-error-300 border-error-200 dark:border-error-800';
      case 'high':
        return 'bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300 border-accent-200 dark:border-accent-800';
      case 'medium':
        return 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300 border-warning-200 dark:border-warning-800';
      case 'low':
        return 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700';
    }
  };

  // Exhaustive maps rather than switches: the unions are contract-derived now,
  // so a status or category added server-side is a compile error here instead
  // of a case that falls off the end and returns undefined. `getCategoryIcon`
  // was a switch and had drifted twice over — it handled `bug`, a member the
  // backend does not have, while `bug_report` and `account`, which it does,
  // rendered with no icon at all (ADMIN-MEDIUM-111).
  const STATUS_COLORS: Record<TicketStatus, string> = {
    open: 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300',
    in_progress: 'bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300',
    waiting_customer:
      'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300',
    resolved: 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300',
    closed: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
  };
  const getStatusColor = (status: TicketStatus): string => STATUS_COLORS[status];

  const STATUS_LABELS: Record<TicketStatus, string> = {
    open: 'Open',
    in_progress: 'In Progress',
    waiting_customer: 'Waiting',
    resolved: 'Resolved',
    closed: 'Closed',
  };
  const getStatusLabel = (status: TicketStatus): string => STATUS_LABELS[status];

  const CATEGORY_ICONS: Record<TicketCategory, React.ReactElement> = {
    technical: <AlertCircle size={14} />,
    billing: <Building2 size={14} />,
    feature_request: <Star size={14} />,
    bug_report: <AlertTriangle size={14} />,
    account: <Building2 size={14} />,
    general: <MessageSquare size={14} />,
  };
  const getCategoryIcon = (category: TicketCategory): React.ReactElement =>
    CATEGORY_ICONS[category];

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.abs(diff) / (1000 * 60 * 60);

    if (diff < 0) {
      if (hours < 1) return `in ${Math.round(Math.abs(diff) / (1000 * 60))}m`;
      if (hours < 24) return `in ${Math.round(hours)}h`;
      return date.toLocaleDateString();
    }

    if (hours < 1) return `${Math.round(diff / (1000 * 60))}m ago`;
    if (hours < 24) return `${Math.round(hours)}h ago`;
    return date.toLocaleDateString();
  };

  const isSLABreached = (deadline?: string) => {
    if (!deadline) return false;
    return new Date(deadline) < new Date();
  };

  const handleAssign = async (ticketId: string, assigneeId: string, assigneeName: string) => {
    try {
      const updated = await supportApi.assignTicket(ticketId, assigneeId, assigneeName);
      fetchTickets();
      if (selectedTicket?.id === ticketId) {
        // Compute SLA deadlines
        const createdDate = new Date(updated.createdAt);
        const slaResponseDeadline = updated.slaResponseMinutes
          ? new Date(createdDate.getTime() + updated.slaResponseMinutes * 60 * 1000).toISOString()
          : selectedTicket.slaResponseDeadline;
        const slaResolutionDeadline = updated.slaResolutionMinutes
          ? new Date(createdDate.getTime() + updated.slaResolutionMinutes * 60 * 1000).toISOString()
          : selectedTicket.slaResolutionDeadline;
        // Map API response to UI type
        const mappedTicket: SupportTicket = {
          ...updated,
          tenantName: updated.tenantName || '',
          tags: updated.tags || [],
          reportedBy: updated.createdBy,
          reportedByName: updated.createdByName || '',
          commentCount: selectedTicket.commentCount || 0,
          slaResponseDeadline,
          slaResolutionDeadline,
        };
        setSelectedTicket(mappedTicket);
      }
    } catch (err) {
      console.error('Failed to assign ticket:', err);
    }
  };

  const handleStatusChange = async (ticketId: string, newStatus: TicketStatus) => {
    try {
      await supportApi.updateTicketStatus(ticketId, newStatus);
      fetchTickets();
      fetchStats();
      if (selectedTicket?.id === ticketId) {
        setSelectedTicket({ ...selectedTicket, status: newStatus });
      }
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  };

  const handlePriorityChange = async (ticketId: string, newPriority: TicketPriority) => {
    try {
      await supportApi.updateTicketPriority(ticketId, newPriority);
      fetchTickets();
      if (selectedTicket?.id === ticketId) {
        setSelectedTicket({ ...selectedTicket, priority: newPriority });
      }
    } catch (err) {
      console.error('Failed to update priority:', err);
    }
  };

  const handleAddComment = async () => {
    if (!newComment.trim() || !selectedTicket) return;

    try {
      await supportApi.addTicketComment(selectedTicket.id, {
        content: newComment,
        isInternal: isInternalNote,
      });
      setNewComment('');
      setIsInternalNote(false);
      fetchComments(selectedTicket.id);
      fetchTickets();
    } catch (err) {
      console.error('Failed to add comment:', err);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-6 py-4">
        <PageHeader
          title="Support Tickets"
          description="Manage and resolve customer support requests"
          actions={
            <button
              onClick={() => {
                fetchTickets();
                fetchStats();
              }}
              className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <RefreshCw size={18} />
            </button>
          }
        />

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-8 gap-3 mt-4">
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
              <div className="text-sm text-gray-500 dark:text-gray-400">Total</div>
              <div className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                {stats.total}
              </div>
            </div>
            <div className="bg-info-50 dark:bg-info-900/20 rounded-lg p-3">
              <div className="text-sm text-info-600 dark:text-info-400">Open</div>
              <div className="text-xl font-semibold text-info-700 dark:text-info-300">
                {stats.open}
              </div>
            </div>
            <div className="bg-accent-50 dark:bg-accent-900/20 rounded-lg p-3">
              <div className="text-sm text-accent-600 dark:text-accent-400">In Progress</div>
              <div className="text-xl font-semibold text-accent-700 dark:text-accent-300">
                {stats.inProgress}
              </div>
            </div>
            <div className="bg-success-50 dark:bg-success-900/20 rounded-lg p-3">
              <div className="text-sm text-success-600 dark:text-success-400">Resolved</div>
              <div className="text-xl font-semibold text-success-700 dark:text-success-300">
                {stats.resolved}
              </div>
            </div>
            <div className="bg-primary-50 dark:bg-primary-900/20 rounded-lg p-3">
              <div className="text-sm text-primary-600 dark:text-primary-400">Avg Response</div>
              <div className="text-xl font-semibold text-primary-700 dark:text-primary-300">
                {stats.avgResponseMinutes}m
              </div>
            </div>
            <div className="bg-info-50 dark:bg-info-900/20 rounded-lg p-3">
              <div className="text-sm text-info-600 dark:text-info-400">Avg Resolution</div>
              <div className="text-xl font-semibold text-info-700 dark:text-info-300">
                {Math.round(stats.avgResolutionMinutes / 60)}h
              </div>
            </div>
            <div className="bg-success-50 dark:bg-success-900/20 rounded-lg p-3">
              <div className="text-sm text-success-600 dark:text-success-400">SLA Compliance</div>
              <div className="text-xl font-semibold text-success-700 dark:text-success-300">
                {stats.slaComplianceRate}%
              </div>
            </div>
            <div className="bg-warning-50 dark:bg-warning-900/20 rounded-lg p-3">
              <div className="text-sm text-warning-600 dark:text-warning-400">Satisfaction</div>
              <div className="flex items-center gap-1">
                <Star size={16} className="text-warning-500 fill-warning-500" />
                <span className="text-xl font-semibold text-warning-700 dark:text-warning-300">
                  {stats.satisfactionAvg}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Ticket List */}
        <div
          className={`${selectedTicket ? 'w-1/2' : 'w-full'} flex flex-col border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900`}
        >
          {/* Filters */}
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 space-y-3">
            <div className="relative">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400"
                size={18}
              />
              <input
                type="text"
                placeholder="Search tickets..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500 focus:border-info-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as TicketStatus | 'all')}
                className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500"
              >
                <option value="all">All Status</option>
                <option value="open">Open</option>
                <option value="in_progress">In Progress</option>
                <option value="waiting_customer">Waiting</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </select>
              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value as TicketPriority | 'all')}
                className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500"
              >
                <option value="all">All Priority</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value as TicketCategory | 'all')}
                className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500"
              >
                <option value="all">All Categories</option>
                <option value="technical">Technical</option>
                <option value="billing">Billing</option>
                <option value="feature_request">Feature Request</option>
                <option value="bug">Bug</option>
                <option value="general">General</option>
              </select>
            </div>
          </div>

          {/* Ticket List */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <Spinner size="lg" />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center h-full text-error-500 p-4">
                <AlertCircle size={32} className="mb-2" />
                <p className="text-center">{error}</p>
                <button
                  onClick={fetchTickets}
                  className="mt-2 text-sm text-info-600 dark:text-info-400 hover:text-info-700 dark:hover:text-info-200"
                >
                  Retry
                </button>
              </div>
            ) : filteredTickets.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 dark:text-gray-400 p-4">
                <Inbox size={48} className="mb-2 text-gray-500 dark:text-gray-400" />
                <p>No tickets found</p>
              </div>
            ) : (
              filteredTickets.map((ticket) => (
                <div
                  key={ticket.id}
                  onClick={() => setSelectedTicket(ticket)}
                  className={`p-4 border-b border-gray-100 dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 ${
                    selectedTicket?.id === ticket.id
                      ? 'bg-info-50 dark:bg-info-900/20 border-l-4 border-l-blue-500'
                      : ''
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-2 py-0.5 text-xs rounded border ${getPriorityColor(ticket.priority)}`}
                        >
                          {ticket.priority}
                        </span>
                        <span
                          className={`px-2 py-0.5 text-xs rounded ${getStatusColor(ticket.status)}`}
                        >
                          {getStatusLabel(ticket.status)}
                        </span>
                        {isSLABreached(ticket.slaResponseDeadline) && !ticket.firstResponseAt && (
                          <span className="px-2 py-0.5 text-xs rounded bg-error-100 dark:bg-error-900/40 text-error-700 dark:text-error-300">
                            SLA Breach
                          </span>
                        )}
                      </div>
                      <h3 className="font-medium text-gray-900 dark:text-gray-100 mt-1 truncate">
                        {ticket.subject}
                      </h3>
                      <div className="flex items-center gap-2 mt-1 text-sm text-gray-500 dark:text-gray-400">
                        <span>{ticket.ticketNumber}</span>
                        <span>·</span>
                        <span>{ticket.tenantName}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-2 text-xs text-gray-500 dark:text-gray-400">
                        <span className="flex items-center gap-1">
                          <Clock size={12} />
                          {formatTime(ticket.createdAt)}
                        </span>
                        {ticket.assignedToName && (
                          <span className="flex items-center gap-1">
                            <User size={12} />
                            {ticket.assignedToName}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <MessageSquare size={12} />
                          {ticket.commentCount}
                        </span>
                      </div>
                    </div>
                    <ChevronRight size={18} className="text-gray-500 dark:text-gray-400" />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Ticket Detail */}
        {selectedTicket && (
          <div className="w-1/2 flex flex-col bg-gray-50 dark:bg-gray-800">
            {/* Detail Header */}
            <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-6 py-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-2 py-0.5 text-xs rounded border ${getPriorityColor(selectedTicket.priority)}`}
                    >
                      {selectedTicket.priority}
                    </span>
                    <span
                      className={`px-2 py-0.5 text-xs rounded ${getStatusColor(selectedTicket.status)}`}
                    >
                      {getStatusLabel(selectedTicket.status)}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                      {getCategoryIcon(selectedTicket.category)}
                      {selectedTicket.category.replace('_', ' ')}
                    </span>
                  </div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mt-2">
                    {selectedTicket.subject}
                  </h2>
                  <div className="flex items-center gap-3 mt-1 text-sm text-gray-500 dark:text-gray-400">
                    <span>{selectedTicket.ticketNumber}</span>
                    <span>·</span>
                    <span>{selectedTicket.tenantName}</span>
                    <span>·</span>
                    <span>by {selectedTicket.reportedByName}</span>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedTicket(null)}
                  className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <X size={20} />
                </button>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-3 mt-4">
                {/* Status Change */}
                <select
                  value={selectedTicket.status}
                  onChange={(e) =>
                    handleStatusChange(selectedTicket.id, e.target.value as TicketStatus)
                  }
                  className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500"
                >
                  <option value="open">Open</option>
                  <option value="in_progress">In Progress</option>
                  <option value="waiting_customer">Waiting for Customer</option>
                  <option value="resolved">Resolved</option>
                  <option value="closed">Closed</option>
                </select>

                {/* Priority Change */}
                <select
                  value={selectedTicket.priority}
                  onChange={(e) =>
                    handlePriorityChange(selectedTicket.id, e.target.value as TicketPriority)
                  }
                  className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500"
                >
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>

                {/* Assign */}
                <select
                  value={selectedTicket.assignedTo || ''}
                  onChange={(e) => {
                    const member = supportTeam.find((m) => m.id === e.target.value);
                    if (member) {
                      handleAssign(selectedTicket.id, member.id, member.name);
                    }
                  }}
                  className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500"
                >
                  <option value="">Assign to...</option>
                  {supportTeam.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name} ({member.activeTickets} active)
                    </option>
                  ))}
                </select>
              </div>

              {/* SLA Info */}
              {(selectedTicket.slaResponseDeadline || selectedTicket.slaResolutionDeadline) && (
                <div className="flex items-center gap-4 mt-4 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg text-sm">
                  {selectedTicket.slaResponseDeadline && !selectedTicket.firstResponseAt && (
                    <div
                      className={`flex items-center gap-2 ${isSLABreached(selectedTicket.slaResponseDeadline) ? 'text-error-600 dark:text-error-400' : 'text-gray-600 dark:text-gray-400'}`}
                    >
                      <Clock size={14} />
                      <span>Response: {formatTime(selectedTicket.slaResponseDeadline)}</span>
                      {isSLABreached(selectedTicket.slaResponseDeadline) && (
                        <AlertTriangle size={14} className="text-error-500" />
                      )}
                    </div>
                  )}
                  {selectedTicket.slaResolutionDeadline &&
                    selectedTicket.status !== 'resolved' &&
                    selectedTicket.status !== 'closed' && (
                      <div
                        className={`flex items-center gap-2 ${isSLABreached(selectedTicket.slaResolutionDeadline) ? 'text-error-600 dark:text-error-400' : 'text-gray-600 dark:text-gray-400'}`}
                      >
                        <Target size={14} />
                        <span>Resolution: {formatTime(selectedTicket.slaResolutionDeadline)}</span>
                        {isSLABreached(selectedTicket.slaResolutionDeadline) && (
                          <AlertTriangle size={14} className="text-error-500" />
                        )}
                      </div>
                    )}
                </div>
              )}

              {/* Tags */}
              {selectedTicket.tags && selectedTicket.tags.length > 0 && (
                <div className="flex items-center gap-2 mt-3">
                  {selectedTicket.tags.map((tag) => (
                    <span
                      key={tag}
                      className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 text-xs rounded"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Comments */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {commentsLoading ? (
                <div className="flex items-center justify-center h-full">
                  <Spinner size="lg" />
                </div>
              ) : comments.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-500 dark:text-gray-400">
                  <MessageSquare size={48} className="mb-2 text-gray-500 dark:text-gray-400" />
                  <p>No comments yet</p>
                </div>
              ) : (
                comments.map((comment) => (
                  <div
                    key={comment.id}
                    className={`rounded-lg p-4 ${
                      comment.isInternal
                        ? 'bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800'
                        : comment.authorType === 'admin'
                          ? 'bg-info-50 dark:bg-info-900/20 border border-info-100 dark:border-info-800'
                          : 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700'
                    }`}
                  >
                    {comment.isInternal && (
                      <div className="flex items-center gap-1 text-warning-700 dark:text-warning-300 text-xs mb-2">
                        <AlertCircle size={12} />
                        Internal Note
                      </div>
                    )}
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-gray-200 dark:bg-gray-700 rounded-full flex items-center justify-center">
                          <User size={16} className="text-gray-500 dark:text-gray-400" />
                        </div>
                        <div>
                          <div className="font-medium text-gray-900 dark:text-gray-100 text-sm">
                            {comment.authorName}
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {comment.authorType === 'admin' ? 'Support Team' : 'Customer'}
                          </div>
                        </div>
                      </div>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {formatTime(comment.createdAt)}
                      </span>
                    </div>
                    <p
                      className={`text-sm whitespace-pre-wrap ${comment.isInternal ? 'text-warning-800 dark:text-warning-200' : 'text-gray-700 dark:text-gray-300'}`}
                    >
                      {comment.content}
                    </p>
                    {comment.attachments && comment.attachments.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {comment.attachments.map((att) => (
                          <a
                            key={att.id}
                            href={att.url}
                            className="flex items-center gap-2 p-2 bg-white dark:bg-gray-900 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 text-sm"
                          >
                            <Paperclip size={14} className="text-gray-500 dark:text-gray-400" />
                            <span className="text-gray-700 dark:text-gray-300">{att.filename}</span>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Reply Input */}
            {selectedTicket.status !== 'closed' && (
              <div className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <button
                    onClick={() => setIsInternalNote(!isInternalNote)}
                    className={`text-xs px-2 py-1 rounded ${
                      isInternalNote
                        ? 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300 border border-warning-300 dark:border-warning-700'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
                    }`}
                  >
                    {isInternalNote ? 'Internal Note' : 'Public Reply'}
                  </button>
                </div>
                <div className="flex items-end gap-3">
                  <textarea
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    placeholder={isInternalNote ? 'Add internal note...' : 'Write a reply...'}
                    rows={3}
                    className="flex-1 px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg resize-none focus:ring-2 focus:ring-info-500 focus:border-info-500"
                  />
                  <div className="flex flex-col gap-2">
                    <button className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">
                      <Paperclip size={20} />
                    </button>
                    <button
                      onClick={handleAddComment}
                      disabled={!newComment.trim()}
                      className="p-3 bg-info-600 text-white rounded-lg hover:bg-info-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Send size={20} />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Satisfaction Rating */}
            {selectedTicket.status === 'resolved' && selectedTicket.satisfactionRating && (
              <div className="bg-success-50 dark:bg-success-900/20 border-t border-success-200 dark:border-success-800 px-4 py-3">
                <div className="flex items-center justify-center gap-2">
                  <span className="text-sm text-success-700 dark:text-success-300">
                    Customer Satisfaction:
                  </span>
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <Star
                        key={star}
                        size={16}
                        className={
                          star <= selectedTicket.satisfactionRating!
                            ? 'text-warning-500 fill-warning-500'
                            : 'text-gray-500 dark:text-gray-400'
                        }
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default TicketsPage;
