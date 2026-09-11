/**
 * Tickets Page — a comment thread that was always empty, and an SLA card that
 * could not be wrong (ADMIN-CRITICAL-156 / ADMIN-MEDIUM-114 / ADMIN-HIGH-121).
 *
 * 1. **Every ticket's comment thread rendered empty, silently.**
 *    `GET /support/tickets/:id/comments` returns a PAGINATED result; the
 *    client declared a flat array, so `(data || []).map(...)` called `.map` on
 *    the page object, threw a `TypeError`, and `fetchComments`'s `catch` wrote
 *    it to `console.error`. An admin opened a ticket, saw no messages, and
 *    replied to a customer whose messages were right there in the database.
 *    ADMIN-MEDIUM-114 tracked the missing DTO; this is what it cost.
 *
 * 2. **The stats endpoint's shape was invented.** It sends ten required
 *    numbers; the client declared twenty, half of them optional aliases the
 *    server has never sent — `avgResponseTime`, `avgResolutionTime`,
 *    `satisfactionScore`, `byCategory`, `byPriority` — and marked the four
 *    real averages optional. That is where the page's `a || b || 0` chains
 *    came from, and where `slaBreachCount ? … : 100` came from: the type said
 *    the truth might be missing, so the page invented **100% SLA compliance**
 *    for when it was.
 *
 * 3. **Three cards measured an absence.** `getTicketStats` returned `0` when
 *    there was nothing to average, so a platform that had answered no ticket
 *    yet showed _"Avg Response: 0m"_ — instant — and one nobody had rated
 *    showed a ★ 0. Those three are `null` on the wire now, and an em dash
 *    here.
 *
 * 4. **Every row's message badge read 0.** `commentCount: 0, // Not provided
 *    by API` — a count the endpoint does not return, rendered on every ticket
 *    in the queue. The badge is gone from the list; the detail pane shows the
 *    count it actually loaded.
 *
 * 5. **Four writes failed silently.** Assign, status, priority and comment
 *    each caught into `console.error`, so a refused state transition looked
 *    identical to an applied one — and the list refetched, showing the
 *    unchanged ticket back.
 *
 * 6. **`slaComplianceRate` rendered its floating-point tail**: three breaches
 *    over seven tickets printed `57.142857142857146%`.
 */

import React, { useMemo, useState } from 'react';
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
  Loader2,
  Inbox,
} from 'lucide-react';
import {
  supportApi,
  type SupportTicket as ApiSupportTicket,
  type TicketComment,
  type TicketStats,
  type TicketPriority,
  type TicketStatus,
  type TicketCategory,
} from '../services/adminApi';
import { adminKeys, useAdminMutation, useAdminQuery } from '../hooks';
import { QueryFailureNotice } from '../components/QueryFailureNotice';

// ============================================================================
// Types
// ============================================================================

/**
 * A ticket row with the two SLA deadlines the queue sorts and badges by.
 *
 * `commentCount` is gone: it was hardcoded to 0 with a comment admitting the
 * API does not provide it, and rendered on every row.
 */
interface QueueTicket extends ApiSupportTicket {
  /** The response deadline, derived from `createdAt + slaResponseMinutes`. */
  readonly slaResponseDeadline?: string;
  /**
   * The resolution deadline.
   *
   * `dueAt` when the server set one — it is the server's own deadline and
   * therefore the authority — and only derived from
   * `createdAt + slaResolutionMinutes` when it did not. The previous order was
   * inverted: it derived first and fell back to `dueAt`, so the same column
   * meant two different things depending on which fields a ticket happened to
   * carry.
   */
  readonly slaResolutionDeadline?: string;
}

interface SupportTeamMember {
  id: string;
  name: string;
  activeTickets: number;
}

/** How many tickets one queue request asks for. */
const QUEUE_PAGE_SIZE = 100;

/** A statistic the page has, or an em dash for one with no observations. */
const measured = (value: number | null, suffix = ''): string =>
  value === null ? '—' : `${value.toLocaleString()}${suffix}`;

