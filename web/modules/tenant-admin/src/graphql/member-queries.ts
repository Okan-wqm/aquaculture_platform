/**
 * What the company dashboard reads for a member who is not a tenant admin.
 *
 * WHO may send it: messaging totalUnreadMessageCount admits any tenant user
 * and counts only the caller's own unread messages (message.resolver.ts
 * getTotalUnreadMessageCount). Nothing here needs an admin role.
 */
export const MEMBER_UNREAD_MESSAGES_QUERY = `
  query CompanyHomeUnreadMessages {
    totalUnreadMessageCount
  }
`;
