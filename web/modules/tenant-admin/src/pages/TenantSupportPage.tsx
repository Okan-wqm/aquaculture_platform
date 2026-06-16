/**
 * Tenant Support Page
 *
 * Support ticket management for TenantAdmin.
 * - View and create tickets
 * - Add comments to tickets
 * - Track ticket status and SLA
 * - Rate resolved tickets
 *
 * Note: TenantAdmin cannot:
 * - Assign tickets
 * - Change priority
 * - Add internal notes
 * - See internal notes from SuperAdmin
 */

import React, { useState } from 'react';
import {
  Ticket,
  Plus,
  Search,
  Clock,
  AlertTriangle,
  AlertCircle,
  CheckCircle,
  MessageSquare,
  Tag,
  Star,
  ChevronRight,
  X,
  Send,
  Paperclip,
  Building2,
  User,
  HelpCircle,
  FileText,
  Loader2,
} from 'lucide-react';
import { useAuthContext } from '@aquaculture/shared-ui';
import { logError, sanitizeErrorMessage } from '../utils/error-handling';
import {
  useSupportTickets,
  useTicketComments,
  useCreateTicket,
  useAddTicketComment,
  useSubmitTicketRating,
  type ApiSupportTicket,
  type ApiTicketComment,
  type ApiTicketCategory,
} from '../hooks/useTenantData';

// ============================================================================
// Types
// ============================================================================

type TicketPriority = 'critical' | 'high' | 'medium' | 'low';
type TicketStatus = 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed';
type TicketCategory = 'technical' | 'billing' | 'feature_request' | 'bug' | 'general';

interface SupportTicket {
  id: string;
  ticketNumber: string;
  subject: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
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
  authorType: 'admin' | 'tenant' | 'system';
  content: string;
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
}


// ============================================================================
// Components
// ============================================================================

/**
 * New Ticket Modal
 */
const NewTicketModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (ticket: Partial<SupportTicket>) => void;
}> = ({ isOpen, onClose, onSubmit }) => {
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<TicketCategory>('general');
  const [description, setDescription] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject.trim() || !description.trim()) return;

    onSubmit({
      subject: subject.trim(),
      category,
      description: description.trim(),
    });

    setSubject('');
    setCategory('general');
    setDescription('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative min-h-screen flex items-center justify-center p-4">
        <div className="relative w-full max-w-lg bg-white rounded-xl shadow-xl">
          <form onSubmit={handleSubmit}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-tenant-100 flex items-center justify-center">
                  <Ticket className="w-5 h-5 text-tenant-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">Create Support Ticket</h3>
                  <p className="text-sm text-gray-500">Describe your issue or request</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-2 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Subject
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Brief description of your issue"
                  className="w-full px-4 py-2 rounded-lg border border-gray-200 focus:outline-hidden focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Category
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as TicketCategory)}
                  className="w-full px-4 py-2 rounded-lg border border-gray-200 focus:outline-hidden focus:ring-2 focus:ring-tenant-500"
                >
                  <option value="technical">Technical Issue</option>
                  <option value="billing">Billing</option>
                  <option value="feature_request">Feature Request</option>
                  <option value="bug">Bug Report</option>
                  <option value="general">General Question</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Please provide as much detail as possible..."
                  rows={5}
                  className="w-full px-4 py-2 rounded-lg border border-gray-200 resize-none focus:outline-hidden focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
                  required
                />
              </div>

              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Paperclip className="w-4 h-4" />
                <button type="button" className="text-tenant-600 hover:underline">
                  Attach files
                </button>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-sm font-medium text-white bg-tenant-600 hover:bg-tenant-700 rounded-lg transition-colors"
              >
                Create Ticket
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

/**
 * Satisfaction Rating Modal
 */
const RatingModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (rating: number) => void;
  ticket: SupportTicket | null;
}> = ({ isOpen, onClose, onSubmit, ticket }) => {
  const [rating, setRating] = useState(0);
  const [hoveredRating, setHoveredRating] = useState(0);

  if (!isOpen || !ticket) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative min-h-screen flex items-center justify-center p-4">
        <div className="relative w-full max-w-sm bg-white rounded-xl shadow-xl p-6 text-center">
          <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-8 h-8 text-green-600" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            Ticket Resolved
          </h3>
          <p className="text-sm text-gray-500 mb-6">
            How would you rate our support?
          </p>
          <div className="flex items-center justify-center gap-2 mb-6">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                onMouseEnter={() => setHoveredRating(star)}
                onMouseLeave={() => setHoveredRating(0)}
                onClick={() => setRating(star)}
                className="p-1"
              >
                <Star
                  className={`w-8 h-8 ${
                    star <= (hoveredRating || rating)
                      ? 'text-yellow-400 fill-yellow-400'
                      : 'text-gray-500'
                  }`}
                />
              </button>
            ))}
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg"
            >
              Skip
            </button>
            <button
              onClick={() => rating > 0 && onSubmit(rating)}
              disabled={rating === 0}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-tenant-600 hover:bg-tenant-700 rounded-lg disabled:opacity-50"
            >
              Submit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Helper: map API ticket to local display type
// ============================================================================

function mapTicket(t: ApiSupportTicket): SupportTicket {
  return {
    id: t.id,
    ticketNumber: t.ticketNumber || `TKT-${t.id.slice(0, 8)}`,
    subject: t.subject,
    description: t.description,
    category: t.category as TicketCategory,
    priority: t.priority as TicketPriority,
    status: (t.status === 'pending_customer' ? 'waiting_customer' : t.status) as TicketStatus,
    assignedToName: t.assignedToName,
    reportedBy: t.reportedBy ?? t.createdBy ?? '',
    reportedByName: t.reportedByName ?? t.createdByName ?? '',
    commentCount: t.commentCount ?? 0,
    tags: t.tags || [],
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    resolvedAt: t.resolvedAt,
  };
}

function mapComment(c: ApiTicketComment): TicketComment {
  return {
    id: c.id,
    ticketId: c.ticketId,
    authorId: c.authorId,
    authorName: c.authorName,
    authorType: c.authorType === 'tenant_admin' ? 'tenant' : (c.authorType as 'admin' | 'tenant' | 'system'),
    content: c.content,
    attachments: (c.attachments || []).map(a => ({
      id: a.id,
      filename: a.fileName ?? a.filename ?? '',
      url: a.url,
      size: a.fileSize ?? a.size ?? 0,
    })),
    createdAt: c.createdAt,
  };
}

// ============================================================================
// Main Component
// ============================================================================

