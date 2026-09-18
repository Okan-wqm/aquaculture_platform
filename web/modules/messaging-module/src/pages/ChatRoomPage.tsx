import { useAuth, useI18n, type MessageKey } from '@aquaculture/shared-ui';
import { ArrowLeft, ChevronDown, Send, Sparkles, RefreshCw, AlertCircle } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

import AiConsentSwitch from '../components/AiConsentSwitch';
import {
  useChannelMessages,
  useSendMessage,
  useChannels,
  useMarkMessagesRead,
  flattenChannelMessages,
} from '../hooks/useMessagingData';
import { useMessagingSocket } from '../hooks/useMessagingSocket';
import { aiPersonaDisplayName } from '../lib/aiPersona';
import { channelTitle } from '../lib/channelDisplay';
import { isAtTopEdge, isNearBottom } from '../lib/chatScroll';
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
 *
 * FAZ 3.3 (resilience & UX): the thread is a cursor-paginated infinite query —
 * scrolling to the top edge fetches the older page and restores the scroll
 * offset by the height the prepend added; auto-follow happens ONLY when the
 * user is already at the bottom, otherwise new messages surface through the
 * "new messages" pill; a channel switch renders NO previous-channel rows (no
 * placeholderData — zero-pixel bleed); a load error shows a role="alert"
 * banner; the message body is a polite aria-live log and the composer gets
 * focus when the room opens.
 */
