/**
 * Support Ticket Hooks
 *
 * React hooks for support-ticket operations.
 * Communicates with auth-service via the Apollo Federation gateway using the
 * shared-ui graphqlClient and useGraphQL hooks.
 *
 * Replaces the old REST-based hooks that called supportApi (APA-213: support
 * tickets consolidated onto the auth.support_tickets / auth.ticket_comments SSoT).
 */

import { useGraphQLQuery, useGraphQLMutation } from '@aquaculture/shared-ui';

import {
  ADMIN_GET_TICKETS,
  ADMIN_GET_TICKET_STATS,
  ADMIN_GET_TICKET_TEAM,
  ADMIN_GET_TICKET_COMMENTS,
  ADMIN_ASSIGN_TICKET,
  ADMIN_UPDATE_TICKET_STATUS,
  ADMIN_UPDATE_TICKET_PRIORITY,
  ADMIN_ADD_TICKET_COMMENT,
} from '../graphql/support-operations';

// ============================================================================
// Enum unions — match the auth-service enum VALUES over the wire (lowercase).
// ============================================================================

export type TicketStatus =
  | 'open'
  | 'in_progress'
  | 'waiting_customer'
  | 'resolved'
  | 'closed';
export type TicketPriority = 'critical' | 'high' | 'medium' | 'low';
export type TicketCategory =
  | 'technical'
  | 'billing'
  | 'feature_request'
  | 'bug'
  | 'general';
export type TicketCommentAuthorType = 'super_admin' | 'tenant_admin' | 'system';

// ============================================================================
// GraphQL response types
// ============================================================================

/** Comment attachment as exposed by the auth CommentItem/TicketAttachment. */
export interface GqlTicketAttachment {
  id: string;
  filename: string;
  url: string;
  size: number;
}

/** Ticket list item from the myTickets query (list + detail surface). */
export interface GqlTicket {
  id: string;
  ticketNumber: string;
  tenantName: string | null;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  assignedTo: string | null;
  assignedToName: string | null;
  reportedByName: string;
  commentCount: number;
  slaResponseDeadline: string | null;
  slaResolutionDeadline: string | null;
  firstResponseAt: string | null;
  tags: string[] | null;
  satisfactionRating: number | null;
  createdAt: string;
}

/** Comment from the ticketComments query. */
export interface GqlTicketComment {
  id: string;
  ticketId: string;
  authorId: string;
  authorName: string;
  authorType: TicketCommentAuthorType;
  content: string;
  isInternal: boolean;
  attachments: GqlTicketAttachment[] | null;
  createdAt: string;
}

/** Support statistics from the supportStats query. */
export interface TicketStats {
  total: number;
  open: number;
  inProgress: number;
  resolved: number;
  avgResponseMinutes: number;
  avgResolutionMinutes: number;
  slaComplianceRate: number;
  satisfactionAvg: number;
}

/** Support team member from the ticketTeam query. */
export interface TicketTeamMember {
  id: string;
  name: string;
  activeTickets: number;
}

// ============================================================================
// Mutation input types (match the auth-service GraphQL input DTOs)
// ============================================================================

export interface AssignTicketInput {
  ticketId: string;
  assigneeId: string;
}

export interface UpdateTicketStatusInput {
  ticketId: string;
  status: TicketStatus;
}

export interface UpdateTicketPriorityInput {
  ticketId: string;
  priority: TicketPriority;
}

export interface AddTicketCommentInput {
  ticketId: string;
  content: string;
  isInternal: boolean;
}

// ============================================================================
// Query Hooks
// ============================================================================

/**
 * Fetch every ticket visible to the current user. For a SUPER_ADMIN this is the
 * platform-wide support queue; status/priority/category/search filtering is
 * applied client-side by the consuming page.
 */
export function useTickets(): {
  data: GqlTicket[] | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const result = useGraphQLQuery<{ myTickets: GqlTicket[] }>(
    'AdminTickets',
    ADMIN_GET_TICKETS,
    { enabled: true },
  );

  return {
    data: result.data?.myTickets ?? null,
    isLoading: result.isLoading,
    error: result.error ? result.error.message || 'Failed to load tickets' : null,
    refetch: result.refetch,
  };
}

