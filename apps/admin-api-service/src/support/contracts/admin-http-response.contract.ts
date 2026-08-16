import { adminResponse, type AdminResponseProjection } from '@platform/admin-http-contracts';

export const announcementAnnouncementContract = adminResponse.object({
  id: adminResponse.string(),
  title: adminResponse.string(),
  content: adminResponse.string(),
  type: adminResponse.union([
    adminResponse.literal('info'),
    adminResponse.literal('warning'),
    adminResponse.literal('critical'),
    adminResponse.literal('maintenance'),
  ] as const),
  status: adminResponse.union([
    adminResponse.literal('draft'),
    adminResponse.literal('expired'),
    adminResponse.literal('scheduled'),
    adminResponse.literal('published'),
    adminResponse.literal('cancelled'),
  ] as const),
  isGlobal: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  targetCriteria: adminResponse.optional(
    adminResponse.object({
      tenantIds: adminResponse.optional(adminResponse.array(adminResponse.string())),
      excludeTenantIds: adminResponse.optional(adminResponse.array(adminResponse.string())),
      plans: adminResponse.optional(adminResponse.array(adminResponse.string())),
      modules: adminResponse.optional(adminResponse.array(adminResponse.string())),
      regions: adminResponse.optional(adminResponse.array(adminResponse.string())),
    }),
  ),
  createdBy: adminResponse.optional(adminResponse.string()),
  createdByName: adminResponse.optional(adminResponse.string()),
  publishAt: adminResponse.optional(adminResponse.dateString()),
  expiresAt: adminResponse.optional(adminResponse.dateString()),
  requiresAcknowledgment: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  viewCount: adminResponse.number(),
  acknowledgmentCount: adminResponse.number(),
  metadata: adminResponse.optional(adminResponse.record(adminResponse.json('extension-metadata'))),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.optional(adminResponse.dateString()),
});

export type AnnouncementAnnouncementDto = AdminResponseProjection<
  typeof announcementAnnouncementContract
>;

export const announcementGetStatsResponseContract = adminResponse.object({
  total: adminResponse.number(),
  published: adminResponse.number(),
  scheduled: adminResponse.number(),
  draft: adminResponse.number(),
  expired: adminResponse.number(),
  totalViews: adminResponse.number(),
  totalAcknowledgments: adminResponse.number(),
  byType: adminResponse.object({
    info: adminResponse.number(),
    warning: adminResponse.number(),
    critical: adminResponse.number(),
    maintenance: adminResponse.number(),
  }),
});

export type AnnouncementGetStatsResponseDto = AdminResponseProjection<
  typeof announcementGetStatsResponseContract
>;

export const voidResponseContract = adminResponse.void();

export type VoidResponseDto = AdminResponseProjection<typeof voidResponseContract>;

