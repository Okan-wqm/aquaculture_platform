import { useAuth, useI18n, type MessageKey } from '@aquaculture/shared-ui';
import { ArrowLeft, Send, Sparkles, RefreshCw, AlertCircle } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

import {
  useChannelMessages,
  useSendMessage,
  useChannels,
  useMarkMessagesRead,
} from '../hooks/useMessagingData';
import { useMessagingSocket } from '../hooks/useMessagingSocket';
import { aiPersonaDisplayName } from '../lib/aiPersona';
import { channelTitle } from '../lib/channelDisplay';
import { isAiErrorNotice, messageBodyKind, messageBodyLabelKey } from '../lib/messageBody';
import { computeIdempotencyKey } from '../lib/messageIdempotency';
import { sendErrorBannerKey } from '../lib/sendErrorMessages';
import type { Message } from '../types/messaging';

/** The send-error banner self-dismisses after a few seconds… */
const ERROR_BANNER_TIMEOUT_MS = 6000;

function isDocumentVisible(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible';
}

function senderName(m: Message, fallback: string): string {
  const u = m.sender;
  return [u?.firstName, u?.lastName].filter(Boolean).join(' ') || fallback;
}

/**
 * Chat room — SUDERRA Tenant Console design (mockup "Messages" right card):
 * mint-gradient own bubbles, violet-tinted AI bubbles, author lines, mint
 * focus rings, teal send button, Enter-to-send / Shift+Enter newline.
 *
 * DATA SOURCE: 100% real — messaging-service `messages` query,
 * `sendMessage` + `markMessagesRead` mutations, and Socket.IO live updates.
 * `isAiGenerated` is a real message field, so AI bubble styling keys on real
 * data. No mocked data on this page.
 *
 * FAZ 1: sends are idempotent (key computed per logical send, memoised in
 * sessionStorage) + optimistic (temp row, rollback on error, id-dedupe on
 * success); failures surface in a role="alert" banner and the draft is
 * restored; opening/reading the channel marks it read only while the tab is
 * VISIBLE (the wrong-read gate), optimistically zeroing the unread badge.
 *
 * FAZ 2.4 (AI visibility): AI messages credit the channel's aiPersona (not a
 * hard-coded 'AI Assistant'); SYSTEM+metadata.error notices render as neutral
 * system lines instead of AI bubbles; IMAGE/FILE/VOICE bodies render localized
 * placeholder labels instead of their raw media-reference content.
 */