/**
 * Fetch support statistics.
 */
export function useTicketStats(): {
  data: TicketStats | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const result = useGraphQLQuery<{ supportStats: TicketStats }>(
    'AdminTicketStats',
    ADMIN_GET_TICKET_STATS,
    { enabled: true },
  );

  return {
    data: result.data?.supportStats ?? null,
    isLoading: result.isLoading,
    error: result.error ? result.error.message || 'Failed to load stats' : null,
    refetch: result.refetch,
  };
}

/**
 * Fetch the support team (assignees with active-ticket counts).
 */
export function useTicketTeam(): {
  data: TicketTeamMember[] | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const result = useGraphQLQuery<{ ticketTeam: TicketTeamMember[] }>(
    'AdminTicketTeam',
    ADMIN_GET_TICKET_TEAM,
    { enabled: true },
  );

  return {
    data: result.data?.ticketTeam ?? null,
    isLoading: result.isLoading,
    error: result.error ? result.error.message || 'Failed to load support team' : null,
    refetch: result.refetch,
  };
}

/**
 * Fetch comments for a ticket (skips until a ticket is selected).
 */
export function useTicketComments(ticketId: string | null): {
  data: GqlTicketComment[] | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const result = useGraphQLQuery<
    { ticketComments: GqlTicketComment[] },
    { ticketId: string }
  >('AdminTicketComments', ADMIN_GET_TICKET_COMMENTS, {
    variables: { ticketId: ticketId ?? '' },
    enabled: !!ticketId,
  });

  return {
    data: result.data?.ticketComments ?? null,
    isLoading: result.isLoading,
    error: result.error ? result.error.message || 'Failed to load comments' : null,
    refetch: result.refetch,
  };
}

// ============================================================================
// Mutation Hooks
// ============================================================================

/**
 * Assign a ticket to a support-team member (SuperAdmin).
 */
export function useAssignTicket(): {
  mutate: (params: { input: AssignTicketInput }) => Promise<unknown>;
  isLoading: boolean;
  error: string | null;
} {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { assignTicket: { id: string } },
    { input: AssignTicketInput }
  >(ADMIN_ASSIGN_TICKET);

  return {
    mutate: (params: { input: AssignTicketInput }) => mutate(params),
    isLoading,
    error: error ? error.message || 'Failed to assign ticket' : null,
  };
}

/**
 * Change a ticket's status (SuperAdmin).
 */
export function useUpdateTicketStatus(): {
  mutate: (params: { input: UpdateTicketStatusInput }) => Promise<unknown>;
  isLoading: boolean;
  error: string | null;
} {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { updateTicketStatus: { id: string } },
    { input: UpdateTicketStatusInput }
  >(ADMIN_UPDATE_TICKET_STATUS);

  return {
    mutate: (params: { input: UpdateTicketStatusInput }) => mutate(params),
    isLoading,
    error: error ? error.message || 'Failed to update status' : null,
  };
}

/**
 * Change a ticket's priority (SuperAdmin). Recomputes SLA deadlines server-side.
 */
export function useUpdateTicketPriority(): {
  mutate: (params: { input: UpdateTicketPriorityInput }) => Promise<unknown>;
  isLoading: boolean;
  error: string | null;
} {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { updateTicketPriority: { id: string } },
    { input: UpdateTicketPriorityInput }
  >(ADMIN_UPDATE_TICKET_PRIORITY);

  return {
    mutate: (params: { input: UpdateTicketPriorityInput }) => mutate(params),
    isLoading,
    error: error ? error.message || 'Failed to update priority' : null,
  };
}

/**
 * Add a comment (public reply or internal note) to a ticket.
 */
export function useAddTicketComment(): {
  mutate: (params: { input: AddTicketCommentInput }) => Promise<unknown>;
  isLoading: boolean;
  error: string | null;
} {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { addTicketComment: { id: string } },
    { input: AddTicketCommentInput }
  >(ADMIN_ADD_TICKET_COMMENT);

  return {
    mutate: (params: { input: AddTicketCommentInput }) => mutate(params),
    isLoading,
    error: error ? error.message || 'Failed to add comment' : null,
  };
}
