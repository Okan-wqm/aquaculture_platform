/**
 * @module MentionService
 * @description Server-side @mention parsing for message content.
 * Parses @username patterns, resolves them against channel members,
 * and returns structured mention data for notification routing and
 * client-side rich rendering.
 *
 * Security: Mentions are parsed server-side only. The client sends
 * raw @username text; the server validates against actual channel
 * membership before storing mention IDs. This prevents spoofed
 * mention notifications.
 *
 * @see ADR-012 section 5.4 (Mentions & Notifications)
 */

import { Injectable, Logger } from '@nestjs/common';
import type { MentionResult, MentionableMember } from '../dto/mention.types';

/**
 * Regex to match @mention patterns in message content.
 * Matches @followed by a sequence of word characters, dots, hyphens, or spaces
 * terminated by word boundary or end of string.
 *
 * Examples: @john, @john.doe, @Jane Smith (greedy match resolved by member lookup)
 */
const MENTION_PATTERN = /@([\w][\w.\- ]*[\w]|[\w])/g;

/** Maximum number of mentions allowed per message to prevent abuse. */
const MAX_MENTIONS_PER_MESSAGE = 25;

/**
 * Sanitize a string for safe inclusion in an HTML/XML attribute.
 * Prevents XSS via attribute breakout even if userId is not a UUID.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

@Injectable()
export class MentionService {
  private readonly logger = new Logger(MentionService.name);

  /**
   * Parse @mentions from message content and resolve against channel members.
   *
   * Algorithm:
   * 1. Extract all @pattern candidates from the content
   * 2. For each candidate, find the best matching channel member
   *    (longest prefix match to handle names with spaces)
   * 3. Replace matched patterns with <mention> tags
   * 4. Return deduplicated mentioned user IDs and processed content
   *
   * @param content - Raw message content string
   * @param channelMembers - Active members of the channel with display names
   * @returns MentionResult with mentioned user IDs and tagged content
   */
  parseMentions(
    content: string,
    channelMembers: MentionableMember[],
  ): MentionResult {
    if (!content || channelMembers.length === 0) {
      return { mentionedUserIds: [], processedContent: content };
    }

    // Build a case-insensitive lookup map: lowercased display name -> member
    const memberByName = new Map<string, MentionableMember>();
    for (const member of channelMembers) {
      if (member.displayName) {
        memberByName.set(member.displayName.toLowerCase(), member);
      }
    }

    if (memberByName.size === 0) {
      return { mentionedUserIds: [], processedContent: content };
    }

    const mentionedUserIds = new Set<string>();
    let mentionCount = 0;

    // Process content: replace @patterns with <mention> tags
    const processedContent = content.replace(
      MENTION_PATTERN,
      (fullMatch: string, captured: string) => {
        if (mentionCount >= MAX_MENTIONS_PER_MESSAGE) {
          return fullMatch; // Leave as-is beyond limit
        }

        // Try exact match first, then progressively shorter prefixes
        const lowerCaptured = captured.toLowerCase();
        let matchedMember: MentionableMember | undefined;
        let matchedLength = 0;

        // Exact match
        const exact = memberByName.get(lowerCaptured);
        if (exact) {
          matchedMember = exact;
          matchedLength = captured.length;
        } else {
          // Try matching against all member names — find the longest match
          for (const [name, member] of memberByName) {
            if (lowerCaptured.startsWith(name) && name.length > matchedLength) {
              matchedMember = member;
              matchedLength = name.length;
            }
          }
        }

        if (!matchedMember) {
          return fullMatch; // No matching member — leave as-is
        }

        mentionedUserIds.add(matchedMember.userId);
        mentionCount++;

        // If we matched a shorter prefix than what was captured,
        // only wrap the matched portion
        const matchedText = captured.substring(0, matchedLength);
        const remainder = captured.substring(matchedLength);

        return `<mention userId="${escapeAttr(matchedMember.userId)}">@${escapeAttr(matchedText)}</mention>${remainder}`;
      },
    );

    const result: MentionResult = {
      mentionedUserIds: [...mentionedUserIds],
      processedContent,
    };

    if (mentionedUserIds.size > 0) {
      this.logger.debug(
        `Parsed ${mentionedUserIds.size} mention(s) from message content`,
      );
    }

    return result;
  }
}
