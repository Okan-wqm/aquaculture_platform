/**
 * ChatRoomPage -- WhatsApp-style real-time chat room with message bubbles.
 *
 * WHY this design: Field workers communicate in the field — often with gloves,
 * in bright sunlight, or on unstable connectivity. The chat UI follows proven
 * WhatsApp/iMessage patterns: own messages right-aligned in blue, others
 * left-aligned in white, date separators, read receipts, and a sticky input
 * bar with VisualViewport API handling for iOS keyboard push.
 *
 * Performance: Uses infinite scroll (load older on scroll-up), optimistic send
 * (message appears immediately with pending indicator), and grouped date
 * headers to reduce DOM operations and cognitive load.
 */

import {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  type KeyboardEvent,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Settings,
  Send,
  Paperclip,
  Check,
  CheckCheck,
  Clock,
  ChevronDown,
  Copy,
  Reply,
  Forward,
  Trash2,
  X,
  Image,
  AlertCircle,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useAuth } from '@/hooks/useAuth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

interface MessageSender {
  id: string;
  name: string;
  avatarUrl: string | null;
}

interface ChatMessage {
  id: string;
  content: string;
  sender: MessageSender;
  sentAt: string;
  status: MessageStatus;
  type: 'TEXT' | 'IMAGE' | 'FILE' | 'SYSTEM';
  /** For IMAGE type: presigned URL for the image thumbnail. */
  imageUrl?: string;
  /** For FILE type: file name and download URL. */
  fileName?: string;
  fileUrl?: string;
  /** Populated when this message is a reply to another. */
  replyTo?: {
    id: string;
    content: string;
    senderName: string;
  } | null;
}

interface ChannelInfo {
  id: string;
  name: string;
  type: 'DM' | 'GROUP';
  avatarUrl: string | null;
  memberCount: number;
  otherUserName: string | null;
  isOtherUserOnline: boolean;
}

// ---------------------------------------------------------------------------
// TODO: Replace with real hooks once messaging backend is integrated
// import { useMessages } from '@/hooks/useMessages';
// import { useMessageSocket } from '@/hooks/useMessageSocket';
// import { useSendMessage } from '@/hooks/useSendMessage';
// import { useTypingIndicator } from '@/hooks/useTypingIndicator';
// ---------------------------------------------------------------------------

function useMessages(_channelId: string): {
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  refetch: () => Promise<void>;
} {
  return {
    messages: [],
    loading: false,
    error: null,
    hasMore: false,
    loadMore: async () => {},
    refetch: async () => {},
  };
}

function useChannelInfo(_channelId: string): {
  channel: ChannelInfo | null;
  loading: boolean;
} {
  return { channel: null, loading: false };
}

function useSendMessage(_channelId: string): {
  send: (content: string) => Promise<void>;
  isSending: boolean;
} {
  return { send: async () => {}, isSending: false };
}

function useTypingIndicator(_channelId: string): {
  typingUsers: string[];
  sendTyping: () => void;
} {
  return { typingUsers: [], sendTyping: () => {} };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the date group label for a message timestamp.
 * Returns "Today", "Yesterday", or a formatted date string.
 */
function getDateLabel(isoString: string): string {
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (msgDate.getTime() === today.getTime()) return 'Today';
  if (msgDate.getTime() === yesterday.getTime()) return 'Yesterday';

  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: now.getFullYear() !== date.getFullYear() ? 'numeric' : undefined,
  });
}

/**
 * Format a message timestamp to a short time string (HH:MM).
 */
