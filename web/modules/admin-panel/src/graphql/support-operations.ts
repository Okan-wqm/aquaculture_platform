/**
 * GraphQL Operations for Support Tickets
 *
 * Plain template-literal queries/mutations that match the auth-service
 * SupportResolver exactly (APA-213: support tickets consolidated onto the
 * auth.support_tickets / auth.ticket_comments SSoT).
 *
 * These are consumed by the useTickets hooks which call the shared-ui
 * useGraphQLQuery / useGraphQLMutation helpers.
 */

// ============================================================================
// Queries
// ============================================================================

/**
 * Fetch all tickets visible to the current user.
 * Resolver: SupportResolver.myTickets (SUPER_ADMIN sees every tenant's tickets).
 * Returns: TicketListItem[]
 */
export const ADMIN_GET_TICKETS = `
  query AdminTickets {
    myTickets {
      id
      ticketNumber
      tenantName
      subject
      category
      priority
      status
      assignedTo
      assignedToName
      reportedByName
      commentCount
      slaResponseDeadline
      slaResolutionDeadline
      firstResponseAt
      tags
      satisfactionRating
      createdAt
    }
  }
`;

/**
 * Fetch support statistics.
 * Resolver: SupportResolver.supportStats
 * Returns: SupportStats
 */
export const ADMIN_GET_TICKET_STATS = `
  query AdminTicketStats {
    supportStats {
      total
      open
      inProgress
      resolved
      avgResponseMinutes
      avgResolutionMinutes
      slaComplianceRate
      satisfactionAvg
    }
  }
`;

/**
 * Fetch the support team with active-ticket counts (SuperAdmin).
 * Resolver: SupportResolver.ticketTeam
 * Returns: TicketTeamMember[]
 */
export const ADMIN_GET_TICKET_TEAM = `
  query AdminTicketTeam {
    ticketTeam {
      id
      name
      activeTickets
    }
  }
`;

/**
 * Fetch comments for a ticket.
 * Resolver: SupportResolver.ticketComments
 * Returns: CommentItem[]
 */
export const ADMIN_GET_TICKET_COMMENTS = `
  query AdminTicketComments($ticketId: ID!) {
    ticketComments(ticketId: $ticketId) {
      id
      ticketId
      authorId
      authorName
      authorType
      content
      isInternal
      attachments {
        id
        filename
        url
        size
      }
      createdAt
    }
  }
`;

// ============================================================================
// Mutations
// ============================================================================

/**
 * Assign a ticket to an admin (SuperAdmin only).
 * Resolver: SupportResolver.assignTicket
 * Returns: SupportTicket
 */
export const ADMIN_ASSIGN_TICKET = `
  mutation AdminAssignTicket($input: AssignTicketInput!) {
    assignTicket(input: $input) {
      id
    }
  }
`;

/**
 * Update a ticket's status (SuperAdmin only).
 * Resolver: SupportResolver.updateTicketStatus
 * Returns: SupportTicket
 */
export const ADMIN_UPDATE_TICKET_STATUS = `
  mutation AdminUpdateTicketStatus($input: UpdateTicketStatusInput!) {
    updateTicketStatus(input: $input) {
      id
    }
  }
`;

/**
 * Update a ticket's priority (SuperAdmin only). Recomputes SLA deadlines.
 * Resolver: SupportResolver.updateTicketPriority
 * Returns: SupportTicket
 */
export const ADMIN_UPDATE_TICKET_PRIORITY = `
  mutation AdminUpdateTicketPriority($input: UpdateTicketPriorityInput!) {
    updateTicketPriority(input: $input) {
      id
    }
  }
`;

/**
 * Add a comment to a ticket.
 * Resolver: SupportResolver.addTicketComment
 * Returns: TicketComment
 */
export const ADMIN_ADD_TICKET_COMMENT = `
  mutation AdminAddTicketComment($input: AddTicketCommentInput!) {
    addTicketComment(input: $input) {
      id
    }
  }
`;
