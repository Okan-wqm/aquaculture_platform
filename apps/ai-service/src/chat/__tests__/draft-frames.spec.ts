import {
  AI_CHAT_DRAFT_FRAME_LIMIT,
  AI_CHAT_DRAFT_INTERVAL_MS,
  type AiChatDraftFrame,
} from '@platform/event-contracts';

import { DraftFrames } from '../draft-frames';

describe('DraftFrames', () => {
  let frames: AiChatDraftFrame[];
  let drafts: DraftFrames;

  beforeEach(() => {
    jest.useFakeTimers();
    frames = [];
    drafts = new DraftFrames((frame) => frames.push(frame));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends the first text at once and gathers what follows within the interval', () => {
    drafts.add({ turn: 1, text: 'Tank ' });
    drafts.add({ turn: 1, text: '4 is ' });
    drafts.add({ turn: 1, text: 'fine.' });
    expect(frames).toEqual([{ type: 'draft', turn: 1, text: 'Tank ' }]);

    jest.advanceTimersByTime(AI_CHAT_DRAFT_INTERVAL_MS);
    expect(frames).toEqual([
      { type: 'draft', turn: 1, text: 'Tank ' },
      { type: 'draft', turn: 1, text: '4 is fine.' },
    ]);
  });

  it('never mixes two turns in one frame', () => {
    drafts.add({ turn: 1, text: 'Checking.' });
    drafts.add({ turn: 1, text: ' Still checking.' });
    drafts.add({ turn: 2, text: 'All good.' });
    drafts.close();

    expect(frames).toEqual([
      { type: 'draft', turn: 1, text: 'Checking.' },
      { type: 'draft', turn: 1, text: ' Still checking.' },
      { type: 'draft', turn: 2, text: 'All good.' },
    ]);
  });

  it('sends what is pending when closed, and nothing after', () => {
    drafts.add({ turn: 1, text: 'a' });
    drafts.add({ turn: 1, text: 'b' });
    drafts.close();
    drafts.add({ turn: 1, text: 'c' });
    jest.runOnlyPendingTimers();

    expect(frames.map((frame) => frame.text)).toEqual(['a', 'b']);
  });

  it('sends nothing more once cancelled', () => {
    drafts.add({ turn: 1, text: 'a' });
    drafts.add({ turn: 1, text: 'b' });
    drafts.cancel();
    jest.runOnlyPendingTimers();

    expect(frames.map((frame) => frame.text)).toEqual(['a']);
  });

  it(`stops at ${AI_CHAT_DRAFT_FRAME_LIMIT} frames`, () => {
    for (let i = 0; i < AI_CHAT_DRAFT_FRAME_LIMIT + 5; i++) {
      drafts.add({ turn: 1, text: 'x' });
      jest.advanceTimersByTime(AI_CHAT_DRAFT_INTERVAL_MS);
    }
    drafts.close();

    expect(frames).toHaveLength(AI_CHAT_DRAFT_FRAME_LIMIT);
  });
});