export const announcementAnnouncementDtoContract = adminResponse.object({
  id: adminResponse.string(),
  title: adminResponse.string(),
  content: adminResponse.string(),
  type: adminResponse.union([
    adminResponse.literal('info'),
    adminResponse.literal('warning'),
    adminResponse.literal('critical'),
    adminResponse.literal('maintenance'),
  ] as const),
  status: adminResponse.union([
    adminResponse.literal('draft'),
    adminResponse.literal('expired'),
    adminResponse.literal('scheduled'),
    adminResponse.literal('published'),
    adminResponse.literal('cancelled'),
  ] as const),
  isGlobal: adminResponse.boolean(),
  targetCriteria: adminResponse.optional(
    adminResponse.object({
      plans: adminResponse.optional(adminResponse.array(adminResponse.string())),
      modules: adminResponse.optional(adminResponse.array(adminResponse.string())),
      regions: adminResponse.optional(adminResponse.array(adminResponse.string())),
      tenantIds: adminResponse.optional(adminResponse.array(adminResponse.string())),
      excludeTenantIds: adminResponse.optional(adminResponse.array(adminResponse.string())),
      tenantStatuses: adminResponse.optional(adminResponse.array(adminResponse.string())),
      includeInactive: adminResponse.optional(
        adminResponse.union([adminResponse.literal(false), adminResponse.literal(true)] as const),
      ),
    }),
  ),
  createdBy: adminResponse.optional(adminResponse.string()),
  createdByName: adminResponse.optional(adminResponse.string()),
  publishAt: adminResponse.optional(adminResponse.dateString()),
  expiresAt: adminResponse.optional(adminResponse.dateString()),
  requiresAcknowledgment: adminResponse.boolean(),
  viewCount: adminResponse.number(),
  acknowledgmentCount: adminResponse.number(),
  metadata: adminResponse.optional(adminResponse.record(adminResponse.json('extension-metadata'))),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type AnnouncementAnnouncementDtoDto = AdminResponseProjection<
  typeof announcementAnnouncementDtoContract
>;

export const announcementAnnouncementAcknowledgmentDtoContract = adminResponse.object({
  id: adminResponse.string(),
  announcementId: adminResponse.string(),
  tenantId: adminResponse.string(),
  userId: adminResponse.string(),
  userName: adminResponse.optional(adminResponse.string()),
  viewedAt: adminResponse.optional(adminResponse.dateString()),
  acknowledgedAt: adminResponse.optional(adminResponse.dateString()),
  createdAt: adminResponse.dateString(),
});

export type AnnouncementAnnouncementAcknowledgmentDtoDto = AdminResponseProjection<
  typeof announcementAnnouncementAcknowledgmentDtoContract
>;

export const announcementGetAcknowledgmentStatusResponseContract = adminResponse.object({
  totalViews: adminResponse.number(),
  totalAcknowledgments: adminResponse.number(),
  acknowledgments: adminResponse.array(announcementAnnouncementAcknowledgmentDtoContract),
});

export type AnnouncementGetAcknowledgmentStatusResponseDto = AdminResponseProjection<
  typeof announcementGetAcknowledgmentStatusResponseContract
>;

export const messagingThreadSummaryContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.string(),
  tenantName: adminResponse.string(),
  subject: adminResponse.string(),
  lastMessage: adminResponse.string(),
  lastMessageAt: adminResponse.dateString(),
  unreadCount: adminResponse.number(),
  messageCount: adminResponse.number(),
  isClosed: adminResponse.boolean(),
});

export type MessagingThreadSummaryDto = AdminResponseProjection<
  typeof messagingThreadSummaryContract
>;

export const messagingMessageThreadDtoContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.string(),
  subject: adminResponse.string(),
  lastMessageId: adminResponse.optional(adminResponse.string()),
  messageCount: adminResponse.number(),
  unreadAdminCount: adminResponse.number(),
  unreadTenantCount: adminResponse.number(),
  isArchived: adminResponse.boolean(),
  isClosed: adminResponse.boolean(),
  lastMessageAt: adminResponse.optional(adminResponse.dateString()),
  metadata: adminResponse.optional(adminResponse.record(adminResponse.json('extension-metadata'))),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type MessagingMessageThreadDtoDto = AdminResponseProjection<
  typeof messagingMessageThreadDtoContract
>;

export const messagingSupportMessageDtoContract = adminResponse.object({
  id: adminResponse.string(),
  threadId: adminResponse.string(),
  senderId: adminResponse.string(),
  senderType: adminResponse.union([
    adminResponse.literal('system'),
    adminResponse.literal('tenant_admin'),
    adminResponse.literal('admin'),
  ] as const),
  senderName: adminResponse.optional(adminResponse.string()),
  content: adminResponse.string(),
  status: adminResponse.union([
    adminResponse.literal('failed'),
    adminResponse.literal('sent'),
    adminResponse.literal('delivered'),
    adminResponse.literal('read'),
  ] as const),
  isInternal: adminResponse.boolean(),
  attachments: adminResponse.optional(
    adminResponse.array(
      adminResponse.object({
        id: adminResponse.string(),
        fileName: adminResponse.string(),
        fileSize: adminResponse.number(),
        mimeType: adminResponse.string(),
        url: adminResponse.string(),
        uploadedAt: adminResponse.string(),
      }),
    ),
  ),
  readAt: adminResponse.optional(adminResponse.dateString()),
  emailSent: adminResponse.boolean(),
  createdAt: adminResponse.dateString(),
});

