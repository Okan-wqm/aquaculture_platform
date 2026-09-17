/**
 * wsProjection specs — FAZ 3.2/3.3 DoD: the wire→cache projection and the
 * sender-enrichment source of truth (channels cache members, never the
 * PII-free wire payload).
 */
import type { WsMessage } from '@aquaculture/shared-ui';
import { describe, expect, it } from 'vitest';

import type { Channel } from '../../types/messaging';
import { AI_USER_ID, enrichWsSenderFromChannels, projectWsMessage } from '../wsProjection';

const CHANNEL = 'cccccccc-3333-4444-8555-666666666666';
const MEMBER_ID = 'u2';
const MY_ID = 'bbbbbbbb-2222-4333-8444-555555555555';

function makeWsMessage(overrides: Partial<WsMessage> = {}): WsMessage {
  return {
    id: 'srv-1',
    channelId: CHANNEL,
    senderId: MEMBER_ID,
    content: 'hello',
    contentType: 'TEXT',
    parentId: null,
    forwardedFrom: null,
    isDeleted: false,
    createdAt: '2026-09-16T10:00:00Z',
    editedAt: null,
    metadata: null,
    sender: { id: MEMBER_ID }, // the live path's id-only sender
    ...overrides,
  };
}

function makeChannelWithMembers(): Channel[] {
  return [
    {
      id: CHANNEL,
      type: 'DIRECT',
      name: null,
      description: null,
      avatarUrl: null,
      isArchived: false,
      aiPersona: null,
      unreadCount: 0,
      memberCount: 2,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
      lastMessage: null,
      members: [
        {
          id: 'm1',
          userId: MY_ID,
          role: 'MEMBER',
          user: { id: MY_ID, firstName: 'Panel', lastName: 'Operator', profileImageUrl: null },
        },
        {
          id: 'm2',
          userId: MEMBER_ID,
          role: 'MEMBER',
          user: { id: MEMBER_ID, firstName: 'Mehmet', lastName: 'Demir', profileImageUrl: null },
        },
      ],
    },
  ];
}

describe('enrichWsSenderFromChannels', () => {
  it('resolves the id-only wire sender from the channel members', () => {
    const enriched = enrichWsSenderFromChannels(makeChannelWithMembers(), makeWsMessage());
    expect(enriched.sender).toMatchObject({ id: MEMBER_ID, firstName: 'Mehmet', lastName: 'Demir' });
  });

  it('is a no-op when the sender already carries display fields', () => {
    const ws = makeWsMessage({ sender: { id: MEMBER_ID, firstName: 'Already', lastName: 'Known' } });
    expect(enrichWsSenderFromChannels(makeChannelWithMembers(), ws)).toBe(ws);
  });

  it('is a no-op when the member is not in the cache (message still renders)', () => {
    const ws = makeWsMessage();
    expect(enrichWsSenderFromChannels(undefined, ws)).toBe(ws);
  });
});

describe('projectWsMessage', () => {
  it('projects every cache field from the wire body', () => {
    const projected = projectWsMessage(makeWsMessage());
    expect(projected).toMatchObject({
      id: 'srv-1',
      channelId: CHANNEL,
      senderId: MEMBER_ID,
      content: 'hello',
      contentType: 'TEXT',
      isDeleted: false,
      createdAt: '2026-09-16T10:00:00Z',
      editedAt: null,
      metadata: null,
    });
  });

  it('derives isAiGenerated from the AI virtual-user senderId (wire has no flag)', () => {
    const aiMessage = projectWsMessage(makeWsMessage({ senderId: AI_USER_ID }));
    expect(aiMessage.isAiGenerated).toBe(true);
    expect(projectWsMessage(makeWsMessage()).isAiGenerated).toBe(false);
  });

  it('carries the echoed idempotencyKey so optimistic temp rows dedupe', () => {
    const projected = projectWsMessage(makeWsMessage({ idempotencyKey: 'key-1' }));
    expect(projected.idempotencyKey).toBe('key-1');
    expect(projectWsMessage(makeWsMessage()).idempotencyKey).toBeNull();
  });

  it('projects an absent sender to null, and displayName-only senders into firstName', () => {
    expect(projectWsMessage(makeWsMessage({ sender: undefined })).sender).toBeNull();
    const displayNamed = projectWsMessage(
      makeWsMessage({ sender: { id: MEMBER_ID, displayName: 'Mehmet D.' } }),
    );
    expect(displayNamed.sender?.firstName).toBe('Mehmet D.');
  });
});
