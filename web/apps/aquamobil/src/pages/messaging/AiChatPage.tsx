/**
 * AiChatPage -- AI channel chat page with streaming responses and action cards.
 *
 * WHY separate from ChatRoomPage: AI channels have distinct UX requirements:
 * - AI virtual user avatar (robot icon, purple border)
 * - Typewriter effect for AI responses (streaming token display)
 * - "AI is thinking..." loading indicator (animated brain icon)
 * - Action cards for AI-proposed write actions (Confirm/Cancel)
 * - Context indicator: "AI has access to your farm data"
 * - 60-second timeout with fallback message
 *
 * The data flow mirrors ChatRoomPage (same hooks for messages, socket, etc.)
 * but adds AI-specific hooks (useAiChat, useAiConsent) and components.
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
  Bot,
  Info,
  AlertCircle,
  Sparkles,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useAuth } from '@/hooks/useAuth';
import { useMessages } from '@/hooks/useMessages';
import { useMessageSocket } from '@/hooks/useMessageSocket';
import { useSendMessage } from '@/hooks/useSendMessage';
import { useChannelDetail } from '@/hooks/useChannelDetail';
import { useAiChat } from '@/hooks/useAiChat';
import { MessageBubble } from '@/components/messaging/MessageBubble';
import { AiTypingIndicator } from '@/components/messaging/AiTypingIndicator';
import { AiActionCard } from '@/components/messaging/AiActionCard';
import { MessageDateSeparator } from '@/components/messaging/MessageDateSeparator';
import { getDateLabel, getUserDisplayName } from '@/utils/messaging-helpers';
import type { Message } from '@/types/messaging';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Check if a message is from the AI virtual user. */
function isAiMessage(msg: Message): boolean {
  return msg.sender?.displayName === 'AI Assistant' || msg.metadata?.isAi === true;
}

// ---------------------------------------------------------------------------
// AiAvatarHeader Sub-component
// ---------------------------------------------------------------------------

