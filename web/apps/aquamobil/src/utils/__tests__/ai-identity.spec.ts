// FAZ 2.4 — AI identity contract tests.
//
// AI authorship is decided by SERVER-authoritative signals only:
// `isAiGenerated === true` (the backend stamp on AI-generated messages) or
// `senderId === AI_USER_ID` (the AI virtual user). User-forgeable signals —
// `metadata.isAi` and display names — must NEVER mark a message as AI.

import { describe, it, expect } from 'vitest';

import { AI_USER_ID, isAiAuthoredMessage } from '../messaging-helpers';

describe('AI_USER_ID', () => {
  it('is the backend AI virtual user id from the FAZ 2 contract', () => {
    expect(AI_USER_ID).toBe('00000000-0000-0000-0000-000000000001');
  });
});

describe('isAiAuthoredMessage', () => {
  it('accepts the server stamp (isAiGenerated === true)', () => {
    expect(isAiAuthoredMessage({ isAiGenerated: true, senderId: 'some-sender' })).toBe(true);
  });

  it('accepts the AI virtual user as sender', () => {
    expect(isAiAuthoredMessage({ isAiGenerated: false, senderId: AI_USER_ID })).toBe(true);
  });

  it('accepts legacy envelopes missing isAiGenerated when the sender is the AI user', () => {
    expect(isAiAuthoredMessage({ senderId: AI_USER_ID })).toBe(true);
  });

  it('rejects ordinary user messages', () => {
    expect(isAiAuthoredMessage({ isAiGenerated: false, senderId: 'user-77' })).toBe(false);
    expect(isAiAuthoredMessage({})).toBe(false);
  });

  it('rejects null/undefined stamps', () => {
    expect(isAiAuthoredMessage({ isAiGenerated: null, senderId: 'user-77' })).toBe(false);
    expect(isAiAuthoredMessage({ isAiGenerated: undefined, senderId: 'user-77' })).toBe(false);
  });

  it('is a display-name-independent check (the old displayName heuristic is gone)', () => {
    // A message whose SENDER HAPPENS to be named like the AI must not pass:
    // there is no name input at all — the contract is id/stamp based.
    const input = { isAiGenerated: false, senderId: 'user-77' } as const;
    expect(isAiAuthoredMessage(input)).toBe(false);
  });
});
