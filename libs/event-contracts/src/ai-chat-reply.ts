/**
 * The replies to `request.ai.chat` (NATS request-reply). ai-service answers;
 * the messaging AI-channel bridge and the gateway assistant socket ask.
 *
 * A request that sets `stream: true` gets `draft` frames while the reply is
 * being written, then one `result` frame. Any other request gets the
 * `result` frame alone. Draft text has passed ai-service's output safety
 * stage, so it may be shown as it arrives.
 */

/** Text that continues the reply's draft. */
export interface AiChatDraftFrame {
  type: 'draft';
  /**
   * The model turn the text belongs to. A higher turn starts the draft over:
   * a turn that called tools wrote only a preamble, and the reply is the last
   * turn that wrote text.
   */
  turn: number;
  text: string;
}

export type AiChatErrorCode = 'AI_KEY_MISSING' | 'BAD_REQUEST' | 'FORBIDDEN' | 'INTERNAL';

/** The finished reply, or why there is none. */
export interface AiChatResultFrame {
  type: 'result';
  content: string;
  conversationId: string | null;
  metadata: Record<string, unknown> | null;
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; result: unknown }>;
  /**
   * Present only on failure. BAD_REQUEST: unknown persona, persona and
   * conversation mismatch, or missing fields; FORBIDDEN: the caller may not
   * drive the persona.
   */
  error?: { code: AiChatErrorCode; message: string };
}

export type AiChatReplyFrame = AiChatDraftFrame | AiChatResultFrame;

/**
 * Draft frames are at least this far apart: the text written in between
 * travels in one frame.
 */
export const AI_CHAT_DRAFT_INTERVAL_MS = 100;

/**
 * Most draft frames one reply carries. The broker lets a responder answer
 * one request a bounded number of times (`allow_responses`,
 * scripts/nats/generate-nats-conf.py); drafts, the result and the closing
 * packet must fit, which tests/invariants/ai-chat-reply-frames.spec.ts
 * checks. Past the limit the drafts stop and the result carries the reply.
 */
export const AI_CHAT_DRAFT_FRAME_LIMIT = 900;
