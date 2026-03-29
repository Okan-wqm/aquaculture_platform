/**
 * ChatRoomPage -- WhatsApp-style real-time chat room.
 * Supports infinite scroll, optimistic send, typing indicators, and iOS keyboard handling.
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
  ChevronDown,
  AlertCircle,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useAuth } from '@/hooks/useAuth';
import { useMessages } from '@/hooks/useMessages';
import { useMessageSocket } from '@/hooks/useMessageSocket';
import { useSendMessage } from '@/hooks/useSendMessage';
import { useTypingIndicator } from '@/hooks/useTypingIndicator';
import { useChannelDetail } from '@/hooks/useChannelDetail';
import { MessageBubble } from '@/components/messaging/MessageBubble';
import { TypingIndicator } from '@/components/messaging/TypingIndicator';
import { MessageDateSeparator } from '@/components/messaging/MessageDateSeparator';
import { ChannelAvatar } from '@/components/messaging/ChannelAvatar';
import { getDateLabel, getUserDisplayName } from '@/utils/messaging-helpers';
import type { Message } from '@/types/messaging';

/** Group messages by date for rendering date separators. */
function groupMessagesByDate(
  messages: Message[],
): Array<{ date: string; messages: Message[] }> {
  const groups: Array<{ date: string; messages: Message[] }> = [];
  let currentDate = '';

  for (const msg of messages) {
    const dateLabel = getDateLabel(msg.createdAt);
    if (dateLabel !== currentDate) {
      currentDate = dateLabel;
      groups.push({ date: dateLabel, messages: [msg] });
    } else {
      groups[groups.length - 1]?.messages.push(msg);
    }
  }

  return groups;
}