/**
 * SLA compliance as a whole percentage, over every ticket.
 *
 * The server does not compute this; the page derives it from two fields it
 * always sends. There is no `? : 100` any more — `slaBreachCount` is required,
 * so zero breaches gives 100 by arithmetic rather than by fallback — and the
 * result is rounded, because three breaches over seven tickets used to print
 * `57.142857142857146%`.
 */
function slaCompliancePercent(stats: TicketStats): number {
  if (stats.total === 0) return 100;
  return Math.round((1 - stats.slaBreachCount / stats.total) * 1000) / 10;
}

/** The two SLA deadlines for one ticket, from the fields the API sends. */
function withDeadlines(ticket: ApiSupportTicket): QueueTicket {
  const createdAt = new Date(ticket.createdAt).getTime();
  return {
    ...ticket,
    slaResponseDeadline: ticket.slaResponseMinutes
      ? new Date(createdAt + ticket.slaResponseMinutes * 60_000).toISOString()
      : undefined,
    slaResolutionDeadline:
      ticket.dueAt ??
      (ticket.slaResolutionMinutes
        ? new Date(createdAt + ticket.slaResolutionMinutes * 60_000).toISOString()
        : undefined),
  };
}

// ============================================================================
// Component
// ============================================================================

export const TicketsPage: React.FC = () => {
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'all'>('all');
  const [priorityFilter, setPriorityFilter] = useState<TicketPriority | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<TicketCategory | 'all'>('all');
  const [newComment, setNewComment] = useState('');
  const [isInternalNote, setIsInternalNote] = useState(false);

  const queueFilters = useMemo(
    () => ({
      limit: QUEUE_PAGE_SIZE,
      ...(statusFilter === 'all' ? {} : { status: [statusFilter] }),
      ...(priorityFilter === 'all' ? {} : { priority: [priorityFilter] }),
      ...(categoryFilter === 'all' ? {} : { category: [categoryFilter] }),
    }),
    [statusFilter, priorityFilter, categoryFilter],
  );

  const ticketsQuery = useAdminQuery(
    adminKeys.tickets.list(queueFilters),
    ({ signal }) => supportApi.getTickets(queueFilters, signal),
  );
  const statsQuery = useAdminQuery<TicketStats>(adminKeys.tickets.stats(), ({ signal }) =>
    supportApi.getTicketStats(signal),
  );
  const teamQuery = useAdminQuery(adminKeys.tickets.team(), ({ signal }) =>
    supportApi.getTicketTeam(signal),
  );
  const commentsQuery = useAdminQuery(
    adminKeys.tickets.comments(selectedTicketId ?? ''),
    ({ signal }) => supportApi.getTicketComments(selectedTicketId ?? '', signal),
    { enabled: selectedTicketId !== null },
  );

  const tickets: readonly QueueTicket[] = useMemo(
    () => (ticketsQuery.data?.data ?? []).map(withDeadlines),
    [ticketsQuery.data],
  );
  const stats = statsQuery.data;
  const supportTeam: readonly SupportTeamMember[] = teamQuery.data ?? [];
  // A PAGE, not an array. Reading `.data` off the decoded envelope is the fix
  // for the thread that was always empty.
  const comments: readonly TicketComment[] = commentsQuery.data?.data ?? [];
  const selectedTicket = tickets.find((ticket) => ticket.id === selectedTicketId) ?? null;

  const loading = ticketsQuery.isPending;
  const error = ticketsQuery.error;

  // Every write moves the queue and the aggregate, so both are invalidated.
  const queueKeys = [adminKeys.tickets.all()];

  const assignMutation = useAdminMutation(
    (input: { ticketId: string; assigneeId: string; assigneeName: string }) =>
      supportApi.assignTicket(input.ticketId, input.assigneeId, input.assigneeName),
    { invalidateKeys: queueKeys },
  );
  const statusMutation = useAdminMutation(
    (input: { ticketId: string; status: TicketStatus }) =>
      supportApi.updateTicketStatus(input.ticketId, input.status),
    { invalidateKeys: queueKeys },
  );
  const priorityMutation = useAdminMutation(
    (input: { ticketId: string; priority: TicketPriority }) =>
      supportApi.updateTicketPriority(input.ticketId, input.priority),
    { invalidateKeys: queueKeys },
  );
  const commentMutation = useAdminMutation(
    (input: { ticketId: string; content: string; isInternal: boolean }) =>
      supportApi.addTicketComment(input.ticketId, {
        content: input.content,
        isInternal: input.isInternal,
      }),
    {
      invalidateKeys: queueKeys,
      mutationOptions: {
        onSuccess: () => {
          setNewComment('');
          setIsInternalNote(false);
        },
      },
    },
  );

  const reload = (): void => {
    void ticketsQuery.refetch();
    void statsQuery.refetch();
    void teamQuery.refetch();
    if (selectedTicketId !== null) void commentsQuery.refetch();
  };

  const filteredTickets = tickets.filter(ticket => {
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      if (!ticket.subject.toLowerCase().includes(query) &&
          !ticket.ticketNumber.toLowerCase().includes(query) &&
          !(ticket.tenantName ?? '').toLowerCase().includes(query)) {
        return false;
      }
    }
    return true;
  });

  const getPriorityColor = (priority: TicketPriority) => {
    switch (priority) {
      case 'critical': return 'bg-red-100 text-red-700 border-red-200';
      case 'high': return 'bg-orange-100 text-orange-700 border-orange-200';
      case 'medium': return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      case 'low': return 'bg-gray-100 text-gray-700 border-gray-200';
    }
  };

  // Exhaustive maps rather than switches: the unions are contract-derived now,
  // so a status or category added server-side is a compile error here instead
  // of a case that falls off the end and returns undefined. `getCategoryIcon`
  // was a switch and had drifted twice over — it handled `bug`, a member the
  // backend does not have, while `bug_report` and `account`, which it does,
  // rendered with no icon at all (ADMIN-MEDIUM-111).
  const STATUS_COLORS: Record<TicketStatus, string> = {
    open: 'bg-blue-100 text-blue-700',
    in_progress: 'bg-purple-100 text-purple-700',
    waiting_customer: 'bg-yellow-100 text-yellow-700',
    resolved: 'bg-green-100 text-green-700',
    closed: 'bg-gray-100 text-gray-600',
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

  /**
   * Assign, transition, reprioritise, comment.
   *
   * Each of these caught its failure into `console.error` and then refetched,
   * so a refused transition looked exactly like an applied one: same click,
   * same repaint, the ticket unchanged. They go through `useAdminMutation`
   * now, and every refusal is named by the notice at the top of the page.
   */
  const handleAssign = (ticketId: string, assigneeId: string, assigneeName: string): void => {
    assignMutation.mutate({ ticketId, assigneeId, assigneeName });
  };

  const handleStatusChange = (ticketId: string, status: TicketStatus): void => {
    statusMutation.mutate({ ticketId, status });
  };

  const handlePriorityChange = (ticketId: string, priority: TicketPriority): void => {
    priorityMutation.mutate({ ticketId, priority });
  };

  const handleAddComment = (): void => {
    if (newComment.trim() === '' || selectedTicket === null) return;
    commentMutation.mutate({
      ticketId: selectedTicket.id,
      content: newComment,
      isInternal: isInternalNote,
    });
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Support Tickets</h1>
            <p className="text-gray-500 mt-1">Manage and resolve customer support requests</p>
          </div>
          <button
            onClick={reload}
            className="p-2 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100"
          >
            <RefreshCw size={18} />
          </button>
        </div>

        {/* Every failed read and every refused write, named in one place. */}
        <div className="mt-4">
          <QueryFailureNotice
            errors={[
              ticketsQuery.error,
              statsQuery.error,
              teamQuery.error,
              commentsQuery.error,
              assignMutation.error,
              statusMutation.error,
              priorityMutation.error,
              commentMutation.error,
            ]}
            hasContent={tickets.length > 0}
            onRetry={reload}
          />
        </div>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-8 gap-3 mt-4">
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-sm text-gray-500">Total</div>
              <div className="text-xl font-semibold text-gray-900">{stats.total}</div>
            </div>
            <div className="bg-blue-50 rounded-lg p-3">
              <div className="text-sm text-blue-600">Open</div>
              <div className="text-xl font-semibold text-blue-700">{stats.open}</div>
            </div>
            <div className="bg-purple-50 rounded-lg p-3">
              <div className="text-sm text-purple-600">In Progress</div>
              <div className="text-xl font-semibold text-purple-700">{stats.inProgress}</div>
            </div>
            <div className="bg-green-50 rounded-lg p-3">
              <div className="text-sm text-green-600">Resolved</div>
              <div className="text-xl font-semibold text-green-700">{stats.resolved}</div>
            </div>
            <div className="bg-indigo-50 rounded-lg p-3">
              <div className="text-sm text-indigo-600">Avg Response</div>
              <div className="text-xl font-semibold text-indigo-700">{measured(stats.avgFirstResponseMinutes, 'm')}</div>
            </div>
            <div className="bg-cyan-50 rounded-lg p-3">
              <div className="text-sm text-cyan-600">Avg Resolution</div>
              <div className="text-xl font-semibold text-cyan-700">{stats.avgResolutionMinutes === null
                  ? '—'
                  : `${Math.round(stats.avgResolutionMinutes / 60)}h`}</div>
            </div>
            <div className="bg-emerald-50 rounded-lg p-3">
              <div className="text-sm text-emerald-600">SLA Compliance</div>
              <div className="text-xl font-semibold text-emerald-700">{slaCompliancePercent(stats)}%</div>
            </div>
            <div className="bg-amber-50 rounded-lg p-3">
              <div className="text-sm text-amber-600">Satisfaction</div>
              <div className="flex items-center gap-1">
                <Star size={16} className="text-amber-500 fill-amber-500" />
                <span className="text-xl font-semibold text-amber-700">{measured(stats.avgSatisfactionRating)}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Ticket List */}
        <div className={`${selectedTicket ? 'w-1/2' : 'w-full'} flex flex-col border-r border-gray-200 bg-white`}>
          {/* Filters */}
          <div className="p-4 border-b border-gray-200 space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={18} />
              <input
                type="text"
                placeholder="Search tickets..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as TicketStatus | 'all')}
                className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
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
                className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
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
                className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
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
                <Loader2 className="animate-spin text-blue-600" size={32} />
              </div>
            ) : error ? (
              // The notice at the top of the page carries the reason. Nothing
              // is drawn here: an empty queue asserts there are no tickets.
              null
            ) : filteredTickets.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 p-4">
                <Inbox size={48} className="mb-2 text-gray-500" />
                <p>No tickets found</p>
              </div>
            ) : (
              filteredTickets.map((ticket) => (
                <div
                  key={ticket.id}
                  onClick={() => setSelectedTicketId(ticket.id)}
                  className={`p-4 border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${
                    selectedTicket?.id === ticket.id ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 text-xs rounded border ${getPriorityColor(ticket.priority)}`}>
                          {ticket.priority}
                        </span>
                        <span className={`px-2 py-0.5 text-xs rounded ${getStatusColor(ticket.status)}`}>
                          {getStatusLabel(ticket.status)}
                        </span>
                        {isSLABreached(ticket.slaResponseDeadline) && !ticket.firstResponseAt && (
                          <span className="px-2 py-0.5 text-xs rounded bg-red-100 text-red-700">
                            SLA Breach
                          </span>
                        )}
                      </div>
                      <h3 className="font-medium text-gray-900 mt-1 truncate">{ticket.subject}</h3>
                      <div className="flex items-center gap-2 mt-1 text-sm text-gray-500">
                        <span>{ticket.ticketNumber}</span>
                        <span>·</span>
                        <span>{ticket.tenantName}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
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
                        {/* The message badge is gone: it was hardcoded to 0
                            with a comment admitting the API does not send a
                            comment count, so every ticket in the queue read
                            "no messages". The detail pane shows the count it
                            actually loaded. */}
                      </div>
                    </div>
                    <ChevronRight size={18} className="text-gray-500" />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Ticket Detail */}
        {selectedTicket && (
          <div className="w-1/2 flex flex-col bg-gray-50">
            {/* Detail Header */}
            <div className="bg-white border-b border-gray-200 px-6 py-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 text-xs rounded border ${getPriorityColor(selectedTicket.priority)}`}>
                      {selectedTicket.priority}
                    </span>
                    <span className={`px-2 py-0.5 text-xs rounded ${getStatusColor(selectedTicket.status)}`}>
                      {getStatusLabel(selectedTicket.status)}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-gray-500">
                      {getCategoryIcon(selectedTicket.category)}
                      {selectedTicket.category.replace('_', ' ')}
                    </span>
                  </div>
                  <h2 className="text-lg font-semibold text-gray-900 mt-2">
                    {selectedTicket.subject}
                  </h2>
                  <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
                    <span>{selectedTicket.ticketNumber}</span>
                    <span>·</span>
                    <span>{selectedTicket.tenantName}</span>
                    <span>·</span>
                    <span>by {(selectedTicket.createdByName ?? selectedTicket.createdBy)}</span>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedTicketId(null)}
                  className="p-2 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                >
                  <X size={20} />
                </button>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-3 mt-4">
                {/* Status Change */}
                <select
                  aria-label="Ticket status"
                  value={selectedTicket.status}
                  onChange={(e) => handleStatusChange(selectedTicket.id, e.target.value as TicketStatus)}
                  className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                >
                  <option value="open">Open</option>
                  <option value="in_progress">In Progress</option>
                  <option value="waiting_customer">Waiting for Customer</option>
                  <option value="resolved">Resolved</option>
                  <option value="closed">Closed</option>
                </select>

                {/* Priority Change */}
                <select
                  aria-label="Ticket priority"
                  value={selectedTicket.priority}
                  onChange={(e) => handlePriorityChange(selectedTicket.id, e.target.value as TicketPriority)}
                  className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
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
                    const member = supportTeam.find(m => m.id === e.target.value);
                    if (member) {
                      handleAssign(selectedTicket.id, member.id, member.name);
                    }
                  }}
                  className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
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
                <div className="flex items-center gap-4 mt-4 p-3 bg-gray-50 rounded-lg text-sm">
                  {selectedTicket.slaResponseDeadline && !selectedTicket.firstResponseAt && (
                    <div className={`flex items-center gap-2 ${isSLABreached(selectedTicket.slaResponseDeadline) ? 'text-red-600' : 'text-gray-600'}`}>
                      <Clock size={14} />
                      <span>Response: {formatTime(selectedTicket.slaResponseDeadline)}</span>
                      {isSLABreached(selectedTicket.slaResponseDeadline) && (
                        <AlertTriangle size={14} className="text-red-500" />
                      )}
                    </div>
                  )}
                  {selectedTicket.slaResolutionDeadline && selectedTicket.status !== 'resolved' && selectedTicket.status !== 'closed' && (
                    <div className={`flex items-center gap-2 ${isSLABreached(selectedTicket.slaResolutionDeadline) ? 'text-red-600' : 'text-gray-600'}`}>
                      <Target size={14} />
                      <span>Resolution: {formatTime(selectedTicket.slaResolutionDeadline)}</span>
                      {isSLABreached(selectedTicket.slaResolutionDeadline) && (
                        <AlertTriangle size={14} className="text-red-500" />
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Tags */}
              {selectedTicket.tags && selectedTicket.tags.length > 0 && (
                <div className="flex items-center gap-2 mt-3">
                  {selectedTicket.tags.map((tag) => (
                    <span key={tag} className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Comments */}
            <div className="px-4 pt-3 flex items-center gap-2 text-xs text-gray-500">
              <MessageSquare size={12} />
              {/* The count the page actually loaded — the list rows used to
                  show a hardcoded 0 for this. */}
              {commentsQuery.data === undefined
                ? '—'
                : `${commentsQuery.data.total.toLocaleString()} message${
                    commentsQuery.data.total === 1 ? '' : 's'
                  }`}
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {commentsQuery.isPending ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="animate-spin text-blue-600" size={32} />
                </div>
              ) : commentsQuery.isError ? (
                // The notice at the top carries the reason. Nothing is drawn
                // here: "No comments yet" on a support thread is a claim, and
                // it is the exact claim this page made on EVERY ticket while
                // the read threw into a console.error (ADMIN-CRITICAL-156).
                null
              ) : comments.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-500">
                  <MessageSquare size={48} className="mb-2 text-gray-500" />
                  <p>No comments yet</p>
                </div>
              ) : (
                comments.map((comment) => (
                  <div
                    key={comment.id}
                    className={`rounded-lg p-4 ${
                      comment.isInternal
                        ? 'bg-yellow-50 border border-yellow-200'
                        : comment.authorType === 'admin'
                        ? 'bg-blue-50 border border-blue-100'
                        : 'bg-white border border-gray-200'
                    }`}
                  >
                    {comment.isInternal && (
                      <div className="flex items-center gap-1 text-yellow-700 text-xs mb-2">
                        <AlertCircle size={12} />
                        Internal Note
                      </div>
                    )}
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center">
                          <User size={16} className="text-gray-500" />
                        </div>
                        <div>
                          <div className="font-medium text-gray-900 text-sm">{comment.authorName}</div>
                          <div className="text-xs text-gray-500">
                            {comment.authorType === 'admin' ? 'Support Team' : 'Customer'}
                          </div>
                        </div>
                      </div>
                      <span className="text-xs text-gray-500">{formatTime(comment.createdAt)}</span>
                    </div>
                    <p className={`text-sm whitespace-pre-wrap ${comment.isInternal ? 'text-yellow-800' : 'text-gray-700'}`}>
                      {comment.content}
                    </p>
                    {comment.attachments && comment.attachments.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {comment.attachments.map((att) => (
                          <a
                            key={att.id}
                            href={att.url}
                            className="flex items-center gap-2 p-2 bg-white rounded border border-gray-200 hover:bg-gray-50 text-sm"
                          >
                            <Paperclip size={14} className="text-gray-500" />
                            <span className="text-gray-700">{att.fileName}</span>
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
              <div className="bg-white border-t border-gray-200 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <button
                    onClick={() => setIsInternalNote(!isInternalNote)}
                    className={`text-xs px-2 py-1 rounded ${
                      isInternalNote
                        ? 'bg-yellow-100 text-yellow-700 border border-yellow-300'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
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
                    className="flex-1 px-4 py-3 border border-gray-300 rounded-lg resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <div className="flex flex-col gap-2">
                    {/* The attachment button had no onClick at all: a control
                        that did nothing, on the surface where an admin
                        answers a customer. Removed rather than left, per
                        ADMIN-HIGH-011 — a control whose request can never
                        succeed is not shown. Attaching a file to a reply
                        needs the add-comment endpoint to accept one. */}
                    <button
                      onClick={handleAddComment}
                      aria-label="Send reply"
                      disabled={!newComment.trim() || commentMutation.isPending}
                      className="p-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Send size={20} />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Satisfaction Rating */}
            {selectedTicket.status === 'resolved' && selectedTicket.satisfactionRating && (
              <div className="bg-green-50 border-t border-green-200 px-4 py-3">
                <div className="flex items-center justify-center gap-2">
                  <span className="text-sm text-green-700">Customer Satisfaction:</span>
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <Star
                        key={star}
                        size={16}
                        className={star <= selectedTicket.satisfactionRating!
                          ? 'text-yellow-500 fill-yellow-500'
                          : 'text-gray-500'
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
