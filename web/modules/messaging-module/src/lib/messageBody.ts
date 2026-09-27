import type { MessageKey } from '@aquaculture/shared-ui';

import type { Message, MessageContentType } from '../types/messaging';

/**
 * Message body rendering decisions (FAZ 2.4 — AI visibility / safe content).
 *
 * Pure helpers so the page stays declarative and the branching is
 * unit-testable independently of React/i18n.
 */

/** How a message body must be rendered. */
export type MessageBodyKind = 'text' | 'image' | 'file' | 'voice';

/**
 * IMAGE/FILE/VOICE bodies are NOT rendered as text: their `content` carries a
 * media reference (URL/storage key), and echoing it would both leak the raw
 * pointer and look broken. Until FAZ 3.3 ships real renderers, the page shows
 * a localized placeholder label instead — see messageBodyLabelKey.
 */
export function messageBodyKind(contentType: MessageContentType): MessageBodyKind {
  switch (contentType) {
    case 'IMAGE':
      return 'image';
    case 'FILE':
      return 'file';
    case 'VOICE':
      return 'voice';
    default:
      return 'text';
  }
}

/** The i18n key for a non-text body placeholder. */
export function messageBodyLabelKey(kind: 'image' | 'file' | 'voice'): MessageKey {
  switch (kind) {
    case 'image':
      return 'messaging.contentImage';
    case 'file':
      return 'messaging.contentFile';
    case 'voice':
      return 'messaging.contentVoice';
  }
}

/**
 * AI failure notice detector (FAZ 2 backend contract): the bridge writes the
 * notice as contentType SYSTEM + `metadata.error === true` (+ errorCode). It
 * is NOT an AI answer and must not render as an AI-authored chat bubble.
 *
 * Defensive by design: the contentType gate means a user cannot trigger the
 * system-notice styling by forging `metadata.error` alone — the backend no
 * longer accepts user-sent SYSTEM messages, so SYSTEM+error is
 * server-originated. Never consult metadata for AI *authorship*; that is
 * `senderId`/`isAiGenerated` territory (server-authoritative only).
 */
export function isAiErrorNotice(message: Pick<Message, 'contentType' | 'metadata'>): boolean {
  return message.contentType === 'SYSTEM' && message.metadata?.['error'] === true;
}
