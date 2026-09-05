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

import { clsx } from 'clsx';
import {
  ArrowLeft,
  Settings,
  Send,
  Bot,
  Droplets,
  Fish,
  BarChart,
  Cpu,
  Info,
  AlertCircle,
  Sparkles,
  Clock,
  WifiOff,
} from 'lucide-react';
import {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { AiActionCard } from '@/components/messaging/AiActionCard';
import { AiTypingIndicator } from '@/components/messaging/AiTypingIndicator';
import { MessageBubble } from '@/components/messaging/MessageBubble';
import { MessageDateSeparator } from '@/components/messaging/MessageDateSeparator';
import { useAiChat } from '@/hooks/useAiChat';
import { useAuth } from '@/hooks/useAuth';
import { useChannelDetail } from '@/hooks/useChannelDetail';
import { useMessages } from '@/hooks/useMessages';
import { useMessageSocket } from '@/hooks/useMessageSocket';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { useSendMessage } from '@/hooks/useSendMessage';
import type { Message } from '@/types/messaging';
import { runAsyncAction } from '@/utils/async-action';
import { getDateLabel } from '@/utils/messaging-helpers';

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

/**
 * Check if a message is from the AI virtual user. The bridge stamps
 * `metadata.isAi` (ai-chat-bridge.service) and, since MSG-HIGH-078, the
 * GraphQL read path carries metadata too — history and live agree.
 */
function isAiMessage(msg: Message): boolean {
  return msg.metadata?.isAi === true;
}

// ---------------------------------------------------------------------------
// Persona Helpers
// ---------------------------------------------------------------------------

/** Map persona icon name to Lucide component. */
const PERSONA_ICONS: Record<string, typeof Bot> = {
  bot: Bot,
  droplets: Droplets,
  fish: Fish,
  'bar-chart': BarChart,
  cpu: Cpu,
};

/** Map persona color to Tailwind classes for header styling. */
const PERSONA_HEADER_COLORS: Record<string, { border: string; avatar: string; icon: string; label: string }> = {
  purple: { border: 'border-purple-500', avatar: 'bg-purple-50 dark:bg-purple-900/30', icon: 'text-purple-600 dark:text-purple-400', label: 'text-purple-500 dark:text-purple-400' },
  cyan: { border: 'border-cyan-500', avatar: 'bg-cyan-50 dark:bg-cyan-900/30', icon: 'text-cyan-600 dark:text-cyan-400', label: 'text-cyan-500 dark:text-cyan-400' },
  blue: { border: 'border-blue-500', avatar: 'bg-blue-50 dark:bg-blue-900/30', icon: 'text-blue-600 dark:text-blue-400', label: 'text-blue-500 dark:text-blue-400' },
  green: { border: 'border-green-500', avatar: 'bg-green-50 dark:bg-green-900/30', icon: 'text-green-600 dark:text-green-400', label: 'text-green-500 dark:text-green-400' },
  orange: { border: 'border-orange-500', avatar: 'bg-orange-50 dark:bg-orange-900/30', icon: 'text-orange-600 dark:text-orange-400', label: 'text-orange-500 dark:text-orange-400' },
};

/** Known persona metadata keyed by persona ID. Used for header enrichment. */
const PERSONA_METADATA: Record<string, { name: string; icon: string; color: string; capabilities: string[] }> = {
  'general': { name: 'General AI Assistant', icon: 'bot', color: 'purple', capabilities: ['General questions', 'Basic guidance', 'Platform help'] },
  'operator-v1': { name: 'Water Quality Specialist', icon: 'droplets', color: 'cyan', capabilities: ['Water quality parameters', 'Sensor readings', 'Ammonia/H2S/CO2 toxicity'] },
  'expert-v1': { name: 'Farm Expert', icon: 'fish', color: 'blue', capabilities: ['Growth analytics', 'Feed optimization', 'Reagent dosing', 'Risk assessment'] },
  'manager-v1': { name: 'Management Assistant', icon: 'bar-chart', color: 'green', capabilities: ['Report generation', 'Analytics', 'Trend analysis', 'Feed management'] },
  'supervisor-v1': { name: 'SCADA AI', icon: 'cpu', color: 'orange', capabilities: ['Autonomous monitoring', 'Equipment actuation', 'PLC control', 'Safety limits'] },
};

// ---------------------------------------------------------------------------
// AiAvatarHeader Sub-component
// ---------------------------------------------------------------------------

/** AI channel header with persona-colored avatar and capabilities tooltip. */
function AiChannelHeader({
  channelName,
  personaId,
  onBack,
  onSettings,
}: {
  channelName: string;
  personaId: string | null | undefined;
  onBack: () => void;
  onSettings: () => void;
}): JSX.Element {
  const [showCapabilities, setShowCapabilities] = useState(false);
  const meta = PERSONA_METADATA[personaId ?? 'general'] ?? PERSONA_METADATA['general'];
  const colors = PERSONA_HEADER_COLORS[meta.color] ?? PERSONA_HEADER_COLORS['purple'];
  const IconComponent = PERSONA_ICONS[meta.icon] ?? Bot;

  return (
    <div className="bg-white dark:bg-gray-900 border-b-2 flex-shrink-0 z-10" style={{ borderColor: 'inherit' }}>
      <div className={clsx('border-b-2', colors.border)}>
        <div className="flex items-center gap-3 px-3 py-3 pt-safe-top">
          <button
            onClick={onBack}
            className="p-2 -ml-1 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback"
          >
            <ArrowLeft size={22} className="text-gray-700 dark:text-gray-300" />
          </button>

          <div
            className="flex-1 min-w-0 flex items-center gap-3 cursor-pointer"
            role="button"
            tabIndex={0}
            onClick={onSettings}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSettings();
              }
            }}
          >
            {/* AI Avatar with persona-colored border */}
            <div className={clsx(
              'relative w-10 h-10 rounded-full border-2 flex items-center justify-center flex-shrink-0',
              colors.border,
              colors.avatar,
            )}>
              <IconComponent size={20} className={colors.icon} />
              <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-green-400 rounded-full border-2 border-white dark:border-gray-900" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-bold text-gray-900 dark:text-white truncate">
                {channelName}
              </h1>
              <p className={clsx('text-[11px] flex items-center gap-1', colors.label)}>
                <Sparkles size={10} />
                {meta.name}
              </p>
            </div>
          </div>

          {/* Capabilities info button */}
          <button
            onClick={() => setShowCapabilities((prev) => !prev)}
            className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback"
            title="View capabilities"
          >
            <Info size={20} className="text-gray-500 dark:text-gray-400" />
          </button>

          <button
            onClick={onSettings}
            className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback"
          >
            <Settings size={20} className="text-gray-500 dark:text-gray-400" />
          </button>
        </div>
      </div>

      {/* Capabilities tooltip panel */}
      {showCapabilities && (
        <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
          <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">
            Capabilities
          </p>
          <div className="flex flex-wrap gap-1">
            {meta.capabilities.map((cap) => (
              <span
                key={cap}
                className={clsx(
                  'text-[10px] px-2 py-0.5 rounded-full font-medium',
                  colors.avatar,
                  colors.icon,
                )}
              >
                {cap}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context Banner Sub-component
// ---------------------------------------------------------------------------

/** Banner showing AI has farm data access. */
function AiContextBanner(): JSX.Element | null {
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
export function AiChatPage(): JSX.Element {
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
  // MOB-HIGH-001: the channel's messages feed the hook — proposal cards derive
  // from the AI messages carrying status:'proposed' metadata (server truth).
  const {
    isAiThinking,
    isAiDelayed,
    actions,
    startAiThinking,
    stopAiThinking,
    confirmAction,
    cancelAction,
  } = useAiChat(channelId, channel?.type, messages);

  const isOnline = useNetworkStatus();
  // WHY: Track whether the last user message was queued offline so we can show
  // a "message queued" indicator instead of the AI thinking spinner. AI cannot
  // process a message that hasn't reached the server yet.
  const [isMessageQueued, setIsMessageQueued] = useState(false);

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

  // WHY: When connectivity returns, clear the queued message banner.
  // The offline queue's auto-sync will send the queued message, and the
  // AI thinking indicator will be triggered by the next confirmed send.
  useEffect(() => {
    if (isOnline && isMessageQueued) {
      setIsMessageQueued(false);
    }
  }, [isOnline, isMessageQueued]);

  // iOS keyboard handling
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const handleResize = (): void => {
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

  // Send message handler -- starts AI thinking indicator only when online.
  // WHY: When offline, the message is queued but not actually delivered to the
  // AI backend. Showing "AI is thinking..." would be dishonest because the AI
  // cannot process a message it has not received. Instead, we track the queued
  // state and show a pending indicator.
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text) return;

    setInputText('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }

    await sendMessage({
      content: text,
      // S1-CODEGEN: MessageContentType wire form is the UPPERCASE GraphQL enum NAME.
      contentType: 'TEXT',
    });

    if (isOnline) {
      // Only show AI thinking indicator when the message was actually sent to
      // the server. The AI can only start processing after receiving the message.
      setIsMessageQueued(false);
      startAiThinking();
    } else {
      // Message was queued offline — do NOT start AI thinking indicator
      setIsMessageQueued(true);
    }
  }, [inputText, sendMessage, startAiThinking, isOnline]);

  // Handle Enter key to send (Shift+Enter for newline)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runAsyncAction(handleSend, 'ai-chat-send');
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
      navigator.clipboard.writeText(msg.content).catch(() => {
        /* intentional no-op: clipboard copy is a best-effort convenience;
           a denied/unsupported Clipboard API must not surface an error. */
      });
    }
  }, [messages]);

  const personaMeta = PERSONA_METADATA[channel?.aiPersona ?? 'general'] ?? PERSONA_METADATA['general'];
  const channelName = channel?.name ?? personaMeta.name;
  const loading = messagesLoading || channelLoading;
  const errorMsg = messagesError
    ? (messagesError instanceof Error ? messagesError.message : 'Failed to load messages')
    : null;

  return (
    <div
      className="flex flex-col h-screen bg-gray-100 dark:bg-gray-950"
      style={{ paddingBottom: 'var(--keyboard-offset, 0px)' }}
    >
      {/* AI-specific header — persona-aware */}
      <AiChannelHeader
        channelName={channelName}
        personaId={channel?.aiPersona}
        onBack={() => navigate('/messages')}
        onSettings={() => navigate(`/messages/${channelId}/settings`)}
      />

      {/* Message list */}
      <div
        ref={scrollContainerRef}
        onScroll={() => { void handleScroll(); }}
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
            {(() => {
              const EmptyIcon = PERSONA_ICONS[personaMeta.icon] ?? Bot;
              const emptyColors = PERSONA_HEADER_COLORS[personaMeta.color] ?? PERSONA_HEADER_COLORS['purple'];
              return (
                <>
                  <div className={clsx('w-16 h-16 rounded-full flex items-center justify-center mb-3', emptyColors.avatar)}>
                    <EmptyIcon size={28} className={emptyColors.icon} />
                  </div>
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 text-center">
                    {personaMeta.name}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 text-center mt-1 max-w-xs">
                    {channel?.aiPersona
                      ? `Specialized in: ${personaMeta.capabilities.join(', ')}`
                      : 'Ask questions about your farm data, water quality, or request actions.'}
                  </p>
                </>
              );
            })()}
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

        {/* Action cards from AI — Confirm runs the real confirmAiAction
            mutation (MOB-HIGH-001); void adapts the async handler to the
            card's sync callback contract (no floating promise). */}
        {actions.map((action) => (
          <AiActionCard
            key={action.id}
            actionId={action.id}
            description={action.description}
            status={action.status}
            resultMessage={action.resultMessage}
            onConfirm={(id) => void confirmAction(id)}
            onCancel={cancelAction}
          />
        ))}

        {/* WHY: When the user's message was queued offline, show a pending
         * banner instead of the AI thinking indicator. This is honest UX:
         * the AI cannot think about a message it has not yet received. */}
        {isMessageQueued && !isOnline && (
          <div className="mx-3 my-2 flex items-center gap-2 bg-amber-50 dark:bg-amber-900/20 rounded-xl px-3 py-2 border border-amber-100 dark:border-amber-800">
            <Clock size={14} className="text-amber-500 flex-shrink-0" />
            <span className="text-xs text-amber-700 dark:text-amber-300 flex-1">
              Message queued -- AI will respond when you are back online.
            </span>
          </div>
        )}

        {/* AI thinking indicator -- only shown when message was actually sent */}
        <AiTypingIndicator visible={isAiThinking} isDelayed={isAiDelayed} />
      </div>

      {/* Input bar */}
      <div className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 flex-shrink-0 pb-safe">
        {/* WHY: Offline banner above the input tells the user that AI requires
         * connectivity. Messages can still be queued, but the AI won't respond
         * until the message actually reaches the server. */}
        {!isOnline && (
          <div className="flex items-center gap-2 px-4 py-1.5 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-100 dark:border-amber-800">
            <WifiOff size={12} className="text-amber-500 flex-shrink-0" />
            <span className="text-[11px] text-amber-600 dark:text-amber-400">
              Offline -- messages will be queued and AI will respond when connected
            </span>
          </div>
        )}
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

          {/* WHY: When offline, the send button uses amber styling with a clock
           * icon to indicate "Queue" semantics, matching the MessageInput pattern. */}
          <button
            onClick={() => { runAsyncAction(handleSend, 'ai-chat-send'); }}
            disabled={!inputText.trim() || isSending || isAiThinking}
            className={clsx(
              'w-12 h-12 rounded-full flex items-center justify-center touch-feedback flex-shrink-0 transition-all',
              inputText.trim() && !isAiThinking
                ? isOnline
                  ? 'bg-purple-500 text-white shadow-md shadow-purple-500/30 active:scale-95'
                  : 'bg-amber-500 text-white shadow-md shadow-amber-500/30 active:scale-95'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500',
            )}
            aria-label={isOnline ? 'Send to AI' : 'Queue message for later'}
          >
            {isSending ? (
              <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
            ) : isOnline ? (
              <Send size={20} />
            ) : (
              <Clock size={20} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
