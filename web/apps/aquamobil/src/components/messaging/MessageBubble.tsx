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
import { File as FileIcon, Reply, Copy, Forward, Trash2, CornerUpRight, Pencil } from 'lucide-react';
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
 * WHY: 10 sender name colors ensure visual distinction in group chats
 * so field workers can quickly tell who said what without reading the name.
 * Colors are chosen for readability against the white bubble background.
 */
const SENDER_COLORS = [
  'text-ocean-700 dark:text-ocean-400',
  'text-sea-700 dark:text-sea-400',
  'text-coral-700 dark:text-coral-400',
  'text-violet-700 dark:text-violet-400',
  'text-amber-700 dark:text-amber-400',
  'text-emerald-700 dark:text-emerald-400',
  'text-rose-700 dark:text-rose-400',
  'text-cyan-700 dark:text-cyan-400',
  'text-indigo-700 dark:text-indigo-400',
  'text-teal-700 dark:text-teal-400',
] as const;

const LONG_PRESS_MS = 500;

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
  const combinedRegex = new RegExp(
    `${MENTION_REGEX.source}|${URL_REGEX.source}`,
    'g',
  );

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
            isOwn
              ? 'text-white underline decoration-white/50'
              : 'text-ocean-600 dark:text-ocean-400',
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
  const voiceAttachment = contentType === 'VOICE' && attachments?.length
    ? attachments[0]
    : undefined;

  const isForwarded = !!forwardedFrom;

  // -----------------------------------------------------------------------
  // Deleted message
  // -----------------------------------------------------------------------
  if (isDeleted) {
    return (
      <div className={clsx('flex px-4 py-0.5', isOwn ? 'justify-end' : 'justify-start')}>
        <div className="bg-gray-100 dark:bg-gray-800 rounded-2xl px-4 py-2 max-w-[80%]">
          <span className="text-xs text-gray-400 dark:text-gray-500 italic">
            [message deleted]
          </span>
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
          'rounded-2xl px-3.5 py-2 max-w-[80%] relative shadow-sm',
          isOwn
            ? 'bg-ocean-600 text-white rounded-br-md'
            : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-bl-md border border-gray-100 dark:border-gray-700',
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
              'flex items-center gap-1.5 mb-1.5 text-[10px]',
              isOwn ? 'text-white/60' : 'text-gray-400 dark:text-gray-500',
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
          <p className={clsx('text-xs font-bold mb-0.5', senderColor)}>{senderName}</p>
        )}

        {/* Reply preview */}
        {replyTo && (
          <div
            className={clsx(
              'mb-1.5 px-2.5 py-1.5 rounded-lg border-l-2 text-xs',
              isOwn
                ? 'bg-ocean-700/50 border-white/50'
                : 'bg-gray-50 dark:bg-gray-700/60 border-ocean-400',
            )}
          >
            <p className={clsx('font-bold truncate', isOwn ? 'text-white/90' : 'text-ocean-600 dark:text-ocean-400')}>
              {replyTo.senderName}
            </p>
            <p className={clsx('truncate', isOwn ? 'text-white/70' : 'text-gray-500 dark:text-gray-400')}>
              {replyTo.text}
            </p>
          </div>
        )}

        {/* Voice note — render VoicePlayer instead of text */}
        {contentType === 'VOICE' && voiceAttachment?.downloadUrl && isSafeUrl(voiceAttachment.downloadUrl) && (
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
              'flex items-center gap-2.5 mb-1.5 p-2.5 rounded-xl',
              isOwn
                ? 'bg-ocean-700/50 hover:bg-ocean-700/70'
                : 'bg-gray-50 dark:bg-gray-700/60 hover:bg-gray-100 dark:hover:bg-gray-700',
            )}
          >
            <div
              className={clsx(
                'w-10 h-10 rounded-lg flex items-center justify-center shrink-0',
                isOwn ? 'bg-white/20' : 'bg-ocean-50 dark:bg-ocean-900/30',
              )}
            >
              <FileIcon size={18} className={isOwn ? 'text-white' : 'text-ocean-600 dark:text-ocean-400'} />
            </div>
            <div className="min-w-0 flex-1">
              <p className={clsx('text-xs font-semibold truncate', isOwn ? 'text-white' : 'text-gray-900 dark:text-gray-100')}>
                {file.name}
              </p>
              <p className={clsx('text-[10px]', isOwn ? 'text-white/60' : 'text-gray-400')}>
                {file.size}
              </p>
            </div>
          </a>
        )}

        {/* Text content with @mention and URL rendering */}
        {text && contentType !== 'VOICE' && (
          <p className={clsx('text-sm leading-relaxed break-words whitespace-pre-wrap', isOwn ? 'text-white' : 'text-gray-900 dark:text-gray-100')}>
            {renderRichText(text, isOwn, onMentionTap)}
          </p>
        )}

        {/* Timestamp + edited + read receipt */}
        <div className={clsx('flex items-center justify-end gap-1 mt-1', isOwn ? 'text-white/60' : 'text-gray-400 dark:text-gray-500')}>
          {isEdited && <span className="text-[10px] italic">(edited)</span>}
          <span className="text-[10px] tabular-nums">{timeStr}</span>
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
              'absolute z-50 bg-white dark:bg-gray-800 rounded-xl shadow-elevated border border-gray-100 dark:border-gray-700 overflow-hidden',
              isOwn ? 'right-4 top-full mt-1' : 'left-4 top-full mt-1',
            )}
          >
            {onReply && (
              <button
                onClick={() => handleAction(onReply)}
                className="flex items-center gap-3 px-4 py-3 min-w-[160px] min-h-[44px] hover:bg-gray-50 dark:hover:bg-gray-700 touch-feedback transition-colors"
              >
                <Reply size={16} className="text-gray-500" />
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Reply</span>
              </button>
            )}
            {onCopy && (
              <button
                onClick={() => handleAction(onCopy)}
                className="flex items-center gap-3 px-4 py-3 min-w-[160px] min-h-[44px] hover:bg-gray-50 dark:hover:bg-gray-700 touch-feedback transition-colors"
              >
                <Copy size={16} className="text-gray-500" />
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Copy</span>
              </button>
            )}
            {onForward && (
              <button
                onClick={() => handleAction(onForward)}
                className="flex items-center gap-3 px-4 py-3 min-w-[160px] min-h-[44px] hover:bg-gray-50 dark:hover:bg-gray-700 touch-feedback transition-colors"
              >
                <Forward size={16} className="text-gray-500" />
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Forward</span>
              </button>
            )}
            {onEdit && (
              <button
                onClick={() => handleAction(onEdit)}
                className="flex items-center gap-3 px-4 py-3 min-w-[160px] min-h-[44px] hover:bg-gray-50 dark:hover:bg-gray-700 touch-feedback transition-colors"
              >
                <Pencil size={16} className="text-gray-500" />
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Edit</span>
              </button>
            )}
            {onDelete && (
              <button
                onClick={() => handleAction(onDelete)}
                className="flex items-center gap-3 px-4 py-3 min-w-[160px] min-h-[44px] hover:bg-gray-50 dark:hover:bg-gray-700 touch-feedback transition-colors"
              >
                <Trash2 size={16} className="text-red-500" />
                <span className="text-sm font-medium text-red-600 dark:text-red-400">Delete</span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