export type MessagingSupportMessageDtoDto = AdminResponseProjection<
  typeof messagingSupportMessageDtoContract
>;

export const messagingMarkAsReadResponseContract = adminResponse.object({
  success: adminResponse.boolean(),
});

export type MessagingMarkAsReadResponseDto = AdminResponseProjection<
  typeof messagingMarkAsReadResponseContract
>;

export const messagingSendBulkMessageResponseContract = adminResponse.object({
  sent: adminResponse.number(),
  failed: adminResponse.number(),
  threadIds: adminResponse.array(adminResponse.string()),
});

export type MessagingSendBulkMessageResponseDto = AdminResponseProjection<
  typeof messagingSendBulkMessageResponseContract
>;

export const messagingGetStatsResponseContract = adminResponse.object({
  totalThreads: adminResponse.number(),
  activeThreads: adminResponse.number(),
  closedThreads: adminResponse.number(),
  totalMessages: adminResponse.number(),
  unreadMessages: adminResponse.number(),
  avgResponseTimeMinutes: adminResponse.number(),
});

export type MessagingGetStatsResponseDto = AdminResponseProjection<
  typeof messagingGetStatsResponseContract
>;

export const messagingGetUnreadCountResponseContract = adminResponse.object({
  unreadCount: adminResponse.number(),
});

export type MessagingGetUnreadCountResponseDto = AdminResponseProjection<
  typeof messagingGetUnreadCountResponseContract
>;

export const onboardingOnboardingProgressContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.string(),
  tenantName: adminResponse.optional(adminResponse.string()),
  status: adminResponse.union([
    adminResponse.literal('completed'),
    adminResponse.literal('in_progress'),
    adminResponse.literal('not_started'),
    adminResponse.literal('skipped'),
  ] as const),
  completionPercent: adminResponse.number(),
  completedSteps: adminResponse.array(adminResponse.string()),
  currentStep: adminResponse.optional(adminResponse.string()),
  welcomeEmailSent: adminResponse.boolean(),
  welcomeEmailSentAt: adminResponse.optional(adminResponse.dateString()),
  gettingStartedViewed: adminResponse.boolean(),
  viewedTutorials: adminResponse.optional(adminResponse.array(adminResponse.string())),
  scheduledTrainings: adminResponse.optional(
    adminResponse.array(
      adminResponse.object({
        id: adminResponse.string(),
        title: adminResponse.string(),
        type: adminResponse.union([
          adminResponse.literal('video_call'),
          adminResponse.literal('webinar'),
          adminResponse.literal('in_person'),
        ] as const),
        scheduledAt: adminResponse.string(),
        duration: adminResponse.number(),
        trainer: adminResponse.string(),
        status: adminResponse.union([
          adminResponse.literal('completed'),
          adminResponse.literal('scheduled'),
          adminResponse.literal('cancelled'),
        ] as const),
        meetingUrl: adminResponse.optional(adminResponse.string()),
        notes: adminResponse.optional(adminResponse.string()),
      }),
    ),
  ),
  assignedGuide: adminResponse.optional(adminResponse.string()),
  assignedGuideName: adminResponse.optional(adminResponse.string()),
  startedAt: adminResponse.optional(adminResponse.dateString()),
  completedAt: adminResponse.optional(adminResponse.dateString()),
  metadata: adminResponse.optional(adminResponse.record(adminResponse.json('extension-metadata'))),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type OnboardingOnboardingProgressDto = AdminResponseProjection<
  typeof onboardingOnboardingProgressContract
>;

export const onboardingGetStatsResponseContract = adminResponse.object({
  total: adminResponse.number(),
  notStarted: adminResponse.number(),
  inProgress: adminResponse.number(),
  completed: adminResponse.number(),
  skipped: adminResponse.number(),
  avgCompletionPercent: adminResponse.number(),
  avgCompletionDays: adminResponse.number(),
  completionByStep: adminResponse.record(adminResponse.number()),
});