/** AI channel header with purple-bordered robot avatar. */
function AiChannelHeader({
  channelName,
  onBack,
  onSettings,
}: {
  channelName: string;
  onBack: () => void;
  onSettings: () => void;
}) {
  return (
    <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex-shrink-0 z-10">
      <div className="flex items-center gap-3 px-3 py-3 pt-safe-top">
        <button
          onClick={onBack}
          className="p-2 -ml-1 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback"
        >
          <ArrowLeft size={22} className="text-gray-700 dark:text-gray-300" />
        </button>

        <div
          className="flex-1 min-w-0 flex items-center gap-3 cursor-pointer"
          onClick={onSettings}
        >
          {/* AI Avatar with purple border */}
          <div className="relative w-10 h-10 rounded-full border-2 border-purple-500 bg-purple-50 dark:bg-purple-900/30 flex items-center justify-center flex-shrink-0">
            <Bot size={20} className="text-purple-600 dark:text-purple-400" />
            <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-green-400 rounded-full border-2 border-white dark:border-gray-900" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-gray-900 dark:text-white truncate">
              {channelName}
            </h1>
            <p className="text-[11px] text-purple-500 dark:text-purple-400 flex items-center gap-1">
              <Sparkles size={10} />
              AI Assistant
            </p>
          </div>
        </div>

        <button
          onClick={onSettings}
          className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback"
        >
          <Settings size={20} className="text-gray-500 dark:text-gray-400" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context Banner Sub-component
// ---------------------------------------------------------------------------

/** Banner showing AI has farm data access. */
function AiContextBanner() {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <div className="mx-3 mt-2 flex items-center gap-2 bg-purple-50 dark:bg-purple-900/20 rounded-xl px-3 py-2 border border-purple-100 dark:border-purple-800">
      <Info size={14} className="text-purple-500 flex-shrink-0" />
      <span className="text-xs text-purple-700 dark:text-purple-300 flex-1">
        AI has access to your farm data to provide personalized insights.
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="text-purple-400 hover:text-purple-600 p-1"
      >
        <AlertCircle size={12} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * AiChatPage renders a full-screen AI chat interface for AI-type channels.
 * Extends the standard chat layout with AI-specific features.
 */
export function AiChatPage() {
  const navigate = useNavigate();
  const { channelId } = useParams<{ channelId: string }>();
  const { user } = useAuth();

  // Core messaging hooks
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

  // AI-specific hooks
  const {
    isAiThinking,
    isAiDelayed,
    actions,
    startAiThinking,
    stopAiThinking,
    confirmAction,
    cancelAction,
  } = useAiChat(channelId, channel?.type);

  const [inputText, setInputText] = useState('');
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
  }, [messages.length, isAiThinking]);

  // Detect new AI messages to stop thinking indicator
  useEffect(() => {
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && isAiMessage(lastMsg) && isAiThinking) {
        stopAiThinking();
      }
    }
  }, [messages.length, isAiThinking, stopAiThinking, messages]);

  // iOS keyboard handling
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

  // Infinite scroll for older messages
  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container || !hasNextPage) return;

    if (container.scrollTop < 100) {
      const prevHeight = container.scrollHeight;
      await fetchNextPage();
      requestAnimationFrame(() => {
        const newHeight = container.scrollHeight;
        container.scrollTop = newHeight - prevHeight;
      });
    }
  }, [hasNextPage, fetchNextPage]);

  // Send message handler -- starts AI thinking indicator
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text) return;

    setInputText('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }

    await sendMessage({
      content: text,
      contentType: 'text',
    });

    // Start AI thinking indicator after user sends a message
    startAiThinking();
  }, [inputText, sendMessage, startAiThinking]);

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
      const el = e.target;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    },
    [],
  );

  const handleCopy = useCallback((messageId: string) => {
    const msg = messages.find((m) => m.id === messageId);
    if (msg?.content) {
      navigator.clipboard.writeText(msg.content).catch(() => {});
    }
  }, [messages]);

  const channelName = channel?.name ?? 'AI Assistant';
  const loading = messagesLoading || channelLoading;
  const errorMsg = messagesError
    ? (messagesError instanceof Error ? messagesError.message : 'Failed to load messages')
    : null;

  return (
    <div
      className="flex flex-col h-screen bg-gray-100 dark:bg-gray-950"
      style={{ paddingBottom: 'var(--keyboard-offset, 0px)' }}
    >
      {/* AI-specific header */}
      <AiChannelHeader
        channelName={channelName}
        onBack={() => navigate('/messages')}
        onSettings={() => navigate(`/messages/${channelId}/settings`)}
      />

      {/* Message list */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overscroll-contain"
      >
        {/* Context banner */}
        <AiContextBanner />

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-500" />
          </div>
        ) : errorMsg ? (
          <div className="text-center py-12 px-4">
            <AlertCircle size={40} className="mx-auto mb-3 text-gray-300 opacity-60" />
            <p className="text-sm text-gray-500">{errorMsg}</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-4">
            <div className="w-16 h-16 bg-purple-50 dark:bg-purple-900/20 rounded-full flex items-center justify-center mb-3">
              <Bot size={28} className="text-purple-400" />
            </div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 text-center">
              AI Assistant
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500 text-center mt-1 max-w-xs">
              Ask questions about your farm data, water quality, or request actions.
            </p>
          </div>
        ) : (
          <div className="py-2">
            {messageGroups.map((group) => (
              <div key={group.date}>
                <MessageDateSeparator date={group.date} />
                {group.messages.map((msg) => {
                  const isOwn = msg.senderId === user?.id;
                  const aiMsg = isAiMessage(msg);

                  // Map optimistic status
                  const status = msg._status === 'pending'
                    ? 'pending' as const
                    : msg._status === 'failed'
                      ? 'pending' as const
                      : 'sent' as const;

                  return (
                    <MessageBubble
                      key={msg.id}
                      messageId={msg.id}
                      isOwn={isOwn}
                      senderName={aiMsg ? 'AI Assistant' : undefined}
                      senderColorIndex={aiMsg ? 7 : 0}
                      text={msg.content ?? undefined}
                      timestamp={msg.createdAt}
                      status={isOwn ? status : undefined}
                      isEdited={!!msg.editedAt}
                      isDeleted={msg.isDeleted}
                      isGroup={false}
                      onCopy={handleCopy}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* Action cards from AI */}
        {actions.map((action) => (
          <AiActionCard
            key={action.id}
            actionId={action.id}
            description={action.description}
            status={action.status}
            resultMessage={action.resultMessage}
            onConfirm={confirmAction}
            onCancel={cancelAction}
          />
        ))}

        {/* AI thinking indicator */}
        <AiTypingIndicator visible={isAiThinking} isDelayed={isAiDelayed} />
      </div>

      {/* Input bar */}
      <div className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 flex-shrink-0 pb-safe">
        <div className="flex items-end gap-2 px-3 py-2">
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Ask AI anything..."
            rows={1}
            className="flex-1 bg-gray-100 dark:bg-gray-800 rounded-2xl px-4 py-2.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 outline-none resize-none max-h-[120px] leading-5"
          />

          <button
            onClick={handleSend}
            disabled={!inputText.trim() || isSending || isAiThinking}
            className={clsx(
              'w-12 h-12 rounded-full flex items-center justify-center touch-feedback flex-shrink-0 transition-all',
              inputText.trim() && !isAiThinking
                ? 'bg-purple-500 text-white shadow-md shadow-purple-500/30 active:scale-95'
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