const ChatRoomPage: React.FC = () => {
  const { channelId } = useParams<{ channelId: string }>();
  const navigate = useNavigate();
  const { user, hasPermission } = useAuth();
  const myId = user?.id;
  const { t } = useI18n();
  // FE-MEDIUM-065: the consent switch is shown only to members who may use
  // the assistant at all — without ai_assistant:use an opt-in would only turn
  // "no consent" notices into "not permitted" ones.
  const canUseAi = hasPermission('ai_assistant:use');

  const {
    data: messagesData,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useChannelMessages(channelId);
  const messages = useMemo(() => flattenChannelMessages(messagesData), [messagesData]);
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
  const [unseenCount, setUnseenCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const lastMarkedReadIdRef = useRef<string | null>(null);

  // Scroll bookkeeping (FAZ 3.3): near-bottom tracking drives auto-follow vs
  // the new-message pill; page-count/height snapshots drive prepend
  // restoration. All values are refs — scrolling must never re-render the
  // thread.
  const nearBottomRef = useRef(true);
  const prevPagesLenRef = useRef(0);
  const prevScrollHeightRef = useRef(0);
  const prevVisibleCountRef = useRef(0);
  const prevLastVisibleIdRef = useRef<string | null>(null);

  /** The newest non-deleted message in the thread — the read cursor target. */
  const lastVisibleMessage = useMemo(() => {
    const visible = messages.filter((m) => !m.isDeleted);
    return visible.length > 0 ? visible[visible.length - 1] : undefined;
  }, [messages]);

  /**
   * Mark the channel read up to the last VISIBLE message. Gated on
   * document.visibilityState — a hidden tab has not "read" anything (the
   * wrong-read gate) — and delayed while the thread loads (no data → no
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
  // message (order matters: reset before the mark attempt below) AND resets
  // the scroll bookkeeping so no state bleeds across rooms (FAZ 3.3).
  useEffect(() => {
    lastMarkedReadIdRef.current = null;
    nearBottomRef.current = true;
    prevPagesLenRef.current = 0;
    prevScrollHeightRef.current = 0;
    prevVisibleCountRef.current = 0;
    prevLastVisibleIdRef.current = null;
    setUnseenCount(0);
  }, [channelId]);

  useEffect(() => {
    tryMarkRead();
  }, [tryMarkRead]);

  useEffect(() => {
    const onVisibilityChange = (): void => tryMarkRead();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [tryMarkRead]);

  // a11y (FAZ 3.3): the composer takes focus when the room (re)opens so a
  // keyboard user can reply immediately.
  useEffect(() => {
    composerRef.current?.focus();
  }, [channelId]);

  /**
   * Scroll governor (FAZ 3.3) — runs AFTER the DOM mutation, BEFORE paint:
   *  - an OLDER page prepended (pages grew): restore the offset by the height
   *    the prepend added, so the viewport stays on the same message;
   *  - NEW messages arrived: auto-follow ONLY if the user was at the bottom;
   *    otherwise count them into the new-messages pill (no viewport yank).
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pagesLen = messagesData?.pages.length ?? 0;
    const lastVisibleId = lastVisibleMessage?.id ?? null;

    if (pagesLen > prevPagesLenRef.current && prevPagesLenRef.current > 0) {
      // Older page(s) prepended above the current viewport.
      el.scrollTop = el.scrollTop + (el.scrollHeight - prevScrollHeightRef.current);
    } else if (lastVisibleId !== prevLastVisibleIdRef.current && lastVisibleId !== null) {
      if (nearBottomRef.current) {
        el.scrollTo({ top: el.scrollHeight });
        setUnseenCount(0);
      } else {
        const delta = messages.filter((m) => !m.isDeleted).length - prevVisibleCountRef.current;
        if (delta > 0) setUnseenCount((count) => count + delta);
      }
    }

    prevPagesLenRef.current = pagesLen;
    prevScrollHeightRef.current = el.scrollHeight;
    prevVisibleCountRef.current = messages.filter((m) => !m.isDeleted).length;
    prevLastVisibleIdRef.current = lastVisibleId;
  }, [messages, messagesData, lastVisibleMessage]);

  // The banner clears itself after a grace period…
  useEffect(() => {
    if (!bannerKey) return;
    const timer = window.setTimeout(() => setBannerKey(null), ERROR_BANNER_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [bannerKey]);

  const handleScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = isNearBottom(el);
    if (nearBottomRef.current && unseenCount !== 0) setUnseenCount(0);
    if (isAtTopEdge(el) && !isLoading && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [isLoading, hasNextPage, isFetchingNextPage, fetchNextPage, unseenCount]);

  // Scroll listener as a passive addEventListener (not a React prop): the
  // container is a role="log" live region, and jsx-a11y rightly rejects
  // wiring interactive-style event handlers onto non-interactive roles.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  const jumpToLatest = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight });
    setUnseenCount(0);
  }, []);

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

  const visibleMessages = messages.filter((m) => !m.isDeleted);

  return (
    <div className="sd-page" style={{ maxWidth: 520 }}>
      <div className="sd-card sd-card--flush sd-chat-card">
        {/* Header */}
        <div className="sd-chat-head">
          <button
            onClick={() => navigate('/messaging')}
            style={{
              display: 'flex',
              border: 0,
              background: 'transparent',
              color: '#8aa0aa',
              cursor: 'pointer',
              padding: 0,
            }}
            aria-label={t('messaging.backToChannels')}
          >
            <ArrowLeft size={17} />
          </button>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: '#0a1f2b' }}>
            {t('messaging.conversation')}
          </span>
          <span className="sd-chat-head-divider" />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 12.5,
              color: '#5c7783',
            }}
          >
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

        {/* FE-MEDIUM-065: the bridge answers in an AI room only for members who
            opted in — the switch lives where the refusal would otherwise show. */}
        {currentChannel?.type === 'AI' && canUseAi && (
          <div
            data-testid="ai-consent"
            style={{ padding: '10px 16px', borderBottom: '1px solid rgba(10,31,43,.09)' }}
          >
            <AiConsentSwitch />
          </div>
        )}

        {/* Messages — polite live log: new rows are announced without stealing focus. */}
        <div
          ref={scrollRef}
          className="sd-chat-body"
          role="log"
          aria-live="polite"
          aria-label={t('messaging.conversation')}
        >
          {isFetchingNextPage && (
            <div
              data-testid="loading-older"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                color: '#8aa0aa',
                fontSize: 12,
                padding: '4px 0',
              }}
            >
              <RefreshCw size={12} className="animate-spin" aria-hidden />
              {t('messaging.loadingOlder')}
            </div>
          )}
          {isLoading && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                color: '#8aa0aa',
                fontSize: 13,
              }}
            >
              <RefreshCw size={14} className="animate-spin" /> {t('messaging.loadingMessages')}
            </div>
          )}
          {!isLoading && isError && (
            <div
              className="sd-banner sd-banner--error"
              role="alert"
              data-testid="messages-error-banner"
            >
              <AlertCircle size={17} style={{ color: '#b04a28' }} />
              <span style={{ fontSize: 13.5, fontWeight: 600, color: '#8e3a1e' }}>
                {t('messaging.errorMessages')}
              </span>
            </div>
          )}
          {!isLoading && !isError && visibleMessages.length === 0 && (
            <p style={{ margin: 'auto', fontSize: 13, color: '#8aa0aa' }}>
              {t('messaging.noMessages')}
            </p>
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
                      {m.isAiGenerated
                        ? aiAuthorName
                        : senderName(m, t('messaging.memberFallback'))}
                    </div>
                  )}
                  <div
                    className={`sd-msg${mine ? ' sd-msg--mine' : m.isAiGenerated ? ' sd-msg--ai' : ''}`}
                  >
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
                        ? new Date(m.createdAt).toLocaleTimeString('en-GB', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : ''}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Composer */}
        <div
          className="sd-composer-wrap"
          style={{ padding: '11px 12px', borderTop: '1px solid rgba(10,31,43,.09)' }}
        >
          {bannerKey && (
            <div
              className="sd-banner sd-banner--error"
              role="alert"
              data-testid="send-error-banner"
            >
              <AlertCircle size={17} style={{ color: '#b04a28' }} />
              <span style={{ fontSize: 13.5, fontWeight: 600, color: '#8e3a1e' }}>
                {t(bannerKey)}
              </span>
            </div>
          )}
          {unseenCount > 0 && (
            <button
              type="button"
              data-testid="new-messages-pill"
              aria-live="polite"
              onClick={jumpToLatest}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                margin: '0 auto 8px',
                padding: '4px 12px',
                border: 0,
                borderRadius: 999,
                background: '#0b4f60',
                color: '#eafaf4',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <ChevronDown size={13} aria-hidden />
              {t('messaging.newMessages', { count: unseenCount })}
            </button>
          )}
          <div className="sd-composer">
            <textarea
              ref={composerRef}
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
              aria-label={t('messaging.composerLabel')}
            />
            <button
              onClick={() => void handleSend()}
              disabled={!draft.trim() || sendMutation.isPending}
              className="sd-send"
              aria-label={t('messaging.sendLabel')}
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
