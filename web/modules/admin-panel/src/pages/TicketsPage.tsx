import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card } from '@aquaculture/shared-ui';
import {
  supportApi,
  type SupportTicket,
  type TicketComment,
  type TicketPriority,
  type TicketStats,
  type TicketStatus,
} from '../services/adminApi';
import type { AdminApiRouteResponse } from '../services/types/generated/admin-route-contracts';
import { adminApiErrorMessage } from '../services/http-client';
import { isAdminNavigationUrl, openAdminNavigation } from '../services/browser-capabilities';

type SupportTeamMember = AdminApiRouteResponse<'GET /support/tickets/team'>[number];

const statusVariant = (status: TicketStatus): 'success' | 'warning' | 'info' | 'default' => {
  if (status === 'resolved' || status === 'closed') return 'success';
  if (status === 'waiting_customer') return 'warning';
  if (status === 'in_progress') return 'info';
  return 'default';
};

const priorityVariant = (priority: TicketPriority): 'error' | 'warning' | 'info' | 'default' => {
  if (priority === 'critical') return 'error';
  if (priority === 'high') return 'warning';
  if (priority === 'medium') return 'info';
  return 'default';
};

const TicketsPage: React.FC = () => {
  const [tickets, setTickets] = useState<readonly SupportTicket[]>([]);
  const [stats, setStats] = useState<TicketStats | null>(null);
  const [team, setTeam] = useState<readonly SupportTeamMember[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(null);
  const [comments, setComments] = useState<readonly TicketComment[]>([]);
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [commentText, setCommentText] = useState('');
  const [internalComment, setInternalComment] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTickets = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [ticketPage, nextStats, nextTeam] = await Promise.all([
        supportApi.getTickets({
          status: statusFilter === 'all' ? undefined : statusFilter,
          search: search.trim() || undefined,
          limit: 100,
        }),
        supportApi.getTicketStats(),
        supportApi.getTicketTeam(),
      ]);
      setTickets(ticketPage.items);
      setStats(nextStats);
      setTeam(nextTeam);
    } catch (cause: unknown) {
      setTickets([]);
      setStats(null);
      setTeam([]);
      setError(adminApiErrorMessage(cause, 'Failed to load support tickets.'));
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  const selectTicket = useCallback(async (ticket: SupportTicket): Promise<void> => {
    setSelectedTicket(ticket);
    try {
      const page = await supportApi.getTicketComments(ticket.id);
      setComments(page.items);
    } catch (cause: unknown) {
      setComments([]);
      setError(adminApiErrorMessage(cause, 'Failed to load ticket comments.'));
    }
  }, []);

  const updateStatus = useCallback(
    async (status: TicketStatus): Promise<void> => {
      if (!selectedTicket) return;
      try {
        await supportApi.updateTicketStatus(selectedTicket.id, status);
        setSelectedTicket(null);
        await loadTickets();
      } catch (cause: unknown) {
        setError(adminApiErrorMessage(cause, 'Failed to update ticket status.'));
      }
    },
    [loadTickets, selectedTicket],
  );

  const assignTicket = useCallback(
    async (member: SupportTeamMember): Promise<void> => {
      if (!selectedTicket) return;
      try {
        await supportApi.assignTicket(selectedTicket.id, member.id, member.name);
        setSelectedTicket(null);
        await loadTickets();
      } catch (cause: unknown) {
        setError(adminApiErrorMessage(cause, 'Failed to assign ticket.'));
      }
    },
    [loadTickets, selectedTicket],
  );

  const addComment = useCallback(async (): Promise<void> => {
    if (!selectedTicket || !commentText.trim()) return;
    try {
      await supportApi.addTicketComment(selectedTicket.id, {
        content: commentText.trim(),
        isInternal: internalComment,
      });
      setCommentText('');
      const page = await supportApi.getTicketComments(selectedTicket.id);
      setComments(page.items);
    } catch (cause: unknown) {
      setError(adminApiErrorMessage(cause, 'Failed to add ticket comment.'));
    }
  }, [commentText, internalComment, selectedTicket]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Support Tickets</h1>
          <p className="mt-1 text-sm text-gray-500">
            Tenant support queue, SLA, and ownership state.
          </p>
        </div>
        <Button variant="secondary" disabled={loading} onClick={() => void loadTickets()}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>
      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-5">
        {[
          ['Total', stats?.total],
          ['Open', stats?.open],
          ['In progress', stats?.inProgress],
          ['Waiting', stats?.waitingCustomer],
          ['SLA breaches', stats?.slaBreachCount],
        ].map(([label, value]) => (
          <Card key={label}>
            <div className="p-4">
              <p className="text-xs text-gray-500">{label}</p>
              <p className="mt-1 text-2xl font-bold">{value ?? '—'}</p>
            </div>
          </Card>
        ))}
      </div>
      <Card>
        <div className="grid gap-3 p-4 sm:grid-cols-[1fr_14rem]">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tickets"
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <select
            value={statusFilter}
            onChange={(event) => {
              const nextStatus = event.target.value;
              if (
                nextStatus === 'all' ||
                nextStatus === 'open' ||
                nextStatus === 'in_progress' ||
                nextStatus === 'waiting_customer' ||
                nextStatus === 'resolved' ||
                nextStatus === 'closed'
              ) {
                setStatusFilter(nextStatus);
              }
            }}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="waiting_customer">Waiting customer</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
        </div>
      </Card>
      <Card>
        <div className="divide-y divide-gray-100">
          {tickets.map((ticket) => (
            <button
              key={ticket.id}
              onClick={() => void selectTicket(ticket)}
              className="grid w-full grid-cols-[1fr_auto] gap-4 p-4 text-left hover:bg-gray-50"
            >
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-gray-500">{ticket.ticketNumber}</span>
                  <Badge variant={priorityVariant(ticket.priority)}>{ticket.priority}</Badge>
                  <Badge variant={statusVariant(ticket.status)}>{ticket.status}</Badge>
                </div>
                <p className="mt-2 font-medium text-gray-900">{ticket.subject}</p>
                <p className="mt-1 text-xs text-gray-500">{ticket.tenantName ?? ticket.tenantId}</p>
              </div>
              <span className="text-xs text-gray-500">
                {new Date(ticket.updatedAt).toLocaleString()}
              </span>
            </button>
          ))}
          {!tickets.length && (
            <p className="p-6 text-center text-sm text-gray-500">No tickets found.</p>
          )}
        </div>
      </Card>
      {selectedTicket && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Card className="max-h-[90vh] w-full max-w-4xl overflow-y-auto">
            <div className="space-y-5 p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-bold">{selectedTicket.subject}</h2>
                  <p className="mt-1 text-sm text-gray-500">{selectedTicket.description}</p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => setSelectedTicket(null)}>
                  Close
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {team.map((member) => (
                  <Button
                    key={member.id}
                    size="sm"
                    variant="secondary"
                    onClick={() => void assignTicket(member)}
                  >
                    Assign {member.name} ({member.activeTickets})
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                {(['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'] as const).map(
                  (status) => (
                    <Button
                      key={status}
                      size="sm"
                      variant="secondary"
                      onClick={() => void updateStatus(status)}
                    >
                      {status}
                    </Button>
                  ),
                )}
              </div>
              <div className="space-y-3">
                {comments.map((comment) => (
                  <div key={comment.id} className="rounded border border-gray-200 p-3">
                    <div className="flex justify-between text-xs text-gray-500">
                      <span>{comment.authorName ?? comment.authorId}</span>
                      <span>{new Date(comment.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="mt-2 text-sm">{comment.content}</p>
                    {comment.attachments?.map((attachment) => (
                      <Button
                        key={attachment.id}
                        size="sm"
                        variant="secondary"
                        disabled={!isAdminNavigationUrl(attachment.url)}
                        onClick={() => openAdminNavigation(attachment.url)}
                      >
                        {attachment.fileName} ({attachment.fileSize} bytes)
                      </Button>
                    ))}
                  </div>
                ))}
              </div>
              <textarea
                value={commentText}
                onChange={(event) => setCommentText(event.target.value)}
                className="min-h-24 w-full rounded border border-gray-300 p-3 text-sm"
                placeholder="Add a comment"
              />
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={internalComment}
                    onChange={(event) => setInternalComment(event.target.checked)}
                  />
                  Internal note
                </label>
                <Button
                  variant="primary"
                  disabled={!commentText.trim()}
                  onClick={() => void addComment()}
                >
                  Add comment
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

export { TicketsPage };
export default TicketsPage;
