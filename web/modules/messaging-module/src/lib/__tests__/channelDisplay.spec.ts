import { describe, it, expect } from 'vitest';

import type { Channel } from '../../types/messaging';
import { channelTitle } from '../channelDisplay';

function makeChannel(overrides: Partial<Channel>): Channel {
  return {
    id: 'c1',
    type: 'DIRECT',
    name: null,
    description: null,
    avatarUrl: null,
    isArchived: false,
    aiPersona: null,
    unreadCount: 0,
    memberCount: 2,
    createdAt: '2026-07-06T00:00:00Z',
    updatedAt: '2026-07-06T00:00:00Z',
    lastMessage: null,
    members: null,
    ...overrides,
  };
}

describe('channelTitle', () => {
  it('uses the explicit name for group/AI channels', () => {
    expect(channelTitle(makeChannel({ type: 'GROUP', name: 'Ops Team' }))).toBe('Ops Team');
  });

  it('derives a DM title from the other members full names', () => {
    const channel = makeChannel({
      members: [
        { id: 'm1', userId: 'u1', role: 'MEMBER', user: { id: 'u1', firstName: 'Ayşe', lastName: 'Yılmaz', profileImageUrl: null } },
        { id: 'm2', userId: 'u2', role: 'MEMBER', user: { id: 'u2', firstName: 'Mehmet', lastName: 'Demir', profileImageUrl: null } },
      ],
    });
    expect(channelTitle(channel)).toBe('Ayşe Yılmaz, Mehmet Demir');
  });

  it('falls back to first name only when the last name is missing', () => {
    const channel = makeChannel({
      members: [
        { id: 'm1', userId: 'u1', role: 'MEMBER', user: { id: 'u1', firstName: 'Ada', lastName: null, profileImageUrl: null } },
      ],
    });
    expect(channelTitle(channel)).toBe('Ada');
  });

  it('labels a nameless member "Member"', () => {
    const channel = makeChannel({
      members: [
        { id: 'm1', userId: 'u1', role: 'MEMBER', user: { id: 'u1', firstName: null, lastName: null, profileImageUrl: null } },
      ],
    });
    expect(channelTitle(channel)).toBe('Member');
  });

  it('returns "Direct message" when there are no members', () => {
    expect(channelTitle(makeChannel({ members: null }))).toBe('Direct message');
    expect(channelTitle(makeChannel({ members: [] }))).toBe('Direct message');
  });
});
