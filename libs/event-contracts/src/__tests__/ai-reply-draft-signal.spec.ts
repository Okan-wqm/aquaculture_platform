import {
  AI_REPLY_DRAFT_SUBSCRIPTION,
  aiReplyDraftSubject,
  isAiReplyDraftSignal,
} from '../websocket-envelopes';

const addressed = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  channelId: '22222222-2222-4222-8222-222222222222',
  replyKey: '33333333-3333-5333-8333-333333333333',
};

describe('AI reply draft signal (MSG-MEDIUM-089)', () => {
  it('addresses one tenant on a subject the bridge subscription covers', () => {
    const subject = aiReplyDraftSubject(addressed.tenantId);
    expect(subject).toBe(`live.${addressed.tenantId}.AiReplyDraft`);
    expect(
      AI_REPLY_DRAFT_SUBSCRIPTION.split('.').map((part, i) =>
        part === '*' ? '*' : subject.split('.')[i],
      ),
    ).toEqual(AI_REPLY_DRAFT_SUBSCRIPTION.split('.'));
  });

  it.each([
    ['a draft', { ...addressed, phase: 'writing', turn: 1, text: 'Tank 4 ' }],
    ['the end of a stored reply', { ...addressed, phase: 'stored' }],
    ['the end of an abandoned reply', { ...addressed, phase: 'abandoned' }],
  ])('accepts %s', (_name, signal) => {
    expect(isAiReplyDraftSignal(signal)).toBe(true);
  });

  it.each([
    ['nothing', null],
    ['a signal with no tenant', { ...addressed, tenantId: undefined, phase: 'stored' }],
    ['an unknown phase', { ...addressed, phase: 'done' }],
    ['a draft without text', { ...addressed, phase: 'writing', turn: 1 }],
    ['a draft with a fractional turn', { ...addressed, phase: 'writing', turn: 1.5, text: 'x' }],
    ['a draft whose text is not a string', { ...addressed, phase: 'writing', turn: 1, text: 42 }],
  ])('refuses %s', (_name, signal) => {
    expect(isAiReplyDraftSignal(signal)).toBe(false);
  });
});
