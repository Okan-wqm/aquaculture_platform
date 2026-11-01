/**
 * "My team" — the agents and people the caller works with, derived from `myChannels`.
 *
 * Pure (no React) so the dedupe rules are unit-tested on their own. Agents are the personas of
 * the caller's AI rooms, one per persona, opening the most recently updated room; people are the
 * other members of the caller's direct and group rooms, one per user, opening their direct room
 * when one exists. A member added to any room appears on the next channel read — no separate
 * roster query. Archived rooms are left out; members of AI rooms are not listed as people.
 */
import type { Channel, MessagingUser } from '../types/messaging';

export interface TeamAgent {
  readonly aiPersona: string | null;
  readonly channelId: string;
  /** The room's stored name — the label of a persona the panel cannot resolve. */
  readonly name: string | null;
}

export interface TeamMember {
  readonly userId: string;
  readonly user: MessagingUser | null;
  /** The caller's direct room with this person, or null (group-only contact). */
  readonly directChannelId: string | null;
}

export interface Team {
  readonly agents: readonly TeamAgent[];
  readonly members: readonly TeamMember[];
}

export function buildTeam(channels: readonly Channel[], myId: string | null | undefined): Team {
  const agents = new Map<string, { agent: TeamAgent; updatedAt: string }>();
  const members = new Map<string, TeamMember>();

  for (const channel of channels) {
    if (channel.isArchived) continue;

    if (channel.type === 'AI') {
      const personaKey = channel.aiPersona ?? '';
      const seen = agents.get(personaKey);
      if (!seen || channel.updatedAt > seen.updatedAt) {
        agents.set(personaKey, {
          agent: { aiPersona: channel.aiPersona, channelId: channel.id, name: channel.name },
          updatedAt: channel.updatedAt,
        });
      }
      continue;
    }

    // Without the caller's id their own membership cannot be told apart, so no people are
    // listed rather than the caller listed as their own teammate.
    if (!myId) continue;
    for (const m of channel.members ?? []) {
      if (m.userId === myId) continue;
      const seen = members.get(m.userId);
      const directChannelId =
        seen?.directChannelId ?? (channel.type === 'DIRECT' ? channel.id : null);
      members.set(m.userId, {
        userId: m.userId,
        user: seen?.user ?? m.user,
        directChannelId,
      });
    }
  }

  return {
    agents: [...agents.values()].map(({ agent }) => agent),
    members: [...members.values()],
  };
}
