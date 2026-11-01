import { describe, expect, it } from 'vitest';

import type { Channel, ChannelMember, MessagingUser } from '../../types/messaging';
import { buildTeam } from '../team';

const ME = 'me';

function user(id: string, firstName: string): MessagingUser {
  return { id, firstName, lastName: null, profileImageUrl: null };
}

function member(id: string, firstName: string): ChannelMember {
  return { id: `m-${id}`, userId: id, role: 'MEMBER', user: user(id, firstName) };
}

function channel(overrides: Partial<Channel> & Pick<Channel, 'id' | 'type'>): Channel {
  return {
    name: null,
    description: null,
    avatarUrl: null,
    isArchived: false,
    aiPersona: null,
    unreadCount: 0,
    memberCount: 0,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    lastMessage: null,
    members: [],
    ...overrides,
  };
}

describe('buildTeam', () => {
  it('lists each AI persona once, opening its most recently updated room', () => {
    const team = buildTeam(
      [
        channel({
          id: 'old',
          type: 'AI',
          aiPersona: 'expert-farm-production-v1',
          updatedAt: '2026-10-01T00:00:00Z',
        }),
        channel({
          id: 'new',
          type: 'AI',
          name: 'Production Specialist (Expert)',
          aiPersona: 'expert-farm-production-v1',
          updatedAt: '2026-10-05T00:00:00Z',
        }),
        channel({ id: 'default', type: 'AI', aiPersona: null }),
      ],
      ME,
    );

    expect(team.agents).toEqual([
      {
        aiPersona: 'expert-farm-production-v1',
        channelId: 'new',
        name: 'Production Specialist (Expert)',
      },
      { aiPersona: null, channelId: 'default', name: null },
    ]);
    expect(team.members).toEqual([]);
  });

  it('lists each human once, never the caller, and links a member to their direct room', () => {
    const team = buildTeam(
      [
        channel({
          id: 'group',
          type: 'GROUP',
          members: [member(ME, 'Okan'), member('u2', 'Mehmet'), member('u3', 'Ayse')],
        }),
        channel({
          id: 'dm',
          type: 'DIRECT',
          members: [member(ME, 'Okan'), member('u2', 'Mehmet')],
        }),
      ],
      ME,
    );

    expect(team.members.map((m) => [m.userId, m.directChannelId])).toEqual([
      ['u2', 'dm'],
      ['u3', null],
    ]);
    expect(team.members[0]?.user?.firstName).toBe('Mehmet');
  });

  it('ignores archived rooms and keeps members of an AI room out of the human list', () => {
    const team = buildTeam(
      [
        channel({
          id: 'gone',
          type: 'GROUP',
          isArchived: true,
          members: [member(ME, 'Okan'), member('u9', 'Gone')],
        }),
        channel({
          id: 'ai',
          type: 'AI',
          aiPersona: 'operator-v1',
          members: [member(ME, 'Okan'), member('u8', 'Bridge')],
        }),
      ],
      ME,
    );

    expect(team.members).toEqual([]);
    expect(team.agents).toHaveLength(1);
  });

  it('lists no people while the caller is unknown, rather than the caller as a teammate', () => {
    const rooms = [
      channel({ id: 'dm', type: 'DIRECT', members: [member(ME, 'Okan'), member('u2', 'Mehmet')] }),
      channel({ id: 'ai', type: 'AI', aiPersona: 'operator-v1' }),
    ];
    for (const unknownCaller of [null, undefined, '']) {
      const team = buildTeam(rooms, unknownCaller);
      expect(team.members).toEqual([]);
      expect(team.agents).toHaveLength(1);
    }
  });

  it('is empty before any channel loads', () => {
    expect(buildTeam([], ME)).toEqual({ agents: [], members: [] });
  });
});