const ChatRoomPage: React.FC = () => {
  const { channelId } = useParams<{ channelId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const myId = user?.id;
  const { t } = useI18n();

  const { data: messages, isLoading } = useChannelMessages(channelId);
  const { data: channels } = useChannels();
  const sendMutation = useSendMessage(channelId);
  const { mutate: markRead } = useMarkMessagesRead(channelId);
  const { isConnected } = useMessagingSocket(channelId);

  const currentChannel = channels?.find((c) => c.id === channelId);
  const heading = currentChannel ? channelTitle(currentChannel, myId) : t('messaging.conversation');

  /**
   * FAZ 2.4 — AI visibility: AI-authored messages are credited to the channel's
   * persona (aiPersonaDisplayName maps the ID; unknown IDs pass through, a
   * missing persona falls back to the generic 'AI Assistant' label). Only the
   * LABEL changes — AI authorship itself is still decided by the
   * server-authoritative `isAiGenerated` flag alone (metadata.isAi is
   * user-forgeable and deliberately NOT consulted).
   */
  const aiAuthorName = useMemo(
    () => aiPersonaDisplayName(currentChannel?.aiPersona) ?? t('messaging.aiAssistant'),
    [currentChannel?.aiPersona, t],
  );

  const [draft, setDraft] = useState('');
  const [bannerKey, setBannerKey] = useState<MessageKey | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastMarkedReadIdRef = useRef<string | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // The banner clears itself after a grace period…
  useEffect(() => {
    if (!bannerKey) return;
    const timer = window.setTimeout(() => setBannerKey(null), ERROR_BANNER_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [bannerKey]);

  /** The newest non-deleted message in the thread — the read cursor target. */
  const lastVisibleMessage = useMemo(() => {
    const visible = (messages ?? []).filter((m) => !m.isDeleted);
    return visible.length > 0 ? visible[visible.length - 1] : undefined;
  }, [messages]);

  /**
   * Mark the channel read up to the last VISIBLE message. Gated on
   * document.visibilityState — a hidden tab has not "read" anything (the
   * wrong-read gate) — and deferred while the thread loads (no data → no
   * cursor). Repeats are safe (backend lastReadAt is monotonic/no-op) but the
   * lastMarkedReadIdRef guard keeps them off the wire.
   */
  const tryMarkRead = useCallback(() => {
    if (!channelId || isLoading || !lastVisibleMessage) return;
    if (lastMarkedReadIdRef.current === lastVisibleMessage.id) return;
    if (!isDocumentVisible()) return;
    lastMarkedReadIdRef.current = lastVisibleMessage.id;
    markRead(lastVisibleMessage.id);
  }, [channelId, isLoading, lastVisibleMessage, markRead]);

  // A channel switch resets the cursor so the new room marks its own last
  // message (order matters: reset before the mark attempt below).
  useEffect(() => {
    lastMarkedReadIdRef.current = null;
  }, [channelId]);

  useEffect(() => {
    tryMarkRead();
  }, [tryMarkRead]);

  useEffect(() => {
    const onVisibilityChange = (): void => tryMarkRead();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [tryMarkRead]);

  const handleSend = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sendMutation.isPending) return;
    setDraft('');
    setBannerKey(null);
    // ONE key per logical send, computed BEFORE mutate so react-query retries
    // reuse it; memoised per (channel, draft) in sessionStorage so a restored
    // draft after reload replays instead of duplicating.
    const idempotencyKey = computeIdempotencyKey(channelId ?? '', text);
    try {
      await sendMutation.mutateAsync({ content: text, idempotencyKey });
    } catch (error) {
      // Restore the draft only if the user has not typed something new while
      // the request was in flight — clobbering their newer text would be its
      // own data loss (V1 minor).
      setDraft((current) => (current.length === 0 ? text : current));
      setBannerKey(sendErrorBannerKey(error)); // …and say WHY it failed.
    }
  };

  const visibleMessages = (messages ?? []).filter((m) => !m.isDeleted);

  return (
    <div className="sd-page" style={{ maxWidth: 520 }}>
      <div className="sd-card sd-card--flush sd-chat-card">
        {/* Header */}
        <div className="sd-chat-head">
          <button
            onClick={() => navigate('/messaging')}
            style={{ display: 'flex', border: 0, background: 'transparent', color: '#8aa0aa', cursor: 'pointer', padding: 0 }}
            aria-label="Back to channels"
          >
            <ArrowLeft size={17} />
          </button>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: '#0a1f2b' }}>{t('messaging.conversation')}</span>
          <span className="sd-chat-head-divider" />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5, color: '#5c7783' }}>
            {heading}
          </span>
          {channelId && !isConnected && (
            <span
              className="sd-hint"
              role="status"
              style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, marginTop: 0 }}
            >
              <RefreshCw size={11} className="animate-spin" aria-hidden />
              {t('messaging.reconnecting')}
            </span>
          )}
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="sd-chat-body">
          {isLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#8aa0aa', fontSize: 13 }}>
              <RefreshCw size={14} className="animate-spin" /> {t('messaging.loadingMessages')}
            </div>
          )}
          {!isLoading && visibleMessages.length === 0 && (
            <p style={{ margin: 'auto', fontSize: 13, color: '#8aa0aa' }}>{t('messaging.noMessages')}</p>
          )}
          {visibleMessages.map((m) => {
            const mine = m.senderId === myId;

            /**
             * FAZ 2.4 — AI failure notices (contentType SYSTEM +
             * metadata.error) are NOT AI answers: they render as a neutral,
             * italic/faded system line (existing sd-hint class) with the
             * 'AI unavailable' label — never as an AI-styled chat bubble with
             * an author line. The double gate (SYSTEM + error) keeps a forged
             * metadata.error on a user-sent TEXT message from ever reaching
             * this branch.
             */
            if (!mine && isAiErrorNotice(m)) {
              return (
                <div key={m.id} className="sd-msg-row" data-testid="ai-error-notice" role="note">
                  <p
                    className="sd-hint"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      margin: '2px 0',
                      fontStyle: 'italic',
                    }}
                  >
                    <AlertCircle size={12} aria-hidden />
                    {t('messaging.aiUnavailable')}
                  </p>
                </div>
              );
            }

            /**
             * FAZ 2.4 — safe non-text bodies: IMAGE/FILE/VOICE `content` is a
             * media reference (URL/storage key) and is NEVER rendered as text;
             * the bubble shows a localized placeholder label instead (full
             * media rendering arrives in FAZ 3.3).
             */
            const bodyKind = messageBodyKind(m.contentType);

            return (
              <div key={m.id} className={`sd-msg-row${mine ? ' sd-msg-row--mine' : ''}`}>
                <div style={{ maxWidth: '80%', minWidth: 0 }}>
                  {!mine && (
                    <div className="sd-msg-author">
                      {m.isAiGenerated && <Sparkles size={12} />}
                      {m.isAiGenerated ? aiAuthorName : senderName(m, t('messaging.memberFallback'))}
                    </div>
                  )}
                  <div className={`sd-msg${mine ? ' sd-msg--mine' : m.isAiGenerated ? ' sd-msg--ai' : ''}`}>
                    {bodyKind === 'text' ? (
                      m.content
                    ) : (
                      <span
                        data-testid={`media-placeholder-${bodyKind}`}
                        role="img"
                        aria-label={t(messageBodyLabelKey(bodyKind))}
                        style={{ fontStyle: 'italic' }}
                      >
                        {t(messageBodyLabelKey(bodyKind))}
                      </span>
                    )}
                    <span className="sd-msg-time">
                      {m.createdAt
                        ? new Date(m.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
                        : ''}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Composer */}
        <div className="sd-composer-wrap" style={{ padding: '11px 12px', borderTop: '1px solid rgba(10,31,43,.09)' }}>
          {bannerKey && (
            <div className="sd-banner sd-banner--error" role="alert" data-testid="send-error-banner">
              <AlertCircle size={17} style={{ color: '#b04a28' }} />
              <span style={{ fontSize: 13.5, fontWeight: 600, color: '#8e3a1e' }}>{t(bannerKey)}</span>
            </div>
          )}
          <div className="sd-composer">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              rows={1}
              placeholder={t('messaging.composerPlaceholder')}
              aria-label="Message"
            />
            <button
              onClick={() => void handleSend()}
              disabled={!draft.trim() || sendMutation.isPending}
              className="sd-send"
              aria-label="Send"
            >
              <Send size={16} />
            </button>
          </div>
          <p className="sd-hint">{t('messaging.composerHint')}</p>
        </div>
      </div>
    </div>
  );
};

export default ChatRoomPage;