export type OnboardingGetStatsResponseDto = AdminResponseProjection<
  typeof onboardingGetStatsResponseContract
>;

export const onboardingOnboardingStepContract = adminResponse.object({
  id: adminResponse.string(),
  title: adminResponse.string(),
  description: adminResponse.string(),
  order: adminResponse.number(),
  isRequired: adminResponse.boolean(),
  estimatedMinutes: adminResponse.number(),
  resourceUrl: adminResponse.optional(adminResponse.string()),
  videoUrl: adminResponse.optional(adminResponse.string()),
});

export type OnboardingOnboardingStepDto = AdminResponseProjection<
  typeof onboardingOnboardingStepContract
>;

export const onboardingSendWelcomeEmailResponseContract = adminResponse.object({
  success: adminResponse.boolean(),
  message: adminResponse.string(),
});

export type OnboardingSendWelcomeEmailResponseDto = AdminResponseProjection<
  typeof onboardingSendWelcomeEmailResponseContract
>;

export const onboardingTrainingResourceContract = adminResponse.object({
  id: adminResponse.string(),
  title: adminResponse.string(),
  description: adminResponse.string(),
  type: adminResponse.union([
    adminResponse.literal('webinar'),
    adminResponse.literal('video'),
    adminResponse.literal('document'),
    adminResponse.literal('interactive'),
  ] as const),
  url: adminResponse.string(),
  duration: adminResponse.number(),
  category: adminResponse.string(),
  order: adminResponse.number(),
});

export type OnboardingTrainingResourceDto = AdminResponseProjection<
  typeof onboardingTrainingResourceContract
>;

