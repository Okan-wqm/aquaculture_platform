/**
 * @module MessageBubble
 * @description Single chat message bubble with WhatsApp-style layout.
 * Supports text, image, file, voice note playback, @mention highlighting,
 * forwarded message headers, and long-press context menu.
 *
 * WHY no swipe-to-reply: ADR-012 explicitly prohibits swipe gestures in
 * AquaMobil -- they conflict with iOS back gesture and are not reliable
 * with wet/gloved hands. Long-press context menu is used instead.
 *
 * WHY 500ms long-press: Standard mobile convention. Shorter durations
 * cause accidental triggers during scroll; longer feels unresponsive.
 *
 * @see ADR-012 section 5 (Messaging Features)
 */

import { clsx } from 'clsx';
import {
  File as FileIcon,
  Reply,
  Copy,
  Forward,
  Trash2,
  CornerUpRight,
  Pencil,
} from 'lucide-react';
import { useState, useCallback, useRef, useEffect, type ReactElement } from 'react';

import { ReadReceipt } from './ReadReceipt';
import { VoicePlayer } from './VoicePlayer';

import type { MessageContentType, MessageAttachment } from '@/types/messaging';
import { isSafeUrl } from '@/utils/messaging-helpers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read';

interface ReplyPreview {
  senderName: string;
  text: string;
}

interface FileAttachment {
  name: string;
  size: string;
  url: string;
}

interface ImageAttachment {
  url: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
}

interface MessageBubbleProps {
  /** Unique message identifier. */
  messageId: string;
  /** Whether the current user is the sender. */
  isOwn: boolean;
  /** Sender display name (shown in group channels for others' messages). */
  senderName?: string;
  /** Deterministic color index for the sender name in group chat. */
  senderColorIndex?: number;
  /** Message text content. */
  text?: string;
  /** Message content type for rendering decisions. */
  contentType?: MessageContentType;
  /** ISO timestamp of the message. */
  timestamp: string;
  /** Delivery/read status (only shown for own messages). */
  status?: DeliveryStatus;
  /** Whether the message has been edited. */
  isEdited?: boolean;
  /** Whether the message has been deleted. */
  isDeleted?: boolean;
  /** Whether this is a group channel (shows sender name). */
  isGroup?: boolean;
  /** Reply preview (quoted message). */
  replyTo?: ReplyPreview;
  /** Image attachment. */
  image?: ImageAttachment;
  /** Callback when the image attachment is opened in the media viewer. */
  onImageOpen?: () => void;
  /** File attachment. */
  file?: FileAttachment;
  /** Voice/audio attachments for voice note rendering. */
  attachments?: MessageAttachment[];
  /** Message metadata (contains voiceDurationSeconds, mentions, forward info). */
  metadata?: Record<string, unknown> | null;
  /** Source channel name for forwarded messages. */
  forwardedFromChannelName?: string;
  /** Whether this message is forwarded. */
  forwardedFrom?: string | null;
  /** Callback when Reply is selected from context menu. */
  onReply?: (messageId: string) => void;
  /** Callback when Copy is selected from context menu. */
  onCopy?: (messageId: string) => void;
  /** Callback when Forward is selected from context menu. */
  onForward?: (messageId: string) => void;
  /** Callback when Edit is selected from context menu (own text messages only). */
  onEdit?: (messageId: string) => void;
  /** Callback when Delete is selected from context menu. */
  onDelete?: (messageId: string) => void;
  /** Callback when a @mention is tapped. */
  onMentionTap?: (userId: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * WHY sender name colors at all: in a group chat a field worker tells who said
 * what by hue before reading the name.
 *
 * WHY five and not the previous ten: the v4 token layer resolves colour per
 * theme, and it offers exactly five decorative hues that are NOT already spoken
 * for by an alarm meaning — teal, blue, violet, amber and green. The tenth
 * "distinct" colour in the pre-v4 list was a hand-picked Tailwind ramp plus a
 * second class for the dark theme, which is the pairing the token layer exists
 * to remove; and coral is deliberately excluded because it reads as an alarm
 * everywhere else in the app. Five real hues beat ten a theme could collapse.
 *
 * The same five back ChannelAvatar and MentionPicker, so one person keeps one
 * hue wherever they appear.
 */
const SENDER_COLORS = [
  'text-acc',
  'text-type-water',
  'text-type-transfer',
  'text-type-cull',
  'text-type-harvest',
] as const;

const LONG_PRESS_MS = 500;

/**
 * A surface nested INSIDE a bubble — the reply quote, the file chip.
 *
 * WHY `bg-black/10` on the own side instead of a surface token: the own bubble
 * is filled with the accent, and the token ramp has no "one step darker than the
 * accent" value — the surface tokens are calibrated against the ground, not
 * against a saturated fill, so `bg-surface-3` on teal reads as a foreign patch.
 * A flat black wash reads as a recess on the accent in all three themes.
 *
 * WHY no alpha modifier on token colours anywhere in this file: Tailwind cannot
 * parse `var(--x)` as a colour, so a class like `text-acc-on/75` emits NO rule
 * at all — it silently does nothing. Where a dimmer treatment is wanted the
 * element carries a plain `opacity-*` utility instead.
 */
const NESTED_SURFACE = {
  own: 'bg-black/10',
  other: 'bg-surface-3',
} as const;

/** Secondary text on a bubble: on-accent ink dimmed by opacity, or the ink ramp. */
const META_TEXT = {
  own: 'text-acc-on opacity-75',
  other: 'text-ink-3',
} as const;

/**
 * One row of the long-press context menu. `min-h-touch` is the 44px gloved-use
 * floor (MOB-MEDIUM-009) — it replaces the hand-written 44px literal, so the
 * floor now comes from the spacing token rather than from a repeated constant.
 */
const MENU_ITEM =
  'flex items-center gap-3 px-4 py-3 min-w-[160px] min-h-touch hover:bg-surface-2 touch-feedback transition-colors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(isoDate: string): string {
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** WHY: Simple URL regex covers the vast majority of links shared in a work chat. */
const URL_REGEX = /https?:\/\/[^\s<]+/g;

/** Regex to match <mention> tags from the server. */
const MENTION_REGEX = /<mention userId="([^"]+)">(@[^<]+)<\/mention>/g;

