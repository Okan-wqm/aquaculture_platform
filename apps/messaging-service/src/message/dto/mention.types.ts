/**
 * @module mention.types
 * @description Type definitions for the @mention parsing system.
 * Used by MentionService to return structured mention data
 * from user-submitted message content.
 * @see ADR-012 section 5.4 (Mentions & Notifications)
 */

/**
 * Result of parsing @mentions from message content.
 *
 * mentionedUserIds: deduplicated list of user UUIDs that were mentioned.
 * processedContent: the original content with @username patterns wrapped
 * in <mention> tags for client-side rich rendering.
 */
export interface MentionResult {
  /** Deduplicated list of mentioned user UUIDs. */
  mentionedUserIds: string[];
  /** Content with @mentions wrapped in <mention userId="...">@name</mention> tags. */
  processedContent: string;
}

/**
 * Minimal channel member shape required by MentionService for matching.
 * Avoids coupling to the full ChannelMember entity.
 */
export interface MentionableMember {
  userId: string;
  displayName: string;
}
