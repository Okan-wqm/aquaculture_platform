/**
 * The AI replies a channel is watching being written (MSG-MEDIUM-089).
 *
 * A draft lives from its first `aiReplyDraft` frame until the stored reply
 * arrives as a `newMessage` whose idempotencyKey is the draft's replyKey,
 * or until the server says no reply is coming. Frames and messages travel
 * on different paths, so either can arrive first; a draft that is never
 * resolved is dropped once it goes quiet.
 */
import type { AiReplyDraftEnvelope } from '@aquaculture/shared-ui';

export interface AiReplyDraft {
  replyKey: string;
  /** The model turn the text belongs to. */
  turn: number;
  text: string;
  /** The reply is stored; its message is on the way. */
  stored: boolean;
  /** When the last frame for it arrived (ms). */
  touchedAt: number;
}

/** A draft still being written that sends nothing for this long is dropped. */
export const AI_DRAFT_IDLE_MS = 60_000;
/** A stored draft whose message has not arrived after this long is dropped. */
export const AI_DRAFT_STORED_GRACE_MS = 15_000;

/** The drafts after one frame. */
export function applyAiReplyDraft(
  drafts: readonly AiReplyDraft[],
  envelope: AiReplyDraftEnvelope,
  now: number,
): AiReplyDraft[] {
  const current = drafts.find((draft) => draft.replyKey === envelope.replyKey);
  if (envelope.phase !== 'writing') {
    if (envelope.phase === 'abandoned') {
      return drafts.filter((draft) => draft.replyKey !== envelope.replyKey);
    }
    return current
      ? drafts.map((draft) =>
          draft === current ? { ...draft, stored: true, touchedAt: now } : draft,
        )
      : [...drafts];
  }
  if (!current) {
    return [
      ...drafts,
      {
        replyKey: envelope.replyKey,
        turn: envelope.turn,
        text: envelope.text,
        stored: false,
        touchedAt: now,
      },
    ];
  }
  // A later turn starts the draft over; a frame of an earlier turn is late and changes nothing.
  if (envelope.turn < current.turn) {
    return [...drafts];
  }
  const text = envelope.turn > current.turn ? envelope.text : current.text + envelope.text;
  return drafts.map((draft) =>
    draft === current ? { ...draft, turn: envelope.turn, text, touchedAt: now } : draft,
  );
}

/** The drafts once a message arrives: the one it replaces is gone. */
export function dropRepliedDraft(
  drafts: readonly AiReplyDraft[],
  idempotencyKey: string | null | undefined,
): AiReplyDraft[] {
  return idempotencyKey ? drafts.filter((draft) => draft.replyKey !== idempotencyKey) : [...drafts];
}

/** The drafts still worth showing at `now`. */
export function dropStaleDrafts(drafts: readonly AiReplyDraft[], now: number): AiReplyDraft[] {
  return drafts.filter(
    (draft) => now - draft.touchedAt < (draft.stored ? AI_DRAFT_STORED_GRACE_MS : AI_DRAFT_IDLE_MS),
  );
}