/**
 * Render text with URL links and @mention highlights.
 */
function renderRichText(
  text: string,
  isOwn: boolean,
  onMentionTap?: (userId: string) => void,
): (string | ReactElement)[] {
  const parts: (string | ReactElement)[] = [];
  let lastIndex = 0;

  // Combined regex for URLs and mentions
  const combinedRegex = new RegExp(`${MENTION_REGEX.source}|${URL_REGEX.source}`, 'g');

  let match: RegExpExecArray | null;
  combinedRegex.lastIndex = 0;

  while ((match = combinedRegex.exec(text)) !== null) {
    // Push text before the match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (match[1] && match[2]) {
      // This is a <mention> tag match
      const userId = match[1];
      const mentionText = match[2];
      parts.push(
        <button
          key={`m-${match.index}`}
          onClick={() => onMentionTap?.(userId)}
          className={clsx(
            'font-bold inline',
            // On an accent-filled own bubble the accent cannot also be the
            // mention colour, so the mention is set in the on-accent ink and
            // carries an underline to stay distinguishable from body text.
            isOwn ? 'text-acc-on underline' : 'text-acc',
          )}
        >
          {mentionText}
        </button>,
      );
    } else {
      // This is a URL match
      const url = match[0];
      parts.push(
        <a
          key={`u-${match.index}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline break-all"
        >
          {url}
        </a>,
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MessageBubble({
  messageId,
  isOwn,
  senderName,
  senderColorIndex = 0,
  text,
  // S1-CODEGEN: MessageContentType is the UPPERCASE GraphQL enum NAME wire form.
  contentType = 'TEXT',
  timestamp,
  status,
  isEdited = false,
  isDeleted = false,
  isGroup = false,
  replyTo,
  image,
  onImageOpen,
  file,
  attachments,
  metadata,
  forwardedFromChannelName,
  forwardedFrom,
  onReply,
  onCopy,
  onForward,
  onEdit,
  onDelete,
  onMentionTap,
}: MessageBubbleProps): ReactElement {
  const [showMenu, setShowMenu] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -----------------------------------------------------------------------
  // Long-press handling
  // -----------------------------------------------------------------------
  const startLongPress = useCallback(() => {
    longPressTimer.current = setTimeout(() => {
      setShowMenu(true);
    }, LONG_PRESS_MS);
  }, []);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    };
  }, []);

  // Dismiss context menu on scroll
  useEffect(() => {
    if (!showMenu) return;
    const handleScroll = (): void => setShowMenu(false);
    window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll, { capture: true });
    };
  }, [showMenu]);

  const closeMenu = useCallback(() => setShowMenu(false), []);

  const handleAction = useCallback(
    (action: ((id: string) => void) | undefined) => {
      closeMenu();
      action?.(messageId);
    },
    [messageId, closeMenu],
  );

  const senderColor = SENDER_COLORS[senderColorIndex % SENDER_COLORS.length];
  const timeStr = formatTime(timestamp);

  // Voice note metadata
  const voiceDuration =
    contentType === 'VOICE' && metadata
      ? (metadata['voiceDurationSeconds'] as number | undefined)
      : undefined;
  const voiceAttachment =
    contentType === 'VOICE' && attachments?.length ? attachments[0] : undefined;

  const isForwarded = !!forwardedFrom;

  // -----------------------------------------------------------------------
  // Deleted message
  // -----------------------------------------------------------------------
  if (isDeleted) {
    return (
      <div className={clsx('flex px-4 py-0.5', isOwn ? 'justify-end' : 'justify-start')}>
        <div className="bg-surface-2 rounded-2xl px-4 py-2 max-w-[80%]">
          <span className="text-meta text-ink-3 italic">[message deleted]</span>
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Normal message
  // -----------------------------------------------------------------------
  return (
    <div className={clsx('flex px-4 py-0.5 relative', isOwn ? 'justify-end' : 'justify-start')}>
      <div
        className={clsx(
          'rounded-2xl px-3.5 py-2 max-w-[80%] relative shadow-token',
          isOwn
            ? 'bg-acc text-acc-on rounded-br-md'
            : 'bg-surface-2 text-ink-1 rounded-bl-md border border-line',
        )}
        onTouchStart={startLongPress}
        onTouchEnd={cancelLongPress}
        onTouchMove={cancelLongPress}
        onContextMenu={(e) => {
          e.preventDefault();
          setShowMenu(true);
        }}
      >
        {/* Forwarded from header */}
        {isForwarded && (
          <div
            className={clsx(
              // text-meta is 12px — the sunlight-readability floor. It replaces
              // a 10px arbitrary size, so it LOWERS the tiny-text ratchet.
              'flex items-center gap-1.5 mb-1.5 text-meta',
              isOwn ? META_TEXT.own : META_TEXT.other,
            )}
          >
            <CornerUpRight size={12} />
            <span className="italic">
              Forwarded{forwardedFromChannelName ? ` from ${forwardedFromChannelName}` : ''}
            </span>
          </div>
        )}

        {/* Sender name in group chat */}
        {isGroup && !isOwn && senderName && (
          <p className={clsx('text-meta font-bold mb-0.5', senderColor)}>{senderName}</p>
        )}

        {/* Reply preview */}
        {replyTo && (
          <div
            className={clsx(
              'mb-1.5 px-2.5 py-1.5 rounded-lg border-l-2 text-meta',
              isOwn ? `${NESTED_SURFACE.own} border-acc-on` : `${NESTED_SURFACE.other} border-acc`,
            )}
          >
            <p className={clsx('font-bold truncate', isOwn ? 'text-acc-on' : 'text-acc')}>
              {replyTo.senderName}
            </p>
            <p className={clsx('truncate', isOwn ? META_TEXT.own : 'text-ink-2')}>{replyTo.text}</p>
          </div>
        )}

        {/* Voice note — render VoicePlayer instead of text */}
        {contentType === 'VOICE' &&
          voiceAttachment?.downloadUrl &&
          isSafeUrl(voiceAttachment.downloadUrl) && (
            <VoicePlayer
              src={voiceAttachment.downloadUrl}
              durationSeconds={voiceDuration ?? voiceAttachment.durationSeconds ?? undefined}
              isOwn={isOwn}
            />
          )}

        {/* Image attachment -- URL protocol validated to prevent XSS */}
        {image && isSafeUrl(image.thumbnailUrl ?? image.url) && (
          <div className="mb-1.5 -mx-1 -mt-0.5 overflow-hidden rounded-xl">
            {onImageOpen ? (
              <button
                type="button"
                onClick={onImageOpen}
                className="block w-full text-left"
                aria-label="Open image attachment"
              >
                <img
                  src={image.thumbnailUrl ?? image.url}
                  alt="Attachment"
                  className="w-full max-h-64 object-cover rounded-xl"
                  loading="lazy"
                />
              </button>
            ) : (
              <img
                src={image.thumbnailUrl ?? image.url}
                alt="Attachment"
                className="w-full max-h-64 object-cover rounded-xl"
                loading="lazy"
              />
            )}
          </div>
        )}

        {/* File attachment -- URL protocol validated to prevent XSS */}
        {file && isSafeUrl(file.url) && (
          <a
            href={file.url}
            target="_blank"
            rel="noopener noreferrer"
            className={clsx(
              // Hover darkens on both sides. The other side uses `brightness`
              // rather than the next surface token because the ramp does not run
              // the same direction in every theme (s3 to s1 is darker at night
              // and LIGHTER by day), so a token step would invert the affordance.
              'flex items-center gap-2.5 mb-1.5 p-2.5 rounded-xl',
              isOwn
                ? `${NESTED_SURFACE.own} hover:bg-black/20`
                : `${NESTED_SURFACE.other} hover:brightness-95`,
            )}
          >
            {/* The icon tile inverts on the own side — on-accent fill with an
                accent glyph — so it separates from the accent bubble behind it. */}
            <div
              className={clsx(
                'w-10 h-10 rounded-lg flex items-center justify-center shrink-0',
                isOwn ? 'bg-acc-on' : 'bg-acc-dim',
              )}
            >
              <FileIcon size={18} className="text-acc" />
            </div>
            <div className="min-w-0 flex-1">
              <p
                className={clsx(
                  'text-meta font-semibold truncate',
                  isOwn ? 'text-acc-on' : 'text-ink-1',
                )}
              >
                {file.name}
              </p>
              <p className={clsx('text-meta', isOwn ? META_TEXT.own : META_TEXT.other)}>
                {file.size}
              </p>
            </div>
          </a>
        )}

        {/* Text content with @mention and URL rendering */}
        {text && contentType !== 'VOICE' && (
          <p
            className={clsx(
              'text-body leading-relaxed break-words whitespace-pre-wrap',
              isOwn ? 'text-acc-on' : 'text-ink-1',
            )}
          >
            {renderRichText(text, isOwn, onMentionTap)}
          </p>
        )}

        {/* Timestamp + edited + read receipt.
            The dimming lives on the text spans rather than on this row, because
            `opacity` on a parent multiplies into every child — and the read
            receipt needs FULL strength to be the thing that stands out. */}
        <div className="flex items-center justify-end gap-1 mt-1">
          {isEdited && (
            <span className={clsx('text-meta italic', isOwn ? META_TEXT.own : META_TEXT.other)}>
              (edited)
            </span>
          )}
          <span className={clsx('text-meta tabular-nums', isOwn ? META_TEXT.own : META_TEXT.other)}>
            {timeStr}
          </span>
          {isOwn && status && <ReadReceipt status={status} />}
        </div>
      </div>

      {/* Context menu overlay */}
      {showMenu && (
        <>
          {/* Backdrop — native <button> so the dismiss target is keyboard
              operable and focusable without extra key handlers. */}
          <button
            type="button"
            className="fixed inset-0 z-40"
            onClick={closeMenu}
            onTouchStart={closeMenu}
            aria-label="Dismiss menu"
          />
          {/* Menu */}
          <div
            className={clsx(
              'absolute z-50 bg-surface-1 rounded-xl shadow-token border border-line overflow-hidden',
              isOwn ? 'right-4 top-full mt-1' : 'left-4 top-full mt-1',
            )}
          >
            {onReply && (
              <button
                onClick={() => handleAction(onReply)}
                className={clsx(MENU_ITEM, 'text-ink-1')}
              >
                <Reply size={16} className="text-ink-2" />
                <span className="text-body font-medium">Reply</span>
              </button>
            )}
            {onCopy && (
              <button
                onClick={() => handleAction(onCopy)}
                className={clsx(MENU_ITEM, 'text-ink-1')}
              >
                <Copy size={16} className="text-ink-2" />
                <span className="text-body font-medium">Copy</span>
              </button>
            )}
            {onForward && (
              <button
                onClick={() => handleAction(onForward)}
                className={clsx(MENU_ITEM, 'text-ink-1')}
              >
                <Forward size={16} className="text-ink-2" />
                <span className="text-body font-medium">Forward</span>
              </button>
            )}
            {onEdit && (
              <button
                onClick={() => handleAction(onEdit)}
                className={clsx(MENU_ITEM, 'text-ink-1')}
              >
                <Pencil size={16} className="text-ink-2" />
                <span className="text-body font-medium">Edit</span>
              </button>
            )}
            {onDelete && (
              // Coral here is an alarm, not decoration: Delete is the one
              // irreversible entry in this menu, so it takes the crit token.
              <button
                onClick={() => handleAction(onDelete)}
                className={clsx(MENU_ITEM, 'text-crit')}
              >
                <Trash2 size={16} className="text-crit" />
                <span className="text-body font-medium">Delete</span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
