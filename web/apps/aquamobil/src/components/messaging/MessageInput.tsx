/**
 * @module MessageInput
 * @description Sticky bottom chat input bar with auto-resize, reply mode,
 * attachment trigger, voice recording, @mention picker, and iOS keyboard handling.
 *
 * WHY VisualViewport API: On iOS Safari, the software keyboard pushes the
 * viewport up without changing `window.innerHeight`. The VisualViewport API
 * reports the actual visible area, allowing us to position the input above
 * the keyboard. The `resize` fallback with 100ms debounce handles older
 * browsers that lack VisualViewport support.
 *
 * WHY Ctrl+Enter / Cmd+Enter: Desktop users expect keyboard shortcuts for
 * sending. Enter alone inserts a newline (multi-line messages are common
 * in work coordination chats).
 *
 * @see ADR-012 section 5 (Messaging Features)
 */

import { clsx } from 'clsx';
import { Send, Paperclip, Mic, X, Clock } from 'lucide-react';
import { useState, useRef, useCallback, useEffect, type ReactElement } from 'react';

import { MentionPicker } from './MentionPicker';
import { VoiceRecorder } from './VoiceRecorder';

import type { ChannelMember } from '@/types/messaging';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReplyContext {
  messageId: string;
  senderName: string;
  text: string;
}

interface MessageInputProps {
  /** Callback when a text message is sent. */
  onSend: (text: string) => void;
  /** Callback to open the attachment picker. */
  onAttachmentPress: () => void;
  /** Callback when a voice recording is completed. */
  onVoiceRecordingComplete?: (blob: Blob, durationSeconds: number, mimeType: string) => void;
  /** Active reply context (quoted message above input). */
  replyTo?: ReplyContext | null;
  /** Callback to cancel the reply. */
  onCancelReply?: () => void;
  /** Channel members for @mention picker. */
  channelMembers?: ChannelMember[];
  /** Placeholder text. */
  placeholder?: string;
  /** Maximum character limit. */
  maxLength?: number;
  /** Whether sending is disabled (e.g. no network). */
  disabled?: boolean;
  /** Whether the device currently has network connectivity.
   * WHY: When offline, the send button shows "Queue" with a clock icon instead
   * of "Send", so the user knows their message will be queued locally and sent
   * when connectivity returns. This prevents overstating immediate delivery. */
  isOnline?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ROWS = 5;
const DEFAULT_MAX_LENGTH = 4000;
const CHAR_WARNING_THRESHOLD = 3800;
const LINE_HEIGHT_PX = 20;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MessageInput({
  onSend,
  onAttachmentPress,
  onVoiceRecordingComplete,
  replyTo,
  onCancelReply,
  channelMembers = [],
  placeholder = 'Type a message...',
  maxLength = DEFAULT_MAX_LENGTH,
  disabled = false,
  isOnline = true,
}: MessageInputProps): ReactElement {
  const [text, setText] = useState('');
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const [mentionFilterText, setMentionFilterText] = useState('');
  const [mentionStartPos, setMentionStartPos] = useState<number | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const canSend = text.trim().length > 0 && !disabled;
  const charCount = text.length;
  const showCharCounter = charCount >= CHAR_WARNING_THRESHOLD;

  // -----------------------------------------------------------------------
  // Auto-resize textarea
  // -----------------------------------------------------------------------
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const maxHeight = LINE_HEIGHT_PX * MAX_ROWS;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
    ta.style.overflowY = ta.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [text, resizeTextarea]);

