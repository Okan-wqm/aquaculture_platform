/**
 * GraphQL queries and mutations for communication features:
 * - Messaging (threads + messages)
 * - Support (tickets + comments)
 * - Announcements (view + acknowledge)
 *
 * Field names match backend entity @Field() decorators exactly.
 * Operation names match backend resolver method names exactly.
 */

// ===================================================================
// MESSAGING — Queries
// ===================================================================

export const MY_THREADS_QUERY = `
  query MySupportThreads($status: SupportThreadStatus, $search: String) {
    mySupportThreads(status: $status, search: $search) {
      id
      tenantId
      tenantName
      subject
      lastMessage
      lastMessageAt
      unreadCount
      messageCount
      status
      createdAt
      updatedAt
    }
  }
`;

export const THREAD_QUERY = `
  query SupportThread($id: ID!) {
    supportThread(id: $id) {
      id
      tenantId
      subject
      lastMessage
      lastMessageAt
      lastMessageBy
      status
      messageCount
      unreadCountAdmin
      unreadCountTenant
      createdBy
      createdByAdmin
      createdAt
      updatedAt
      tenantName
    }
  }
`;

export const THREAD_MESSAGES_QUERY = `
  query SupportThreadMessages($threadId: ID!) {
    supportThreadMessages(threadId: $threadId) {
      id
      threadId
      senderId
      senderType
      senderName
      content
      status
      isInternal
      attachments {
        id
        filename
        url
        size
        mimeType
      }
      readAt
      createdAt
    }
  }
`;

export const MESSAGING_STATS_QUERY = `
  query SupportMessagingStats {
    supportMessagingStats {
      totalThreads
      activeThreads
      closedThreads
      totalMessages
      unreadMessages
      avgResponseTimeMinutes
    }
  }
`;

// ===================================================================
// MESSAGING — Mutations
// ===================================================================

export const CREATE_THREAD_MUTATION = `
  mutation CreateSupportThread($input: SupportCreateThreadInput!) {
    createSupportThread(input: $input) {
      id
      tenantId
      subject
      status
      messageCount
      createdAt
      updatedAt
    }
  }
`;

export const SEND_MESSAGE_MUTATION = `
  mutation SendSupportMessage($input: SupportSendMessageInput!) {
    sendSupportMessage(input: $input) {
      id
      threadId
      senderId
      senderType
      senderName
      content
      status
      isInternal
      createdAt
    }
  }
`;

export const CLOSE_THREAD_MUTATION = `
  mutation CloseSupportThread($threadId: ID!) {
    closeSupportThread(threadId: $threadId) {
      id
      status
      updatedAt
    }
  }
`;

export const REOPEN_THREAD_MUTATION = `
  mutation ReopenSupportThread($threadId: ID!) {
    reopenSupportThread(threadId: $threadId) {
      id
      status
      updatedAt
    }
  }
`;

// ===================================================================
// SUPPORT — Queries
// ===================================================================

export const MY_TICKETS_QUERY = `
  query MyTickets($status: TicketStatus, $priority: TicketPriority, $search: String) {
    myTickets(status: $status, priority: $priority, search: $search) {
      id
      ticketNumber
      tenantId
      tenantName
      subject
      category
      priority
      status
      assignedToName
      reportedByName
      commentCount
      createdAt
      updatedAt
      isResponseSLABreached
      isResolutionSLABreached
    }
  }
`;

export const TICKET_QUERY = `
  query Ticket($id: ID!) {
    ticket(id: $id) {
      id
      ticketNumber
      tenantId
      subject
      description
      category
      priority
      status
      assignedTo
      assignedToName
      reportedBy
      reportedByName
      commentCount
      slaResponseDeadline
      slaResolutionDeadline
      firstResponseAt
      resolvedAt
      satisfactionRating
      satisfactionComment
      tags
      createdAt
      updatedAt
      tenantName
    }
  }
`;