function formatMessageTime(isoString: string): string {
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Group messages by date for rendering date separators.
 */
function groupMessagesByDate(
  messages: ChatMessage[],
): Array<{ date: string; messages: ChatMessage[] }> {
  const groups: Array<{ date: string; messages: ChatMessage[] }> = [];
  let currentDate = '';

  for (const msg of messages) {
    const dateLabel = getDateLabel(msg.sentAt);
    if (dateLabel !== currentDate) {
      currentDate = dateLabel;
      groups.push({ date: dateLabel, messages: [msg] });
    } else {
      groups[groups.length - 1]?.messages.push(msg);
    }
  }

  return groups;
}

/**
 * Get initials from a name for avatar fallback.
 */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  const first = parts[0]?.charAt(0).toUpperCase() ?? '';
  const last =
    parts.length > 1
      ? (parts[parts.length - 1]?.charAt(0).toUpperCase() ?? '')
      : '';
  return first + last;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Status indicator icons for message delivery state. */
function MessageStatusIcon({ status }: { status: MessageStatus }) {
  switch (status) {
    case 'pending':
      return <Clock size={12} className="text-white/60" />;
    case 'sent':
      return <Check size={12} className="text-white/70" />;
    case 'delivered':
      return <CheckCheck size={12} className="text-white/70" />;
    case 'read':
      return <CheckCheck size={12} className="text-sky-300" />;
    case 'failed':
      return <AlertCircle size={12} className="text-red-300" />;
    default:
      return null;
  }
}

/** Context menu displayed on long-press of a message. */
function MessageContextMenu({
  message,
  isOwn,
  onClose,
  onReply,
  onCopy,
  onForward,
  onDelete,
}: {
  message: ChatMessage;
  isOwn: boolean;
  onClose: () => void;
  onReply: () => void;
  onCopy: () => void;
  onForward: () => void;
  onDelete: () => void;
}) {
  const actions = [
    { icon: Reply, label: 'Reply', action: onReply },
    { icon: Copy, label: 'Copy', action: onCopy },
    { icon: Forward, label: 'Forward', action: onForward },
    ...(isOwn
      ? [{ icon: Trash2, label: 'Delete', action: onDelete }]
      : []),
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      {/* Menu */}
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-full max-w-xs overflow-hidden">
        {/* Message preview */}
        <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {message.content}
          </p>
        </div>
        {/* Actions */}
        {actions.map((action) => {
          const Icon = action.icon;
          const isDestructive = action.label === 'Delete';
          return (
            <button
              key={action.label}
              onClick={() => {
                action.action();
                onClose();
              }}
              className="w-full flex items-center gap-3 px-4 py-3.5 touch-feedback transition-all border-b border-gray-50 dark:border-gray-800 last:border-0"
            >
              <Icon
                size={18}
                className={
                  isDestructive
                    ? 'text-red-500'
                    : 'text-gray-500 dark:text-gray-400'
                }
              />
              <span
                className={clsx(
                  'text-sm font-medium',
                  isDestructive
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-gray-900 dark:text-white',
                )}
              >
                {action.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A single message bubble in the chat. */
function MessageBubble({
  message,
  isOwn,
  showAvatar,
  onLongPress,
}: {
  message: ChatMessage;
  isOwn: boolean;
  showAvatar: boolean;
  onLongPress: () => void;
}) {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTouchStart = useCallback(() => {
    longPressTimerRef.current = setTimeout(() => {
      onLongPress();
    }, 500);
  }, [onLongPress]);

  const handleTouchEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // System messages — centered gray text
  if (message.type === 'SYSTEM') {
    return (
      <div className="flex justify-center py-2">
        <span className="text-[11px] text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-3 py-1 rounded-full">
          {message.content}
        </span>
      </div>
    );
  }

  return (
    <div
      className={clsx(
        'flex gap-2 px-4 mb-1',
        isOwn ? 'justify-end' : 'justify-start',
      )}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onContextMenu={(e) => {
        e.preventDefault();
        onLongPress();
      }}
    >
      {/* Sender avatar (only for group messages, left-aligned) */}
      {!isOwn && showAvatar ? (
        <div className="flex-shrink-0 self-end mb-1">
          {message.sender.avatarUrl ? (
            <img
              src={message.sender.avatarUrl}
              alt={message.sender.name}
              className="w-7 h-7 rounded-full object-cover"
            />
          ) : (
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-gray-300 to-gray-400 dark:from-gray-600 dark:to-gray-700 flex items-center justify-center text-[10px] font-bold text-white">
              {getInitials(message.sender.name)}
            </div>
          )}
        </div>
      ) : !isOwn ? (
        <div className="w-7 flex-shrink-0" />
      ) : null}

      {/* Bubble */}
      <div
        className={clsx(
          'max-w-[75%] rounded-2xl px-3.5 py-2 shadow-sm',
          isOwn
            ? 'bg-ocean-500 text-white rounded-br-md'
            : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-bl-md border border-gray-100 dark:border-gray-700',
        )}
      >
        {/* Sender name for group messages */}
        {!isOwn && showAvatar && (
          <p className="text-[11px] font-semibold text-ocean-600 dark:text-ocean-400 mb-0.5">
            {message.sender.name}
          </p>
        )}

        {/* Reply preview */}
        {message.replyTo && (
          <div
            className={clsx(
              'border-l-2 pl-2 mb-1.5 py-1',
              isOwn
                ? 'border-white/50'
                : 'border-ocean-400 dark:border-ocean-500',
            )}
          >
            <p
              className={clsx(
                'text-[10px] font-semibold',
                isOwn
                  ? 'text-white/80'
                  : 'text-ocean-600 dark:text-ocean-400',
              )}
            >
              {message.replyTo.senderName}
            </p>
            <p
              className={clsx(
                'text-[10px] truncate',
                isOwn
                  ? 'text-white/60'
                  : 'text-gray-500 dark:text-gray-400',
              )}
            >
              {message.replyTo.content}
            </p>
          </div>
        )}

        {/* Image message */}
        {message.type === 'IMAGE' && message.imageUrl && (
          <div className="mb-1.5 -mx-1 -mt-0.5 rounded-xl overflow-hidden">
            <img
              src={message.imageUrl}
              alt="Shared image"
              className="w-full max-h-48 object-cover"
              loading="lazy"
            />
          </div>
        )}

        {/* File message */}
        {message.type === 'FILE' && message.fileName && (
          <div
            className={clsx(
              'flex items-center gap-2 mb-1 p-2 rounded-lg',
              isOwn ? 'bg-white/10' : 'bg-gray-50 dark:bg-gray-700',
            )}
          >
            <Image size={16} className={isOwn ? 'text-white/70' : 'text-gray-500'} />
            <span
              className={clsx(
                'text-xs truncate',
                isOwn ? 'text-white/90' : 'text-gray-700 dark:text-gray-300',
              )}
            >
              {message.fileName}
            </span>
          </div>
        )}

        {/* Text content */}
        {message.content && (
          <p className="text-sm whitespace-pre-wrap break-words">
            {message.content}
          </p>
        )}

        {/* Timestamp + read receipt */}
        <div
          className={clsx(
            'flex items-center justify-end gap-1 mt-0.5',
            isOwn ? 'text-white/60' : 'text-gray-400 dark:text-gray-500',
          )}
        >
          <span className="text-[10px]">{formatMessageTime(message.sentAt)}</span>
          {isOwn && <MessageStatusIcon status={message.status} />}
        </div>
      </div>
    </div>
  );
}

/** Date separator between message groups. */
function DateSeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-3">
      <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-3 py-1 rounded-full shadow-sm">
        {label}
      </span>
    </div>
  );
}

/** Typing indicator shown when other users are typing. */
function TypingIndicator({ users }: { users: string[] }) {
  if (users.length === 0) return null;

  const label =
    users.length === 1
      ? `${users[0]} is typing...`
      : users.length === 2
        ? `${users[0]} and ${users[1]} are typing...`
        : `${users[0]} and ${users.length - 1} others are typing...`;

  return (
    <div className="px-4 py-1.5">
      <div className="flex items-center gap-2">
        <div className="flex gap-0.5">
          <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
        <span className="text-xs text-gray-400 dark:text-gray-500">{label}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * ChatRoomPage renders a full-screen chat interface for a specific channel.
 * Supports text messaging, infinite scroll, typing indicators, long-press
 * context menus, optimistic send, and iOS keyboard handling.
 */
export function ChatRoomPage() {
  const navigate = useNavigate();
  const { channelId } = useParams<{ channelId: string }>();
  const { user } = useAuth();

  const {
    messages,
    loading,
    error,
    hasMore,
    loadMore,
    refetch,
  } = useMessages(channelId ?? '');
  const { channel } = useChannelInfo(channelId ?? '');
  const { send, isSending } = useSendMessage(channelId ?? '');
  const { typingUsers, sendTyping } = useTypingIndicator(channelId ?? '');

  const [inputText, setInputText] = useState('');
  const [contextMessage, setContextMessage] = useState<ChatMessage | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isLoadingMoreRef = useRef(false);

  // Group messages by date
  const messageGroups = useMemo(
    () => groupMessagesByDate(messages),
    [messages],
  );

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop =
        scrollContainerRef.current.scrollHeight;
    }
  }, [messages.length]);

  // Handle VisualViewport resize for iOS keyboard
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const handleResize = () => {
      const offset = window.innerHeight - viewport.height;
      document.documentElement.style.setProperty(
        '--keyboard-offset',
        `${offset}px`,
      );
    };

    viewport.addEventListener('resize', handleResize);
    return () => viewport.removeEventListener('resize', handleResize);
  }, []);

  // Infinite scroll — load older messages when scrolling to top
  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container || !hasMore || isLoadingMoreRef.current) return;

    if (container.scrollTop < 100) {
      isLoadingMoreRef.current = true;
      const prevHeight = container.scrollHeight;
      await loadMore();
      // Maintain scroll position after prepending older messages
      requestAnimationFrame(() => {
        const newHeight = container.scrollHeight;
        container.scrollTop = newHeight - prevHeight;
        isLoadingMoreRef.current = false;
      });
    }
  }, [hasMore, loadMore]);

  // Send message handler
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text) return;

    setInputText('');
    setReplyingTo(null);

    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }

    await send(text);
  }, [inputText, send]);

  // Handle Enter key to send (Shift+Enter for newline)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Auto-resize textarea
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInputText(e.target.value);
      sendTyping();

      // Auto-resize
      const el = e.target;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    },
    [sendTyping],
  );

  // Context menu actions
  const handleReply = useCallback((msg: ChatMessage) => {
    setReplyingTo(msg);
    setContextMessage(null);
    inputRef.current?.focus();
  }, []);

  const handleCopy = useCallback((msg: ChatMessage) => {
    navigator.clipboard.writeText(msg.content).catch(() => {});
    setContextMessage(null);
  }, []);

  const handleForward = useCallback((_msg: ChatMessage) => {
    // TODO: Implement forward flow — navigate to channel picker
    setContextMessage(null);
  }, []);

  const handleDelete = useCallback((_msg: ChatMessage) => {
    // TODO: Implement delete via GraphQL mutation
    setContextMessage(null);
  }, []);

  const displayName =
    channel?.type === 'DM' && channel.otherUserName
      ? channel.otherUserName
      : channel?.name ?? 'Chat';

  const statusText =
    channel?.type === 'DM'
      ? channel.isOtherUserOnline
        ? 'Online'
        : 'Offline'
      : channel
        ? `${channel.memberCount} members`
        : '';

  return (
    <div
      className="flex flex-col h-screen bg-gray-100 dark:bg-gray-950"
      style={{
        paddingBottom: 'var(--keyboard-offset, 0px)',
      }}
    >
      {/* Header */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex-shrink-0 z-10">
        <div className="flex items-center gap-3 px-3 py-3 pt-safe-top">
          <button
            onClick={() => navigate('/messages')}
            className="p-2 -ml-1 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback"
          >
            <ArrowLeft size={22} className="text-gray-700 dark:text-gray-300" />
          </button>

          {/* Channel info */}
          <div
            className="flex-1 min-w-0 flex items-center gap-3 cursor-pointer"
            onClick={() => navigate(`/messages/${channelId}/settings`)}
          >
            {/* Avatar */}
            {channel?.avatarUrl ? (
              <img
                src={channel.avatarUrl}
                alt={displayName}
                className="w-9 h-9 rounded-full object-cover flex-shrink-0"
              />
            ) : (
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-ocean-400 to-ocean-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                {getInitials(displayName)}
              </div>
            )}
            <div className="min-w-0">
              <h1 className="text-sm font-bold text-gray-900 dark:text-white truncate">
                {displayName}
              </h1>
              {statusText && (
                <p className="text-[11px] text-gray-400 dark:text-gray-500">
                  {statusText}
                </p>
              )}
            </div>
          </div>

          <button
            onClick={() => navigate(`/messages/${channelId}/settings`)}
            className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback"
          >
            <Settings size={20} className="text-gray-500 dark:text-gray-400" />
          </button>
        </div>
      </div>

      {/* Message list */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overscroll-contain"
      >
        {/* Load more indicator */}
        {hasMore && (
          <div className="flex justify-center py-3">
            <button
              onClick={loadMore}
              className="text-xs text-ocean-500 font-medium touch-feedback flex items-center gap-1"
            >
              <ChevronDown size={14} className="rotate-180" />
              Load older messages
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ocean-500" />
          </div>
        ) : error ? (
          <div className="text-center py-12 px-4">
            <AlertCircle
              size={40}
              className="mx-auto mb-3 text-gray-300 opacity-60"
            />
            <p className="text-sm text-gray-500">{error}</p>
            <button
              onClick={refetch}
              className="mt-3 text-sm text-ocean-500 font-medium touch-feedback"
            >
              Retry
            </button>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-4">
            <div className="w-16 h-16 bg-ocean-50 dark:bg-ocean-900/20 rounded-full flex items-center justify-center mb-3">
              <Send size={24} className="text-ocean-400" />
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
              No messages yet. Say hello!
            </p>
          </div>
        ) : (
          <div className="py-2">
            {messageGroups.map((group) => (
              <div key={group.date}>
                <DateSeparator label={group.date} />
                {group.messages.map((msg, idx) => {
                  const isOwn = msg.sender.id === user?.id;
                  // Show avatar for group chats when sender changes
                  const prevMsg = idx > 0 ? group.messages[idx - 1] : null;
                  const showAvatar =
                    channel?.type === 'GROUP' &&
                    !isOwn &&
                    (!prevMsg || prevMsg.sender.id !== msg.sender.id);

                  return (
                    <MessageBubble
                      key={msg.id}
                      message={msg}
                      isOwn={isOwn}
                      showAvatar={showAvatar}
                      onLongPress={() => setContextMessage(msg)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* Typing indicator */}
        <TypingIndicator users={typingUsers} />
      </div>

      {/* Reply preview bar */}
      {replyingTo && (
        <div className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 px-4 py-2 flex items-center gap-3">
          <div className="flex-1 border-l-2 border-ocean-500 pl-2 min-w-0">
            <p className="text-[11px] font-semibold text-ocean-600 dark:text-ocean-400">
              {replyingTo.sender.name}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {replyingTo.content}
            </p>
          </div>
          <button
            onClick={() => setReplyingTo(null)}
            className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X size={16} className="text-gray-400" />
          </button>
        </div>
      )}

      {/* Input bar */}
      <div className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 flex-shrink-0 pb-safe">
        <div className="flex items-end gap-2 px-3 py-2">
          {/* Attachment button */}
          <button className="p-2.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback flex-shrink-0 self-end">
            <Paperclip
              size={20}
              className="text-gray-500 dark:text-gray-400"
            />
          </button>

          {/* Text input */}
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            className="flex-1 bg-gray-100 dark:bg-gray-800 rounded-2xl px-4 py-2.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 outline-none resize-none max-h-[120px] leading-5"
          />

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={!inputText.trim() || isSending}
            className={clsx(
              'w-12 h-12 rounded-full flex items-center justify-center touch-feedback flex-shrink-0 transition-all',
              inputText.trim()
                ? 'bg-ocean-500 text-white shadow-md shadow-ocean-500/30 active:scale-95'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500',
            )}
          >
            {isSending ? (
              <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
            ) : (
              <Send size={20} />
            )}
          </button>
        </div>
      </div>

      {/* Context menu modal */}
      {contextMessage && (
        <MessageContextMenu
          message={contextMessage}
          isOwn={contextMessage.sender.id === user?.id}
          onClose={() => setContextMessage(null)}
          onReply={() => handleReply(contextMessage)}
          onCopy={() => handleCopy(contextMessage)}
          onForward={() => handleForward(contextMessage)}
          onDelete={() => handleDelete(contextMessage)}
        />
      )}
    </div>
  );
}