  // -----------------------------------------------------------------------
  // iOS keyboard handling via VisualViewport API
  // -----------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const adjustPosition = (): void => {
      if (window.visualViewport) {
        const offset = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;
        container.style.transform = offset > 0 ? `translateY(-${offset}px)` : '';
      }
    };

    // Primary: VisualViewport API
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', adjustPosition);
      window.visualViewport.addEventListener('scroll', adjustPosition);
    }

    // Fallback: window resize with 100ms debounce
    const fallbackHandler = (): void => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(adjustPosition, 100);
    };
    window.addEventListener('resize', fallbackHandler);

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', adjustPosition);
        window.visualViewport.removeEventListener('scroll', adjustPosition);
      }
      window.removeEventListener('resize', fallbackHandler);
      if (debounceTimer) clearTimeout(debounceTimer);
      if (container) container.style.transform = '';
    };
  }, []);

  // -----------------------------------------------------------------------
  // Send handler
  // -----------------------------------------------------------------------
  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
    setShowMentionPicker(false);
    setMentionStartPos(null);
    // Reset textarea height after clearing
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    });
  }, [text, disabled, onSend]);

  // -----------------------------------------------------------------------
  // Keyboard shortcut: Ctrl+Enter / Cmd+Enter
  // -----------------------------------------------------------------------
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // -----------------------------------------------------------------------
  // Input change with length enforcement and @mention detection
  // -----------------------------------------------------------------------
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      if (value.length > maxLength) return;

      setText(value);

      // Detect @ character for mention picker
      const cursorPos = e.target.selectionStart ?? value.length;
      const textBeforeCursor = value.slice(0, cursorPos);

      // Find the last @ that could be a mention trigger
      const lastAtIndex = textBeforeCursor.lastIndexOf('@');

      if (lastAtIndex >= 0) {
        // Check that the @ is at the start or preceded by a space/newline
        const charBefore = lastAtIndex > 0 ? textBeforeCursor[lastAtIndex - 1] : ' ';
        if (charBefore === ' ' || charBefore === '\n' || lastAtIndex === 0) {
          const filterText = textBeforeCursor.slice(lastAtIndex + 1);
          // Only show picker if the filter text doesn't contain spaces
          // beyond what a name might have (max 30 chars)
          if (filterText.length <= 30 && !filterText.includes('\n')) {
            setShowMentionPicker(true);
            setMentionFilterText(filterText);
            setMentionStartPos(lastAtIndex);
            return;
          }
        }
      }

      setShowMentionPicker(false);
      setMentionStartPos(null);
    },
    [maxLength],
  );

  // -----------------------------------------------------------------------
  // Mention selection handler
  // -----------------------------------------------------------------------
  const handleMentionSelect = useCallback(
    (member: ChannelMember) => {
      if (mentionStartPos === null) return;

      const ta = textareaRef.current;
      const cursorPos = ta?.selectionStart ?? text.length;

      // Build the mention text
      const displayName = member.user
        ? [member.user.firstName, member.user.lastName].filter(Boolean).join(' ')
          || member.userId
        : member.userId;

      const beforeMention = text.slice(0, mentionStartPos);
      const afterMention = text.slice(cursorPos);
      const mentionText = `@${displayName} `;

      const newText = beforeMention + mentionText + afterMention;
      setText(newText);
      setShowMentionPicker(false);
      setMentionStartPos(null);

      // Restore focus and cursor position
      requestAnimationFrame(() => {
        if (ta) {
          ta.focus();
          const newCursorPos = beforeMention.length + mentionText.length;
          ta.setSelectionRange(newCursorPos, newCursorPos);
        }
      });
    },
    [text, mentionStartPos],
  );

  // -----------------------------------------------------------------------
  // Voice recording handlers
  // -----------------------------------------------------------------------
  const handleVoiceToggle = useCallback(() => {
    setIsVoiceMode(true);
  }, []);

  const handleVoiceComplete = useCallback(
    (blob: Blob, durationSeconds: number, mimeType: string) => {
      setIsVoiceMode(false);
      onVoiceRecordingComplete?.(blob, durationSeconds, mimeType);
    },
    [onVoiceRecordingComplete],
  );

  const handleVoiceCancel = useCallback(() => {
    setIsVoiceMode(false);
  }, []);

  // -----------------------------------------------------------------------
  // Render: Voice recorder mode
  // -----------------------------------------------------------------------
  if (isVoiceMode) {
    return (
      <div
        ref={containerRef}
        className="sticky bottom-0 z-30 bg-white dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800 pb-safe transition-transform"
      >
        <VoiceRecorder
          onRecordingComplete={handleVoiceComplete}
          onCancel={handleVoiceCancel}
          disabled={disabled}
        />
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Render: Text input mode
  // -----------------------------------------------------------------------
  return (
    <div
      ref={containerRef}
      className="sticky bottom-0 z-30 bg-white dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800 pb-safe transition-transform"
    >
      {/* Reply preview bar */}
      {replyTo && (
        <div className="flex items-center gap-2 px-4 pt-2 pb-1">
          <div className="flex-1 min-w-0 border-l-2 border-ocean-500 pl-2.5 py-1">
            <p className="text-xs font-bold text-ocean-600 dark:text-ocean-400 truncate">
              {replyTo.senderName}
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{replyTo.text}</p>
          </div>
          {onCancelReply && (
            <button
              onClick={onCancelReply}
              className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback transition-colors"
              aria-label="Cancel reply"
            >
              <X size={18} className="text-gray-400" />
            </button>
          )}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2 px-3 py-2 relative">
        {/* Mention picker (positioned above input) */}
        <MentionPicker
          members={channelMembers}
          filterText={mentionFilterText}
          onSelect={handleMentionSelect}
          onDismiss={() => {
            setShowMentionPicker(false);
            setMentionStartPos(null);
          }}
          visible={showMentionPicker}
        />

        {/* Attachment button */}
        <button
          onClick={onAttachmentPress}
          disabled={disabled}
          className={clsx(
            'min-w-[48px] min-h-[48px] flex items-center justify-center rounded-full touch-feedback transition-colors',
            disabled
              ? 'opacity-50'
              : 'hover:bg-gray-100 dark:hover:bg-gray-800',
          )}
          aria-label="Add attachment"
        >
          <Paperclip size={22} className="text-gray-500 dark:text-gray-400" />
        </button>

        {/* Auto-resizing textarea */}
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className={clsx(
              'w-full resize-none rounded-2xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800',
              'px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400',
              'focus:outline-none focus:ring-2 focus:ring-ocean-500/40 focus:border-ocean-500 transition-all',
              disabled && 'opacity-50 cursor-not-allowed',
            )}
            style={{ lineHeight: `${LINE_HEIGHT_PX}px` }}
          />
          {/* Character counter */}
          {showCharCounter && (
            <span
              className={clsx(
                'absolute bottom-1.5 right-3 text-[10px] font-semibold tabular-nums',
                charCount >= maxLength ? 'text-red-500' : 'text-gray-400',
              )}
            >
              {charCount}/{maxLength}
            </span>
          )}
        </div>

        {/* Voice / Send button (toggle based on text content) */}
        {/* WHY: When offline, the send button uses amber styling with a clock icon
         * to indicate "Queue" semantics. The user can still compose and submit
         * messages, but the visual treatment makes clear the message will be
         * queued locally and sent when connectivity returns. */}
        {canSend ? (
          <button
            onClick={handleSend}
            disabled={!canSend}
            className={clsx(
              'min-w-[48px] min-h-[48px] flex items-center justify-center rounded-full transition-all touch-feedback',
              isOnline
                ? 'bg-ocean-600 hover:bg-ocean-700 shadow-glow-ocean'
                : 'bg-amber-500 hover:bg-amber-600 shadow-md shadow-amber-500/30',
            )}
            aria-label={isOnline ? 'Send message' : 'Queue message for later'}
          >
            {isOnline ? (
              <Send size={20} className="text-white" />
            ) : (
              <Clock size={20} className="text-white" />
            )}
          </button>
        ) : (
          <button
            onClick={handleVoiceToggle}
            disabled={disabled}
            className={clsx(
              'min-w-[48px] min-h-[48px] flex items-center justify-center rounded-full transition-all touch-feedback',
              disabled
                ? 'opacity-50 cursor-not-allowed'
                : 'hover:bg-gray-100 dark:hover:bg-gray-800',
            )}
            aria-label="Record voice note"
          >
            <Mic size={22} className="text-gray-500 dark:text-gray-400" />
          </button>
        )}
      </div>
    </div>
  );
}
