/**
 * GraphQL Operations for Messaging & Announcements
 *
 * Plain template-literal queries/mutations that match the auth-service
 * MessagingResolver and AnnouncementResolver exactly.
 *
 * These are consumed by the useMessaging / useAnnouncements hooks
 * which call graphqlClient.request() via the shared-ui helpers.
 */

// ============================================================================
// Messaging - Queries
// ============================================================================

/**
 * Fetch threads for the current user.
 * Resolver: MessagingResolver.mySupportThreads
 * Returns: ThreadListItem[]
 */
export const ADMIN_GET_THREADS = `
  query AdminThreads($status: SupportThreadStatus, $search: String) {
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

/**
 * Fetch messages for a thread.
 * Resolver: MessagingResolver.supportThreadMessages
 * Returns: MessageItem[]
 */
export const ADMIN_GET_THREAD_MESSAGES = `
  query AdminThreadMessages($threadId: ID!) {
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

/**
 * Fetch messaging statistics for the current user.
 * Resolver: MessagingResolver.messagingStats
 * Returns: MessagingStats
 */
export const ADMIN_GET_MESSAGING_STATS = `
  query AdminMessagingStats {
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

// ============================================================================
// Messaging - Mutations
// ============================================================================

/**
 * Create a new messaging thread.
 * Resolver: MessagingResolver.createThread
 * Returns: MessageThread
 */
export const ADMIN_CREATE_THREAD = `
  mutation AdminCreateThread($input: SupportCreateThreadInput!) {
    createSupportThread(input: $input) {
      id
      tenantId
      subject
      status
      messageCount
      createdBy
      createdByAdmin
      createdAt
      updatedAt
    }
  }
`;

/**
 * Send a message within a thread.
 * Resolver: MessagingResolver.sendSupportMessage
 * Returns: Message
 */
export const ADMIN_SEND_MESSAGE = `
  mutation AdminSendMessage($input: SupportSendMessageInput!) {
    sendSupportMessage(input: $input) {
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

/**
 * Close a thread.
 * Resolver: MessagingResolver.closeThread
 * Returns: MessageThread
 */
export const ADMIN_CLOSE_THREAD = `
  mutation AdminCloseThread($threadId: ID!) {
    closeSupportThread(threadId: $threadId) {
      id
      status
      updatedAt
    }
  }
`;

/**
 * Reopen a closed thread.
 * Resolver: MessagingResolver.reopenThread
 * Returns: MessageThread
 */
export const ADMIN_REOPEN_THREAD = `
  mutation AdminReopenThread($threadId: ID!) {
    reopenSupportThread(threadId: $threadId) {
      id
      status
      updatedAt
    }
  }
`;

/**
 * Archive a thread (SuperAdmin only).
 * Resolver: MessagingResolver.archiveThread
 * Returns: MessageThread
 */
export const ADMIN_ARCHIVE_THREAD = `
  mutation AdminArchiveThread($threadId: ID!) {
    archiveSupportThread(threadId: $threadId) {
      id
      status
      updatedAt
    }
  }
`;

/**
 * Open a support thread for every active tenant (SuperAdmin only).
 * Resolver: MessagingResolver.sendBulkSupportMessage
 * Returns: SupportBulkMessageResult { sent, failed }
 */
export const ADMIN_SEND_BULK_MESSAGE = `
  mutation AdminSendBulkMessage($input: SupportBulkMessageInput!) {
    sendBulkSupportMessage(input: $input) {
      sent
      failed
    }
  }
`;

// ============================================================================
// Announcements - Queries
// ============================================================================

/**
 * Fetch announcements for the current user.
 * Resolver: AnnouncementResolver.myAnnouncements
 * Returns: AnnouncementListItem[]
 */
export const ADMIN_GET_ANNOUNCEMENTS = `
  query AdminAnnouncements($status: AnnouncementStatus, $type: AnnouncementType) {
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

/**
 * Fetch a single announcement by ID.
 * Resolver: AnnouncementResolver.announcement
 * Returns: Announcement
 */
export const ADMIN_GET_ANNOUNCEMENT = `
  query AdminAnnouncement($id: ID!) {
    announcement(id: $id) {
      id
      title
      content
      type
      status
      scope
      tenantId
      isGlobal
      targetCriteria {
        tenantIds
        excludeTenantIds
        plans
        modules
        regions
      }
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

/**
 * Fetch announcement statistics.
 * Resolver: AnnouncementResolver.announcementStats
 * Returns: AnnouncementStats
 */
export const ADMIN_GET_ANNOUNCEMENT_STATS = `
  query AdminAnnouncementStats {
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

/**
 * Fetch acknowledgment/view records for an announcement (SuperAdmin).
 * Resolver: AnnouncementResolver.announcementAcknowledgments
 * Returns: AnnouncementAcknowledgment[]
 */
export const ADMIN_GET_ANNOUNCEMENT_ACKS = `
  query AdminAnnouncementAcknowledgments($id: ID!) {
    announcementAcknowledgments(id: $id) {
      id
      announcementId
      userId
      userName
      tenantId
      tenantName
      viewedAt
      acknowledgedAt
    }
  }
`;

// ============================================================================
// Announcements - Mutations
// ============================================================================

/**
 * Create a platform-wide announcement (SuperAdmin only).
 * Resolver: AnnouncementResolver.createPlatformAnnouncement
 * Returns: Announcement
 */
export const ADMIN_CREATE_PLATFORM_ANNOUNCEMENT = `
  mutation AdminCreatePlatformAnnouncement($input: CreatePlatformAnnouncementInput!) {
    createPlatformAnnouncement(input: $input) {
      id
      title
      content
      type
      status
      scope
      isGlobal
      targetCriteria {
        tenantIds
        excludeTenantIds
        plans
        modules
        regions
      }
      publishAt
      expiresAt
      requiresAcknowledgment
      createdBy
      createdByName
      createdAt
      updatedAt
    }
  }
`;

/**
 * Create a tenant-level announcement (TenantAdmin).
 * Resolver: AnnouncementResolver.createTenantAnnouncement
 * Returns: Announcement
 */
export const ADMIN_CREATE_TENANT_ANNOUNCEMENT = `
  mutation AdminCreateTenantAnnouncement($input: CreateTenantAnnouncementInput!) {
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
      createdBy
      createdByName
      createdAt
      updatedAt
    }
  }
`;

/**
 * Update a draft/scheduled announcement (SuperAdmin).
 * Resolver: AnnouncementResolver.updateAnnouncement
 * Returns: Announcement
 */
export const ADMIN_UPDATE_ANNOUNCEMENT = `
  mutation AdminUpdateAnnouncement($id: ID!, $input: UpdateAnnouncementInput!) {
    updateAnnouncement(id: $id, input: $input) {
      id
      title
      content
      type
      status
      scope
      isGlobal
      targetCriteria {
        tenantIds
        excludeTenantIds
        plans
        modules
        regions
      }
      publishAt
      expiresAt
      requiresAcknowledgment
      createdBy
      createdByName
      createdAt
      updatedAt
    }
  }
`;

/**
 * Publish an announcement.
 * Resolver: AnnouncementResolver.publishAnnouncement
 * Returns: Announcement
 */
export const ADMIN_PUBLISH_ANNOUNCEMENT = `
  mutation AdminPublishAnnouncement($id: ID!) {
    publishAnnouncement(id: $id) {
      id
      status
      updatedAt
    }
  }
`;

/**
 * Cancel an announcement.
 * Resolver: AnnouncementResolver.cancelAnnouncement
 * Returns: Announcement
 */
export const ADMIN_CANCEL_ANNOUNCEMENT = `
  mutation AdminCancelAnnouncement($id: ID!) {
    cancelAnnouncement(id: $id) {
      id
      status
      updatedAt
    }
  }
`;

/**
 * Delete a draft announcement.
 * Resolver: AnnouncementResolver.deleteAnnouncement
 * Returns: Boolean
 */
export const ADMIN_DELETE_ANNOUNCEMENT = `
  mutation AdminDeleteAnnouncement($id: ID!) {
    deleteAnnouncement(id: $id)
  }
`;

/**
 * Mark an announcement as viewed.
 * Resolver: AnnouncementResolver.viewAnnouncement
 * Returns: AnnouncementAcknowledgment
 */
export const ADMIN_VIEW_ANNOUNCEMENT = `
  mutation AdminViewAnnouncement($id: ID!) {
    viewAnnouncement(id: $id) {
      id
      announcementId
      userId
      userName
      tenantId
      tenantName
      viewedAt
      acknowledgedAt
    }
  }
`;

/**
 * Acknowledge an announcement.
 * Resolver: AnnouncementResolver.acknowledgeAnnouncement
 * Returns: AnnouncementAcknowledgment
 */
export const ADMIN_ACKNOWLEDGE_ANNOUNCEMENT = `
  mutation AdminAcknowledgeAnnouncement($id: ID!) {
    acknowledgeAnnouncement(id: $id) {
      id
      announcementId
      userId
      userName
      tenantId
      tenantName
      viewedAt
      acknowledgedAt
    }
  }
`;