export const ticketSupportTicketContract = adminResponse.object({
  id: adminResponse.string(),
  ticketNumber: adminResponse.string(),
  tenantId: adminResponse.string(),
  tenantName: adminResponse.optional(adminResponse.string()),
  createdBy: adminResponse.string(),
  createdByName: adminResponse.optional(adminResponse.string()),
  createdByEmail: adminResponse.optional(adminResponse.string()),
  subject: adminResponse.string(),
  description: adminResponse.string(),
  category: adminResponse.union([
    adminResponse.literal('technical'),
    adminResponse.literal('billing'),
    adminResponse.literal('feature_request'),
    adminResponse.literal('bug_report'),
    adminResponse.literal('general'),
    adminResponse.literal('account'),
  ] as const),
  priority: adminResponse.union([
    adminResponse.literal('critical'),
    adminResponse.literal('high'),
    adminResponse.literal('medium'),
    adminResponse.literal('low'),
  ] as const),
  status: adminResponse.union([
    adminResponse.literal('in_progress'),
    adminResponse.literal('closed'),
    adminResponse.literal('open'),
    adminResponse.literal('waiting_customer'),
    adminResponse.literal('resolved'),
  ] as const),
  assignedTo: adminResponse.optional(adminResponse.string()),
  assignedToName: adminResponse.optional(adminResponse.string()),
  tags: adminResponse.optional(adminResponse.array(adminResponse.string())),
  firstResponseAt: adminResponse.optional(adminResponse.dateString()),
  resolvedAt: adminResponse.optional(adminResponse.dateString()),
  closedAt: adminResponse.optional(adminResponse.dateString()),
  dueAt: adminResponse.optional(adminResponse.dateString()),
  slaResponseMinutes: adminResponse.optional(adminResponse.number()),
  slaResolutionMinutes: adminResponse.optional(adminResponse.number()),
  slaBreached: adminResponse.optional(
    adminResponse.union([adminResponse.literal(false), adminResponse.literal(true)] as const),
  ),
  satisfactionRating: adminResponse.optional(adminResponse.number()),
  satisfactionFeedback: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  metadata: adminResponse.optional(adminResponse.record(adminResponse.json('extension-metadata'))),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type TicketSupportTicketDto = AdminResponseProjection<typeof ticketSupportTicketContract>;

export const ticketTicketStatsContract = adminResponse.object({
  total: adminResponse.number(),
  open: adminResponse.number(),
  inProgress: adminResponse.number(),
  waitingCustomer: adminResponse.number(),
  resolved: adminResponse.number(),
  closed: adminResponse.number(),
  avgFirstResponseMinutes: adminResponse.number(),
  avgResolutionMinutes: adminResponse.number(),
  slaBreachCount: adminResponse.number(),
  avgSatisfactionRating: adminResponse.number(),
});

export type TicketTicketStatsDto = AdminResponseProjection<typeof ticketTicketStatsContract>;

export const ticketGetStatsByCategoryResponseContract = adminResponse.object({
  technical: adminResponse.number(),
  billing: adminResponse.number(),
  feature_request: adminResponse.number(),
  bug_report: adminResponse.number(),
  general: adminResponse.number(),
  account: adminResponse.number(),
});

export type TicketGetStatsByCategoryResponseDto = AdminResponseProjection<
  typeof ticketGetStatsByCategoryResponseContract
>;

export const ticketGetStatsByPriorityResponseContract = adminResponse.object({
  critical: adminResponse.number(),
  high: adminResponse.number(),
  medium: adminResponse.number(),
  low: adminResponse.number(),
});

export type TicketGetStatsByPriorityResponseDto = AdminResponseProjection<
  typeof ticketGetStatsByPriorityResponseContract
>;

export const ticketGetTicketTeamResponseContract = adminResponse.object({
  id: adminResponse.string(),
  name: adminResponse.string(),
  activeTickets: adminResponse.number(),
});

export type TicketGetTicketTeamResponseDto = AdminResponseProjection<
  typeof ticketGetTicketTeamResponseContract
>;

export const ticketTicketCommentDtoContract = adminResponse.object({
  id: adminResponse.string(),
  ticketId: adminResponse.string(),
  authorId: adminResponse.string(),
  authorType: adminResponse.union([
    adminResponse.literal('system'),
    adminResponse.literal('admin'),
    adminResponse.literal('tenant_user'),
  ] as const),
  authorName: adminResponse.optional(adminResponse.string()),
  content: adminResponse.string(),
  isInternal: adminResponse.boolean(),
  attachments: adminResponse.optional(
    adminResponse.array(
      adminResponse.object({
        id: adminResponse.string(),
        fileName: adminResponse.string(),
        fileSize: adminResponse.number(),
        mimeType: adminResponse.string(),
        url: adminResponse.string(),
        uploadedAt: adminResponse.string(),
      }),
    ),
  ),
  emailSent: adminResponse.boolean(),
  createdAt: adminResponse.dateString(),
});

export type TicketTicketCommentDtoDto = AdminResponseProjection<
  typeof ticketTicketCommentDtoContract
>;

export const announcementAnnouncementPageContract = adminResponse.page(
  announcementAnnouncementContract,
);

export const announcementAnnouncementDtoArrayContract = adminResponse.array(
  announcementAnnouncementDtoContract,
);

export const messagingMessageThreadDtoArrayContract = adminResponse.array(
  messagingMessageThreadDtoContract,
);

export const messagingSupportMessageDtoArrayContract = adminResponse.array(
  messagingSupportMessageDtoContract,
);

export const messagingThreadSummaryPageContract = adminResponse.page(
  messagingThreadSummaryContract,
);

export const onboardingOnboardingProgressArrayContract = adminResponse.array(
  onboardingOnboardingProgressContract,
);

export const onboardingOnboardingProgressPageContract = adminResponse.page(
  onboardingOnboardingProgressContract,
);

export const onboardingOnboardingStepArrayContract = adminResponse.array(
  onboardingOnboardingStepContract,
);

export const onboardingTrainingResourceArrayContract = adminResponse.array(
  onboardingTrainingResourceContract,
);

export const ticketGetTicketTeamResponseArrayContract = adminResponse.array(
  ticketGetTicketTeamResponseContract,
);

export const ticketSupportTicketArrayContract = adminResponse.array(ticketSupportTicketContract);

export const ticketSupportTicketPageContract = adminResponse.page(ticketSupportTicketContract);

export const ticketTicketCommentDtoPageContract = adminResponse.page(
  ticketTicketCommentDtoContract,
);