export const TICKET_COMMENTS_QUERY = `
  query TicketComments($ticketId: ID!) {
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

export const SUPPORT_STATS_QUERY = `
  query SupportStats {
    supportStats {
      total
      open
      inProgress
      waitingCustomer
      resolved
      avgResponseMinutes
      avgResolutionMinutes
      slaComplianceRate
      satisfactionAvg
    }
  }
`;

// ===================================================================
// SUPPORT — Mutations
// ===================================================================

export const CREATE_TICKET_MUTATION = `
  mutation CreateTicket($input: CreateTicketInput!) {
    createTicket(input: $input) {
      id
      ticketNumber
      subject
      description
      category
      priority
      status
      reportedBy
      reportedByName
      createdAt
      updatedAt
    }
  }
`;

export const ADD_TICKET_COMMENT_MUTATION = `
  mutation AddTicketComment($input: AddTicketCommentInput!) {
    addTicketComment(input: $input) {
      id
      ticketId
      authorId
      authorName
      authorType
      content
      isInternal
      createdAt
    }
  }
`;

export const RATE_TICKET_MUTATION = `
  mutation RateTicket($input: RateTicketInput!) {
    rateTicket(input: $input) {
      id
      satisfactionRating
      satisfactionComment
      updatedAt
    }
  }
`;

// ===================================================================
// ANNOUNCEMENTS — Queries
// ===================================================================

export const MY_ANNOUNCEMENTS_QUERY = `
  query MyAnnouncements($status: AnnouncementStatus, $type: AnnouncementType) {
    myAnnouncements(status: $status, type: $type) {
      id
      title
      content
      type
      status
      scope
      isGlobal
      publishAt
      expiresAt
      requiresAcknowledgment
      viewCount
      acknowledgmentCount
      createdByName
      createdAt
      isActive
      hasViewed
      hasAcknowledged
    }
  }
`;

export const ANNOUNCEMENT_QUERY = `
  query Announcement($id: ID!) {
    announcement(id: $id) {
      id
      title
      content
      type
      status
      scope
      isGlobal
      tenantId
      publishAt
      expiresAt
      requiresAcknowledgment
      viewCount
      acknowledgmentCount
      createdBy
      createdByName
      createdAt
      updatedAt
    }
  }
`;

export const ANNOUNCEMENT_STATS_QUERY = `
  query AnnouncementStats {
    announcementStats {
      total
      published
      scheduled
      draft
      expired
      totalViews
      totalAcknowledgments
    }
  }
`;

// ===================================================================
// ANNOUNCEMENTS — Mutations
// ===================================================================

export const CREATE_TENANT_ANNOUNCEMENT_MUTATION = `
  mutation CreateTenantAnnouncement($input: CreateTenantAnnouncementInput!) {
    createTenantAnnouncement(input: $input) {
      id
      title
      content
      type
      status
      scope
      publishAt
      expiresAt
      requiresAcknowledgment
      createdAt
    }
  }
`;

export const PUBLISH_ANNOUNCEMENT_MUTATION = `
  mutation PublishAnnouncement($id: ID!) {
    publishAnnouncement(id: $id) {
      id
      status
      updatedAt
    }
  }
`;

export const CANCEL_ANNOUNCEMENT_MUTATION = `
  mutation CancelAnnouncement($id: ID!) {
    cancelAnnouncement(id: $id) {
      id
      status
      updatedAt
    }
  }
`;

export const DELETE_ANNOUNCEMENT_MUTATION = `
  mutation DeleteAnnouncement($id: ID!) {
    deleteAnnouncement(id: $id)
  }
`;

export const VIEW_ANNOUNCEMENT_MUTATION = `
  mutation ViewAnnouncement($id: ID!) {
    viewAnnouncement(id: $id) {
      id
      announcementId
      userId
      viewedAt
      acknowledgedAt
    }
  }
`;

export const ACKNOWLEDGE_ANNOUNCEMENT_MUTATION = `
  mutation AcknowledgeAnnouncement($id: ID!) {
    acknowledgeAnnouncement(id: $id) {
      id
      announcementId
      userId
      viewedAt
      acknowledgedAt
    }
  }
`;
