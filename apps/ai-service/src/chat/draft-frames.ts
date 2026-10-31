import {
  AI_CHAT_DRAFT_FRAME_LIMIT,
  AI_CHAT_DRAFT_INTERVAL_MS,
  type AiChatDraftFrame,
} from '@aquaculture/shared-contracts';

import type { ChatDraft } from '../agent/agent-runner.service';

/**
 * Turns the runner's drafts into `request.ai.chat` draft frames. The text
 * written within AI_CHAT_DRAFT_INTERVAL_MS travels in one frame, a frame
 * never mixes two turns, and no more than AI_CHAT_DRAFT_FRAME_LIMIT frames
 * are sent: the broker bounds the replies to one request, and the result
 * frame carries the whole reply in any case.
 */
export class DraftFrames {
  private pending: ChatDraft | null = null;
  private sent = 0;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly send: (frame: AiChatDraftFrame) => void,
    private readonly now: () => number = Date.now,
  ) {}

  add(draft: ChatDraft): void {
    if (this.closed) {
      return;
    }
    if (this.pending !== null && this.pending.turn !== draft.turn) {
      this.flush();
    }
    this.pending =
      this.pending === null
        ? { turn: draft.turn, text: draft.text }
        : { turn: draft.turn, text: this.pending.text + draft.text };
    const wait = this.lastSentAt + AI_CHAT_DRAFT_INTERVAL_MS - this.now();
    if (wait <= 0) {
      this.flush();
    } else if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), wait);
    }
  }

  /** No more drafts will come: sends what is pending, then nothing more. */
  close(): void {
    this.flush();
    this.closed = true;
  }

  /** The asker went away: nothing more is sent. */
  cancel(): void {
    this.stopTimer();
    this.pending = null;
    this.closed = true;
  }

  private flush(): void {
    this.stopTimer();
    if (this.pending === null || this.closed) {
      return;
    }
    const frame = this.pending;
    this.pending = null;
    if (this.sent >= AI_CHAT_DRAFT_FRAME_LIMIT) {
      return;
    }
    this.sent++;
    this.lastSentAt = this.now();
    this.send({ type: 'draft', turn: frame.turn, text: frame.text });
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