/** Compute sender color index from sender ID for group chat name coloring. */
function senderColorIndex(senderId: string): number {
  let hash = 0;
  for (let i = 0; i < senderId.length; i++) {
    hash = ((hash << 5) - hash + senderId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** ChatRoomPage renders a full-screen chat interface for a specific channel. */
export function ChatRoomPage() {
  const navigate = useNavigate();
  const { channelId } = useParams<{ channelId: string }>();
  const { user } = useAuth();

  // Real hooks -- wired to backend
  const { isConnected, joinChannel, leaveChannel, socketRef } =
    useMessageSocket();
  const {
    messages,
    isLoading: messagesLoading,
    error: messagesError,
    fetchNextPage,
    hasNextPage,
  } = useMessages(channelId, socketRef);
  const { channel, isLoading: channelLoading } = useChannelDetail(channelId);
  const { sendMessage, isSending } = useSendMessage(channelId);
  const { startTyping, stopTyping, typingUsers } = useTypingIndicator(
    channelId,
    socketRef,
    user?.id,
  );

  const [inputText, setInputText] = useState('');
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isLoadingMoreRef = useRef(false);

  // Join/leave channel room for socket events
  useEffect(() => {
    if (channelId && isConnected) {
      joinChannel(channelId);
      return () => {
        leaveChannel(channelId);
      };
    }
  }, [channelId, isConnected, joinChannel, leaveChannel]);

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

  // Infinite scroll -- load older messages when scrolling to top
  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container || !hasNextPage || isLoadingMoreRef.current) return;

    if (container.scrollTop < 100) {
      isLoadingMoreRef.current = true;
      const prevHeight = container.scrollHeight;
      await fetchNextPage();
      requestAnimationFrame(() => {
        const newHeight = container.scrollHeight;
        container.scrollTop = newHeight - prevHeight;
        isLoadingMoreRef.current = false;
      });
    }
  }, [hasNextPage, fetchNextPage]);

  // Send message handler
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text) return;

    setInputText('');
    setReplyingTo(null);
    stopTyping();

    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }

    await sendMessage({
      content: text,
      contentType: 'text',
      parentId: replyingTo?.id,
    });
  }, [inputText, sendMessage, replyingTo, stopTyping]);

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

  // Auto-resize textarea + typing indicator
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInputText(e.target.value);
      startTyping();

      const el = e.target;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    },
    [startTyping],
  );

  // Context menu actions
  const handleReply = useCallback((messageId: string) => {
    const msg = messages.find((m) => m.id === messageId);
    if (msg) {
      setReplyingTo(msg);
      inputRef.current?.focus();
    }
  }, [messages]);

  const handleCopy = useCallback((messageId: string) => {
    const msg = messages.find((m) => m.id === messageId);
    if (msg?.content) {
      navigator.clipboard.writeText(msg.content).catch(() => {});
    }
  }, [messages]);

  // Compute display name and status for the header
  const displayName = useMemo(() => {
    if (!channel) return 'Chat';
    if (channel.type === 'direct' && channel.members) {
      const other = channel.members.find((m) => m.userId !== user?.id);
      if (other?.user) return getUserDisplayName(other.user);
    }
    return channel.name ?? 'Chat';
  }, [channel, user?.id]);

  const isOtherOnline = useMemo(() => {
    if (!channel || channel.type !== 'direct' || !channel.members) return false;
    const other = channel.members.find((m) => m.userId !== user?.id);
    return other?.user?.isOnline ?? false;
  }, [channel, user?.id]);

  const statusText = channel?.type === 'direct'
    ? (isOtherOnline ? 'Online' : 'Offline')
    : channel
      ? `${channel.memberCount ?? 0} members`
      : '';

  const avatarType = channel?.type === 'direct' ? 'dm' : channel?.type === 'ai' ? 'ai' : 'group';

  // Compute typing user names from IDs (in real use, resolve from members)
  const typingUserNames = useMemo(() => {
    if (!channel?.members || typingUsers.length === 0) return typingUsers;
    return typingUsers.map((uid) => {
      const member = channel.members?.find((m) => m.userId === uid);
      return member?.user ? getUserDisplayName(member.user) : uid;
    });
  }, [typingUsers, channel?.members]);

  const loading = messagesLoading || channelLoading;
  const errorMsg = messagesError
    ? (messagesError instanceof Error ? messagesError.message : 'Failed to load messages')
    : null;

  return (
    <div
      className="flex flex-col h-screen bg-gray-100 dark:bg-gray-950"
      style={{ paddingBottom: 'var(--keyboard-offset, 0px)' }}
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

          <div
            className="flex-1 min-w-0 flex items-center gap-3 cursor-pointer"
            onClick={() => navigate(`/messages/${channelId}/settings`)}
          >
            <ChannelAvatar
              type={avatarType}
              name={displayName}
              imageUrl={channel?.avatarUrl ?? undefined}
              isOnline={isOtherOnline}
              size="sm"
            />
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
        {hasNextPage && (
          <div className="flex justify-center py-3">
            <button
              onClick={() => fetchNextPage()}
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
        ) : errorMsg ? (
          <div className="text-center py-12 px-4">
            <AlertCircle size={40} className="mx-auto mb-3 text-gray-300 opacity-60" />
            <p className="text-sm text-gray-500">{errorMsg}</p>
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
                <MessageDateSeparator date={group.date} />
                {group.messages.map((msg, idx) => {
                  const isOwn = msg.senderId === user?.id;
                  const prevMsg = idx > 0 ? group.messages[idx - 1] : null;
                  const showSenderName =
                    channel?.type === 'group' &&
                    !isOwn &&
                    (!prevMsg || prevMsg.senderId !== msg.senderId);

                  const senderName = msg.sender
                    ? getUserDisplayName(msg.sender)
                    : undefined;

                  // Build reply preview from parentId
                  const replyPreview = msg.parentId
                    ? (() => {
                        const parent = messages.find((m) => m.id === msg.parentId);
                        if (!parent) return undefined;
                        return {
                          senderName: parent.sender
                            ? getUserDisplayName(parent.sender)
                            : 'Unknown',
                          text: parent.content ?? '',
                        };
                      })()
                    : undefined;

                  // Map attachment data
                  const firstAttachment = msg.attachments?.[0];
                  const image =
                    msg.contentType === 'image' && firstAttachment
                      ? {
                          url: firstAttachment.downloadUrl ?? '',
                          thumbnailUrl: firstAttachment.thumbnailUrl ?? undefined,
                          width: firstAttachment.width ?? undefined,
                          height: firstAttachment.height ?? undefined,
                        }
                      : undefined;
                  const file =
                    msg.contentType === 'file' && firstAttachment
                      ? {
                          name: firstAttachment.originalFilename,
                          size: `${Math.round(firstAttachment.fileSize / 1024)}KB`,
                          url: firstAttachment.downloadUrl ?? '',
                        }
                      : undefined;

                  // Map optimistic status to delivery status
                  const status = msg._status === 'pending'
                    ? 'pending' as const
                    : msg._status === 'failed'
                      ? 'pending' as const
                      : msg.receipts?.some((r) => r.status === 'read')
                        ? 'read' as const
                        : msg.receipts?.some((r) => r.status === 'delivered')
                          ? 'delivered' as const
                          : 'sent' as const;

                  return (
                    <MessageBubble
                      key={msg.id}
                      messageId={msg.id}
                      isOwn={isOwn}
                      senderName={showSenderName ? senderName : undefined}
                      senderColorIndex={senderColorIndex(msg.senderId)}
                      text={msg.content ?? undefined}
                      timestamp={msg.createdAt}
                      status={isOwn ? status : undefined}
                      isEdited={!!msg.editedAt}
                      isDeleted={msg.isDeleted}
                      isGroup={channel?.type === 'group'}
                      replyTo={replyPreview}
                      image={image}
                      file={file}
                      onReply={handleReply}
                      onCopy={handleCopy}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* Typing indicator */}
        <TypingIndicator typingUsers={typingUserNames} />
      </div>

      {/* Reply preview bar */}
      {replyingTo && (
        <div className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 px-4 py-2 flex items-center gap-3">
          <div className="flex-1 border-l-2 border-ocean-500 pl-2 min-w-0">
            <p className="text-[11px] font-semibold text-ocean-600 dark:text-ocean-400">
              {replyingTo.sender ? getUserDisplayName(replyingTo.sender) : 'Unknown'}
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
          <button className="p-2.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback flex-shrink-0 self-end">
            <Paperclip size={20} className="text-gray-500 dark:text-gray-400" />
          </button>

          <textarea
            ref={inputRef}
            value={inputText}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            className="flex-1 bg-gray-100 dark:bg-gray-800 rounded-2xl px-4 py-2.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 outline-none resize-none max-h-[120px] leading-5"
          />

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
    </div>
  );
}
