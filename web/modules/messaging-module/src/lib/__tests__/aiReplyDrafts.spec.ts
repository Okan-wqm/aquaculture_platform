import { describe, expect, it } from 'vitest';

import {
  AI_DRAFT_IDLE_MS,
  AI_DRAFT_STORED_GRACE_MS,
  applyAiReplyDraft,
  dropRepliedDraft,
  dropStaleDrafts,
  type AiReplyDraft,
} from '../aiReplyDrafts';

const KEY = 'reply-1';
const writing = (turn: number, text: string) =>
  ({ channelId: 'c1', replyKey: KEY, phase: 'writing', turn, text }) as const;

function run(...frames: Parameters<typeof applyAiReplyDraft>[1][]): AiReplyDraft[] {
  return frames.reduce<AiReplyDraft[]>((drafts, frame) => applyAiReplyDraft(drafts, frame, 0), []);
}

describe('AI reply drafts', () => {
  it('appends the text of one turn', () => {
    expect(run(writing(1, 'Tank 4 '), writing(1, 'is fine.'))).toEqual([
      { replyKey: KEY, turn: 1, text: 'Tank 4 is fine.', stored: false, touchedAt: 0 },
    ]);
  });

  it('starts over when a later turn writes, and ignores a late frame of an earlier one', () => {
    const [draft] = run(
      writing(1, 'Checking.'),
      writing(2, 'All '),
      writing(1, ' late'),
      writing(2, 'good.'),
    );
    expect(draft).toMatchObject({ turn: 2, text: 'All good.' });
  });

  it('keeps a stored draft until its message arrives, then drops it', () => {
    const stored = run(writing(1, 'Done.'), { channelId: 'c1', replyKey: KEY, phase: 'stored' });
    expect(stored).toMatchObject([{ text: 'Done.', stored: true }]);
    expect(dropRepliedDraft(stored, 'another-message')).toHaveLength(1);
    expect(dropRepliedDraft(stored, KEY)).toEqual([]);
  });

  it('drops a draft whose reply is abandoned', () => {
    expect(run(writing(1, 'Hm'), { channelId: 'c1', replyKey: KEY, phase: 'abandoned' })).toEqual(
      [],
    );
  });

  it('ignores the end of a draft it never saw (the message came first)', () => {
    expect(run({ channelId: 'c1', replyKey: KEY, phase: 'stored' })).toEqual([]);
  });

  it('drops drafts that went quiet: soon once stored, later while writing', () => {
    const writingDraft = { replyKey: 'a', turn: 1, text: 'x', stored: false, touchedAt: 0 };
    const storedDraft = { replyKey: 'b', turn: 1, text: 'y', stored: true, touchedAt: 0 };
    expect(dropStaleDrafts([writingDraft, storedDraft], AI_DRAFT_STORED_GRACE_MS)).toEqual([
      writingDraft,
    ]);
    expect(dropStaleDrafts([writingDraft], AI_DRAFT_IDLE_MS)).toEqual([]);
  });
});
