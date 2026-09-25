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
} from 'lucide-react';
import {
  Modal,
  useAuthContext,
  Spinner,
  PageHeader,
  Button,
  Input,
  Select,
  Textarea,
} from '@aquaculture/shared-ui';
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
    <Modal
      isOpen
      onClose={onClose}
      size="md"
      title={
        <span className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-lg bg-success-100 dark:bg-success-900/40 flex items-center justify-center">
            <Ticket className="w-5 h-5 text-success-600 dark:text-success-400" />
          </span>
          <span>Create Support Ticket</span>
        </span>
      }
      description="Describe your issue or request"
      bodyClassName=""
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="create-ticket-form">
            Create Ticket
          </Button>
        </>
      }
    >
      <form id="create-ticket-form" onSubmit={handleSubmit} className="p-6 space-y-4">
        <Input
          label="Subject"
          fullWidth
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Brief description of your issue"
          required
        />

        <Select
          label="Category"
          fullWidth
          options={[
            { value: 'technical', label: 'Technical Issue' },
            { value: 'billing', label: 'Billing' },
            { value: 'feature_request', label: 'Feature Request' },
            { value: 'bug', label: 'Bug Report' },
            { value: 'general', label: 'General Question' },
          ]}
          value={category}
          onChange={(e) => setCategory(e.target.value as TicketCategory)}
        />

        <Textarea
          label="Description"
          className="resize-none"
          fullWidth
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Please provide as much detail as possible..."
          rows={5}
          required
        />

        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Paperclip className="w-4 h-4" />
          <Button variant="ghost" type="button">
            Attach files
          </Button>
        </div>
      </form>
    </Modal>
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
    <Modal
      isOpen
      onClose={onClose}
      size="sm"
      title="Ticket Resolved"
      description="How would you rate our support?"
      bodyClassName="p-6"
      footer={
        <>
          <Button variant="ghost" className="flex-1" type="button" onClick={onClose}>
            Skip
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            type="button"
            onClick={() => rating > 0 && onSubmit(rating)}
            disabled={rating === 0}
          >
            Submit
          </Button>
        </>
      }
    >
      <div className="w-16 h-16 rounded-full bg-success-100 dark:bg-success-900/40 flex items-center justify-center mx-auto mb-4">
        <CheckCircle className="w-8 h-8 text-success-600 dark:text-success-400" />
      </div>
      <div className="flex items-center justify-center gap-2">
        {[1, 2, 3, 4, 5].map((star) => (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Rate"
            key={star}
            onMouseEnter={() => setHoveredRating(star)}
            onMouseLeave={() => setHoveredRating(0)}
            onClick={() => setRating(star)}
          >
            <Star
              className={`w-8 h-8 ${
                star <= (hoveredRating || rating)
                  ? 'text-warning-400 fill-warning-400'
                  : 'text-gray-500 dark:text-gray-400'
              }`}
            />
          </Button>
        ))}
      </div>
    </Modal>
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
    authorType:
      c.authorType === 'tenant_admin' ? 'tenant' : (c.authorType as 'admin' | 'tenant' | 'system'),
    content: c.content,
    attachments: (c.attachments || []).map((a) => ({
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
  const selectedTicket = selectedTicketId
    ? (tickets.find((t) => t.id === selectedTicketId) ?? null)
    : null;

  // Calculate stats
  const stats: TicketStats = {
    total: tickets.length,
    open: tickets.filter((t) => t.status === 'open').length,
    inProgress: tickets.filter((t) => t.status === 'in_progress').length,
    resolved: tickets.filter((t) => t.status === 'resolved' || t.status === 'closed').length,
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
        return 'bg-error-100 dark:bg-error-900/40 text-error-700 dark:text-error-300 border-error-200 dark:border-error-800';
      case 'high':
        return 'bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300 border-accent-200 dark:border-accent-800';
      case 'medium':
        return 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300 border-warning-200 dark:border-warning-800';
      case 'low':
        return 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700';
    }
  };

  const getStatusColor = (status: TicketStatus) => {
    switch (status) {
      case 'open':
        return 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300';
      case 'in_progress':
        return 'bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300';
      case 'waiting_customer':
        return 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300';
      case 'resolved':
        return 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300';
      case 'closed':
        return 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400';
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
      const userName =
        user?.firstName && user?.lastName
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
      const userName =
        user?.firstName && user?.lastName
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
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-6 py-4">
        <PageHeader
          title="Support"
          description="Get help from our support team"
          actions={
            <Button
              variant="primary"
              leftIcon={<Plus className="w-4 h-4" />}
              onClick={() => {
                setNewTicketOpen(true);
                setActionError(null);
              }}
            >
              New Ticket
            </Button>
          }
        />
        {actionError && (
          <div className="mt-3 flex items-center gap-2 p-3 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg text-sm text-error-700 dark:text-error-300">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {actionError}
            <Button
              variant="ghost"
              iconOnly
              aria-label="Close"
              onClick={() => setActionError(null)}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4">
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
            <div className="text-sm text-gray-500 dark:text-gray-400">Total Tickets</div>
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
        </div>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-800">
          <div className="flex flex-col items-center gap-3">
            <Spinner size="lg" />
            <p className="text-gray-500 dark:text-gray-400">Loading tickets...</p>
          </div>
        </div>
      )}

      {/* Error State */}
      {error && !loading && (
        <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-800">
          <div className="text-center">
            <AlertCircle className="w-12 h-12 text-error-500 mx-auto mb-3" />
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">
              Failed to Load Tickets
            </h3>
            <p className="text-gray-500 dark:text-gray-400 mb-4">{error}</p>
          </div>
        </div>
      )}

      {/* Main Content */}
      {!loading && !error && (
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
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-success-500 focus:border-success-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <Select
                  options={[
                    { value: 'all', label: 'All Status' },
                    { value: 'open', label: 'Open' },
                    { value: 'in_progress', label: 'In Progress' },
                    { value: 'waiting_customer', label: 'Needs Response' },
                    { value: 'resolved', label: 'Resolved' },
                    { value: 'closed', label: 'Closed' },
                  ]}
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as TicketStatus | 'all')}
                />
              </div>
            </div>

            {/* Ticket List */}
            <div className="flex-1 overflow-y-auto">
              {filteredTickets.map((ticket) => (
                <div
                  key={ticket.id}
                  onClick={() => setSelectedTicketId(ticket.id)}
                  className={`p-4 border-b border-gray-100 dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 ${
                    selectedTicket?.id === ticket.id
                      ? 'bg-success-50 dark:bg-success-900/20 border-l-4 border-l-green-500'
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
                        <span
                          className={`px-2 py-0.5 text-xs rounded ${getStatusColor(ticket.status)}`}
                        >
                          {getStatusLabel(ticket.status)}
                        </span>
                        {ticket.status === 'waiting_customer' && (
                          <span className="px-2 py-0.5 text-xs rounded bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300">
                            Action Required
                          </span>
                        )}
                      </div>
                      <h3 className="font-medium text-gray-900 dark:text-gray-100 mt-1 truncate">
                        {ticket.subject}
                      </h3>
                      <div className="flex items-center gap-2 mt-1 text-sm text-gray-500 dark:text-gray-400">
                        <span>{ticket.ticketNumber}</span>
                        <span>·</span>
                        <span className="flex items-center gap-1">
                          {getCategoryIcon(ticket.category)}
                          {ticket.category.replace('_', ' ')}
                        </span>
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
                    <ChevronRight
                      size={18}
                      className="text-gray-500 dark:text-gray-400 flex-shrink-0"
                    />
                  </div>
                </div>
              ))}

              {filteredTickets.length === 0 && (
                <div className="p-8 text-center text-gray-500 dark:text-gray-400">
                  <Ticket size={48} className="mx-auto mb-3 text-gray-500 dark:text-gray-400" />
                  <p className="font-medium">No tickets found</p>
                  <p className="text-sm mt-1">Create a new ticket to get help</p>
                </div>
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
                    <div className="flex items-center gap-2 flex-wrap">
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
                      {selectedTicket.assignedToName && (
                        <>
                          <span>·</span>
                          <span>Assigned to {selectedTicket.assignedToName}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    iconOnly
                    aria-label="Close"
                    onClick={() => setSelectedTicketId(null)}
                  >
                    <X size={20} />
                  </Button>
                </div>

                {/* Tags */}
                {selectedTicket.tags.length > 0 && (
                  <div className="flex items-center gap-2 mt-3">
                    <Tag size={14} className="text-gray-500 dark:text-gray-400" />
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

                {/* Rate Resolved Ticket */}
                {selectedTicket.status === 'resolved' && !selectedTicket.satisfactionRating && (
                  <div className="mt-4 p-3 bg-success-50 dark:bg-success-900/20 rounded-lg border border-success-100 dark:border-success-800">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-5 h-5 text-success-600 dark:text-success-400" />
                        <span className="text-sm text-success-700 dark:text-success-300">
                          This ticket has been resolved
                        </span>
                      </div>
                      <button
                        onClick={() => {
                          setTicketToRate(selectedTicket);
                          setRatingModalOpen(true);
                        }}
                        className="px-3 py-1 text-sm font-medium text-success-700 dark:text-success-300 bg-success-100 dark:bg-success-900/40 rounded hover:bg-success-200 dark:hover:bg-success-800/60"
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
                        ? 'bg-info-50 dark:bg-info-900/20 border border-info-100 dark:border-info-800'
                        : 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-8 h-8 rounded-full flex items-center justify-center ${
                            comment.authorType === 'admin'
                              ? 'bg-info-200 dark:bg-info-800/50 text-info-700 dark:text-info-300'
                              : 'bg-success-200 dark:bg-success-800/50 text-success-700 dark:text-success-300'
                          }`}
                        >
                          <User size={16} />
                        </div>
                        <div>
                          <div className="font-medium text-gray-900 dark:text-gray-100 text-sm">
                            {comment.authorName}
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {comment.authorType === 'admin' ? 'Support Team' : 'You'}
                          </div>
                        </div>
                      </div>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {formatTime(comment.createdAt)}
                      </span>
                    </div>
                    <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
                      {comment.content}
                    </p>
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
                              className="flex items-center gap-2 p-2 bg-white dark:bg-gray-900 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 text-sm"
                            >
                              <FileText size={14} className="text-gray-500 dark:text-gray-400" />
                              <span className="text-gray-700 dark:text-gray-300">
                                {att.filename}
                              </span>
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
                <div className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 p-4">
                  <div className="flex items-end gap-3">
                    <Textarea
                      className="resize-none"
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      placeholder="Write a reply..."
                      rows={3}
                    />
                    <div className="flex flex-col gap-2">
                      <Button variant="ghost" iconOnly aria-label="Attach file">
                        <Paperclip size={20} />
                      </Button>
                      <Button
                        variant="primary"
                        iconOnly
                        aria-label="Send"
                        onClick={handleAddComment}
                        disabled={!newComment.trim() || addCommentMutation.isPending}
                      >
                        <Send size={20} />
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Satisfaction Rating Display */}
              {selectedTicket.satisfactionRating && (
                <div className="bg-success-50 dark:bg-success-900/20 border-t border-success-200 dark:border-success-800 px-4 py-3">
                  <div className="flex items-center justify-center gap-2">
                    <span className="text-sm text-success-700 dark:text-success-300">
                      Your rating:
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
