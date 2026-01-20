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
  Loader2,
  Inbox,
} from 'lucide-react';
import { supportApi } from '../services/adminApi';

// ============================================================================
// Types
// ============================================================================

type TicketPriority = 'critical' | 'high' | 'medium' | 'low';
type TicketStatus = 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed';
type TicketCategory = 'technical' | 'billing' | 'feature_request' | 'bug' | 'general';

interface SupportTicket {
  id: string;
  ticketNumber: string;
  tenantId: string;
  tenantName: string;
  subject: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  assignedTo?: string;
  assignedToName?: string;
  reportedBy: string;
  reportedByName: string;
  commentCount: number;
  slaResponseDeadline?: string;
  slaResolutionDeadline?: string;
  firstResponseAt?: string;
  resolvedAt?: string;
  satisfactionRating?: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface TicketComment {
  id: string;
  ticketId: string;
  authorId: string;
  authorName: string;
  authorType: 'admin' | 'tenant';
  content: string;
  isInternal: boolean;
  attachments: TicketAttachment[];
  createdAt: string;
}

interface TicketAttachment {
  id: string;
  filename: string;
  url: string;
  size: number;
}

interface TicketStats {
  total: number;
  open: number;
  inProgress: number;
  resolved: number;
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
      setTickets(result.data || []);
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
      setStats(data);
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
      setComments(data || []);
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

  const filteredTickets = tickets.filter(ticket => {
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      if (!ticket.subject.toLowerCase().includes(query) &&
          !ticket.ticketNumber.toLowerCase().includes(query) &&
          !ticket.tenantName.toLowerCase().includes(query)) {
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

  const getStatusColor = (status: TicketStatus) => {
    switch (status) {
      case 'open': return 'bg-blue-100 text-blue-700';
      case 'in_progress': return 'bg-purple-100 text-purple-700';
      case 'waiting_customer': return 'bg-yellow-100 text-yellow-700';
      case 'resolved': return 'bg-green-100 text-green-700';
      case 'closed': return 'bg-gray-100 text-gray-600';
    }
  };

  const getStatusLabel = (status: TicketStatus) => {
    switch (status) {
      case 'open': return 'Open';
      case 'in_progress': return 'In Progress';
      case 'waiting_customer': return 'Waiting';
      case 'resolved': return 'Resolved';
      case 'closed': return 'Closed';
    }
  };

  const getCategoryIcon = (category: TicketCategory) => {
    switch (category) {
      case 'technical': return <AlertCircle size={14} />;
      case 'billing': return <Building2 size={14} />;
      case 'feature_request': return <Star size={14} />;
      case 'bug': return <AlertTriangle size={14} />;
      case 'general': return <MessageSquare size={14} />;
    }
  };

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

  const handleAssign = async (ticketId: string, assigneeId: string) => {
    try {
      const updated = await supportApi.assignTicket(ticketId, assigneeId);
      fetchTickets();
      if (selectedTicket?.id === ticketId) {
        setSelectedTicket(updated);
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
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Support Tickets</h1>
            <p className="text-gray-500 mt-1">Manage and resolve customer support requests</p>
          </div>
          <button
            onClick={() => { fetchTickets(); fetchStats(); }}
            className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
          >
            <RefreshCw size={18} />
          </button>
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
              <div className="text-xl font-semibold text-indigo-700">{stats.avgResponseMinutes}m</div>
            </div>
            <div className="bg-cyan-50 rounded-lg p-3">
              <div className="text-sm text-cyan-600">Avg Resolution</div>
              <div className="text-xl font-semibold text-cyan-700">{Math.round(stats.avgResolutionMinutes / 60)}h</div>
            </div>
            <div className="bg-emerald-50 rounded-lg p-3">
              <div className="text-sm text-emerald-600">SLA Compliance</div>
              <div className="text-xl font-semibold text-emerald-700">{stats.slaComplianceRate}%</div>
            </div>
            <div className="bg-amber-50 rounded-lg p-3">
              <div className="text-sm text-amber-600">Satisfaction</div>
              <div className="flex items-center gap-1">
                <Star size={16} className="text-amber-500 fill-amber-500" />
                <span className="text-xl font-semibold text-amber-700">{stats.satisfactionAvg}</span>
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
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
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
              <div className="flex flex-col items-center justify-center h-full text-red-500 p-4">
                <AlertCircle size={32} className="mb-2" />
                <p className="text-center">{error}</p>
                <button
                  onClick={fetchTickets}
                  className="mt-2 text-sm text-blue-600 hover:text-blue-700"
                >
                  Retry
                </button>
              </div>
            ) : filteredTickets.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 p-4">
                <Inbox size={48} className="mb-2 text-gray-300" />
                <p>No tickets found</p>
              </div>
            ) : (
              filteredTickets.map((ticket) => (
                <div
                  key={ticket.id}
                  onClick={() => setSelectedTicket(ticket)}
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
                      <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
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
                    <ChevronRight size={18} className="text-gray-400" />
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
                    <span>by {selectedTicket.reportedByName}</span>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedTicket(null)}
                  className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                >
                  <X size={20} />
                </button>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-3 mt-4">
                {/* Status Change */}
                <select
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
                  onChange={(e) => handleAssign(selectedTicket.id, e.target.value)}
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
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {commentsLoading ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="animate-spin text-blue-600" size={32} />
                </div>
              ) : comments.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-500">
                  <MessageSquare size={48} className="mb-2 text-gray-300" />
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
                      <span className="text-xs text-gray-400">{formatTime(comment.createdAt)}</span>
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
                            <Paperclip size={14} className="text-gray-400" />
                            <span className="text-gray-700">{att.filename}</span>
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
                    <button className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
                      <Paperclip size={20} />
                    </button>
                    <button
                      onClick={handleAddComment}
                      disabled={!newComment.trim()}
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
                          : 'text-gray-300'
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