export const TenantSupportPage: React.FC = () => {
  const { user } = useAuthContext();
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'all'>('all');
  const [newComment, setNewComment] = useState('');
  const [newTicketOpen, setNewTicketOpen] = useState(false);
  const [ratingModalOpen, setRatingModalOpen] = useState(false);
  const [ticketToRate, setTicketToRate] = useState<SupportTicket | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // TanStack Query hooks
  const { data: rawTickets = [], isLoading: loading, error: ticketsError } = useSupportTickets();
  const { data: rawComments = [] } = useTicketComments(selectedTicketId);
  const createTicketMutation = useCreateTicket();
  const addCommentMutation = useAddTicketComment();
  const submitRatingMutation = useSubmitTicketRating();

  const error = ticketsError ? (ticketsError as Error).message : null;

  // Map API types to local display types
  const tickets = rawTickets.map(mapTicket);
  const comments = rawComments.map(mapComment);
  const selectedTicket = selectedTicketId ? tickets.find(t => t.id === selectedTicketId) ?? null : null;

  // Calculate stats
  const stats: TicketStats = {
    total: tickets.length,
    open: tickets.filter(t => t.status === 'open').length,
    inProgress: tickets.filter(t => t.status === 'in_progress').length,
    resolved: tickets.filter(t => t.status === 'resolved' || t.status === 'closed').length,
    avgResponseMinutes: 0,
  };

  const filteredTickets = tickets.filter((ticket) => {
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      if (
        !ticket.subject.toLowerCase().includes(query) &&
        !ticket.ticketNumber.toLowerCase().includes(query)
      ) {
        return false;
      }
    }
    if (statusFilter !== 'all' && ticket.status !== statusFilter) return false;
    return true;
  });

  const getPriorityColor = (priority: TicketPriority) => {
    switch (priority) {
      case 'critical':
        return 'bg-red-100 text-red-700 border-red-200';
      case 'high':
        return 'bg-orange-100 text-orange-700 border-orange-200';
      case 'medium':
        return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      case 'low':
        return 'bg-gray-100 text-gray-700 border-gray-200';
    }
  };

  const getStatusColor = (status: TicketStatus) => {
    switch (status) {
      case 'open':
        return 'bg-blue-100 text-blue-700';
      case 'in_progress':
        return 'bg-purple-100 text-purple-700';
      case 'waiting_customer':
        return 'bg-yellow-100 text-yellow-700';
      case 'resolved':
        return 'bg-green-100 text-green-700';
      case 'closed':
        return 'bg-gray-100 text-gray-600';
    }
  };

  const getStatusLabel = (status: TicketStatus) => {
    switch (status) {
      case 'open':
        return 'Open';
      case 'in_progress':
        return 'In Progress';
      case 'waiting_customer':
        return 'Needs Your Response';
      case 'resolved':
        return 'Resolved';
      case 'closed':
        return 'Closed';
    }
  };

  const getCategoryIcon = (category: TicketCategory) => {
    switch (category) {
      case 'technical':
        return <AlertCircle size={14} />;
      case 'billing':
        return <Building2 size={14} />;
      case 'feature_request':
        return <Star size={14} />;
      case 'bug':
        return <AlertTriangle size={14} />;
      case 'general':
        return <HelpCircle size={14} />;
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

  const handleCreateTicket = async (ticketData: Partial<SupportTicket>) => {
    try {
      const userName = user?.firstName && user?.lastName
        ? `${user.firstName} ${user.lastName}`
        : user?.email || 'Unknown User';

      await createTicketMutation.mutateAsync({
        subject: ticketData.subject || '',
        description: ticketData.description || '',
        category: (ticketData.category || 'general') as ApiTicketCategory,
        priority: 'medium',
        createdByName: userName,
        createdByEmail: user?.email,
      });

      setNewTicketOpen(false);
    } catch (err) {
      logError('TenantSupportPage.createTicket', err);
      setActionError(sanitizeErrorMessage(err));
    }
  };

  const handleAddComment = async () => {
    if (!newComment.trim() || !selectedTicketId) return;

    try {
      const userName = user?.firstName && user?.lastName
        ? `${user.firstName} ${user.lastName}`
        : user?.email || 'Unknown User';

      await addCommentMutation.mutateAsync({
        ticketId: selectedTicketId,
        content: newComment,
        authorName: userName,
      });
      setNewComment('');
    } catch (err) {
      logError('TenantSupportPage.addComment', err);
      setActionError(sanitizeErrorMessage(err));
    }
  };

  const handleRateTicket = async (rating: number) => {
    if (!ticketToRate) return;

    try {
      await submitRatingMutation.mutateAsync({ ticketId: ticketToRate.id, rating });
      setRatingModalOpen(false);
      setTicketToRate(null);
    } catch (err) {
      logError('TenantSupportPage.rateTicket', err);
      setActionError(sanitizeErrorMessage(err));
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Support</h1>
            <p className="text-gray-500 mt-1">Get help from our support team</p>
          </div>
          <button
            onClick={() => { setNewTicketOpen(true); setActionError(null); }}
            className="inline-flex items-center gap-2 px-4 py-2 bg-tenant-600 text-white rounded-lg hover:bg-tenant-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Ticket
          </button>
        </div>
        {actionError && (
          <div className="mt-3 flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {actionError}
            <button onClick={() => setActionError(null)} className="ml-auto text-red-500 hover:text-red-700">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-5 gap-3 mt-4">
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-sm text-gray-500">Total Tickets</div>
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
        </div>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="flex-1 flex items-center justify-center bg-gray-50">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 text-tenant-600 animate-spin" />
            <p className="text-gray-500">Loading tickets...</p>
          </div>
        </div>
      )}

      {/* Error State */}
      {error && !loading && (
        <div className="flex-1 flex items-center justify-center bg-gray-50">
          <div className="text-center">
            <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-3" />
            <h3 className="text-lg font-medium text-gray-900 mb-1">Failed to Load Tickets</h3>
            <p className="text-gray-500 mb-4">{error}</p>
          </div>
        </div>
      )}

      {/* Main Content */}
      {!loading && !error && (
      <div className="flex-1 flex overflow-hidden">
        {/* Ticket List */}
        <div
          className={`${selectedTicket ? 'w-1/2' : 'w-full'} flex flex-col border-r border-gray-200 bg-white`}
        >
          {/* Filters */}
          <div className="p-4 border-b border-gray-200 space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={18} />
              <input
                type="text"
                placeholder="Search tickets..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-tenant-500 focus:border-tenant-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as TicketStatus | 'all')}
                className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-tenant-500"
              >
                <option value="all">All Status</option>
                <option value="open">Open</option>
                <option value="in_progress">In Progress</option>
                <option value="waiting_customer">Needs Response</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </select>
            </div>
          </div>

          {/* Ticket List */}
          <div className="flex-1 overflow-y-auto">
            {filteredTickets.map((ticket) => (
              <div
                key={ticket.id}
                onClick={() => setSelectedTicketId(ticket.id)}
                className={`p-4 border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${
                  selectedTicket?.id === ticket.id
                    ? 'bg-tenant-50 border-l-4 border-l-tenant-500'
                    : ''
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`px-2 py-0.5 text-xs rounded border ${getPriorityColor(ticket.priority)}`}
                      >
                        {ticket.priority}
                      </span>
                      <span className={`px-2 py-0.5 text-xs rounded ${getStatusColor(ticket.status)}`}>
                        {getStatusLabel(ticket.status)}
                      </span>
                      {ticket.status === 'waiting_customer' && (
                        <span className="px-2 py-0.5 text-xs rounded bg-orange-100 text-orange-700">
                          Action Required
                        </span>
                      )}
                    </div>
                    <h3 className="font-medium text-gray-900 mt-1 truncate">{ticket.subject}</h3>
                    <div className="flex items-center gap-2 mt-1 text-sm text-gray-500">
                      <span>{ticket.ticketNumber}</span>
                      <span>·</span>
                      <span className="flex items-center gap-1">
                        {getCategoryIcon(ticket.category)}
                        {ticket.category.replace('_', ' ')}
                      </span>
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
                      <span className="flex items-center gap-1">
                        <MessageSquare size={12} />
                        {ticket.commentCount}
                      </span>
                    </div>
                  </div>
                  <ChevronRight size={18} className="text-gray-500 flex-shrink-0" />
                </div>
              </div>
            ))}

            {filteredTickets.length === 0 && (
              <div className="p-8 text-center text-gray-500">
                <Ticket size={48} className="mx-auto mb-3 text-gray-500" />
                <p className="font-medium">No tickets found</p>
                <p className="text-sm mt-1">Create a new ticket to get help</p>
              </div>
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
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`px-2 py-0.5 text-xs rounded border ${getPriorityColor(selectedTicket.priority)}`}
                    >
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
                    {selectedTicket.assignedToName && (
                      <>
                        <span>·</span>
                        <span>Assigned to {selectedTicket.assignedToName}</span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setSelectedTicketId(null)}
                  className="p-2 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                >
                  <X size={20} />
                </button>
              </div>

              {/* Tags */}
              {selectedTicket.tags.length > 0 && (
                <div className="flex items-center gap-2 mt-3">
                  <Tag size={14} className="text-gray-500" />
                  {selectedTicket.tags.map((tag) => (
                    <span key={tag} className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {/* Rate Resolved Ticket */}
              {selectedTicket.status === 'resolved' && !selectedTicket.satisfactionRating && (
                <div className="mt-4 p-3 bg-green-50 rounded-lg border border-green-100">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="w-5 h-5 text-green-600" />
                      <span className="text-sm text-green-700">This ticket has been resolved</span>
                    </div>
                    <button
                      onClick={() => {
                        setTicketToRate(selectedTicket);
                        setRatingModalOpen(true);
                      }}
                      className="px-3 py-1 text-sm font-medium text-green-700 bg-green-100 rounded hover:bg-green-200"
                    >
                      Rate Support
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Comments */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {comments.map((comment) => (
                <div
                  key={comment.id}
                  className={`rounded-lg p-4 ${
                    comment.authorType === 'admin'
                      ? 'bg-blue-50 border border-blue-100'
                      : 'bg-white border border-gray-200'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center ${
                          comment.authorType === 'admin'
                            ? 'bg-blue-200 text-blue-700'
                            : 'bg-tenant-200 text-tenant-700'
                        }`}
                      >
                        <User size={16} />
                      </div>
                      <div>
                        <div className="font-medium text-gray-900 text-sm">{comment.authorName}</div>
                        <div className="text-xs text-gray-500">
                          {comment.authorType === 'admin' ? 'Support Team' : 'You'}
                        </div>
                      </div>
                    </div>
                    <span className="text-xs text-gray-500">{formatTime(comment.createdAt)}</span>
                  </div>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{comment.content}</p>
                  {comment.attachments.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {comment.attachments.map((att) => {
                        // SEC-009: Only allow https:// URLs to prevent javascript: / data: injection
                        const safeUrl = att.url.startsWith('https://') ? att.url : null;
                        return (
                          <a
                            key={att.id}
                            href={safeUrl ?? '#'}
                            rel="noopener noreferrer"
                            target="_blank"
                            onClick={safeUrl ? undefined : (e) => e.preventDefault()}
                            className="flex items-center gap-2 p-2 bg-white rounded border border-gray-200 hover:bg-gray-50 text-sm"
                          >
                            <FileText size={14} className="text-gray-500" />
                            <span className="text-gray-700">{att.filename}</span>
                          </a>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Reply Input */}
            {selectedTicket.status !== 'closed' && selectedTicket.status !== 'resolved' && (
              <div className="bg-white border-t border-gray-200 p-4">
                <div className="flex items-end gap-3">
                  <textarea
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    placeholder="Write a reply..."
                    rows={3}
                    className="flex-1 px-4 py-3 border border-gray-300 rounded-lg resize-none focus:ring-2 focus:ring-tenant-500 focus:border-tenant-500"
                  />
                  <div className="flex flex-col gap-2">
                    <button className="p-2 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100">
                      <Paperclip size={20} />
                    </button>
                    <button
                      onClick={handleAddComment}
                      disabled={!newComment.trim() || addCommentMutation.isPending}
                      className="p-3 bg-tenant-600 text-white rounded-lg hover:bg-tenant-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Send size={20} />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Satisfaction Rating Display */}
            {selectedTicket.satisfactionRating && (
              <div className="bg-green-50 border-t border-green-200 px-4 py-3">
                <div className="flex items-center justify-center gap-2">
                  <span className="text-sm text-green-700">Your rating:</span>
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <Star
                        key={star}
                        size={16}
                        className={
                          star <= selectedTicket.satisfactionRating!
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
      )}

      {/* Modals */}
      <NewTicketModal
        isOpen={newTicketOpen}
        onClose={() => setNewTicketOpen(false)}
        onSubmit={handleCreateTicket}
      />
      <RatingModal
        isOpen={ratingModalOpen}
        onClose={() => setRatingModalOpen(false)}
        onSubmit={handleRateTicket}
        ticket={ticketToRate}
      />
    </div>
  );
};

export default TenantSupportPage;
