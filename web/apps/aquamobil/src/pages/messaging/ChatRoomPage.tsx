/**
 * ChatRoomPage -- WhatsApp-style real-time chat room.
 * Supports infinite scroll, optimistic send, typing indicators, and iOS keyboard handling.
 */

import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Settings, Send, ChevronDown, AlertCircle, X } from 'lucide-react';
import { useState, useCallback, useMemo, useEffect, useRef, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { AttachmentPicker } from '@/components/messaging/AttachmentPicker';
import { ChannelAvatar } from '@/components/messaging/ChannelAvatar';
import { ForwardModal } from '@/components/messaging/ForwardModal';
import { MessageBubble } from '@/components/messaging/MessageBubble';
import { MessageDateSeparator } from '@/components/messaging/MessageDateSeparator';
import { MessageInput } from '@/components/messaging/MessageInput';
import { TypingIndicator } from '@/components/messaging/TypingIndicator';
import { Button, EmptyState, IconButton, Skeleton } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { useChannelDetail } from '@/hooks/useChannelDetail';
import { useEditMessage } from '@/hooks/useEditMessage';
import { useMarkRead } from '@/hooks/useMarkRead';
import { useMediaUpload } from '@/hooks/useMediaUpload';
import { useMessages } from '@/hooks/useMessages';
import { useMessageSocket } from '@/hooks/useMessageSocket';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useSendMessage } from '@/hooks/useSendMessage';
import { useTypingIndicator } from '@/hooks/useTypingIndicator';
import { putPendingBlob } from '@/pwa/offline-queue';
import type { Message } from '@/types/messaging';
import { runAsyncAction } from '@/utils/async-action';
import { getDateLabel, getUserDisplayName } from '@/utils/messaging-helpers';
import { messagesFamilyKey } from '@/utils/messaging-query-keys';

/**
 * Distance (px) from the bottom of the scroll container within which the
 * newest message is considered "in view" for read-cursor purposes. A small
 * slack absorbs sub-pixel rounding and momentum scrolling on mobile.
 */
const SCROLL_BOTTOM_THRESHOLD_PX = 80;

/** Group messages by date for rendering date separators. */
function groupMessagesByDate(messages: Message[]): Array<{ date: string; messages: Message[] }> {
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
export function ChatRoomPage(): JSX.Element {
  const navigate = useNavigate();
  const { channelId } = useParams<{ channelId: string }>();
  const { user, tenantId } = useAuth();
  const queryClient = useQueryClient();

  // Real hooks -- wired to backend
  const { isConnected, joinChannel, leaveChannel, socketRef } = useMessageSocket();
  const {
    messages,
    isLoading: messagesLoading,
    error: messagesError,
    fetchNextPage,
    hasNextPage,
  } = useMessages(channelId, socketRef);
  const { channel, isLoading: channelLoading } = useChannelDetail(channelId);
  const { sendMessage, isSending } = useSendMessage(channelId);
  const { editMessage } = useEditMessage(channelId);
  const { markRead } = useMarkRead(channelId);
  const { stopTyping, typingUsers } = useTypingIndicator(channelId, socketRef, user?.id);
  const { uploadMedia, isUploading } = useMediaUpload(channelId);
  const isOnline = useNetworkStatus();
  const { addToQueue } = useOfflineQueue();

  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  // MSG-MEDIUM-053: the message currently being edited. Mutually exclusive with
  // replyingTo — entering edit mode clears any active reply. MessageInput is
  // internally stateful with no edit-mode prop, so we reuse its onSend channel:
  // while editingMessage is set, the next submitted text is routed to the
  // editMessage producer instead of sendMessage.
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [forwardingMessage, setForwardingMessage] = useState<Message | null>(null);
  const [isAttachmentPickerOpen, setIsAttachmentPickerOpen] = useState(false);
  // MSG-MEDIUM-055: non-blocking disclosure shown when media is queued offline,
  // replacing the blocking alert() that simply discarded the attachment.
  const [offlineMediaNotice, setOfflineMediaNotice] = useState<string | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isLoadingMoreRef = useRef(false);

  // Read-state trigger (Wave-6 M2). We only advance the read cursor when the
  // user has actually SEEN the newest message: the list is scrolled to the
  // bottom AND the document is visible (foreground tab / app). Scrolled-up
  // history reading must NOT mark the newest message read.
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [isDocVisible, setIsDocVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  // Dedup the read cursor: only fire markRead when the newest readable message
  // id changes. The server handler is idempotent, but this avoids redundant
  // mutations on every scroll/visibility tick and breaks the
  // invalidate → refetch → effect feedback loop (refetch returns the same
  // newest id, so no re-fire).
  const lastMarkedRef = useRef<string | null>(null);

  // Join/leave channel room for socket events
  useEffect(() => {
    if (channelId && isConnected) {
      joinChannel(channelId);
      return () => {
        leaveChannel(channelId);
      };
    }
  }, [channelId, isConnected, joinChannel, leaveChannel]);

  // Reset the read-cursor dedup when switching channels so the first readable
  // message in the newly-opened channel always triggers a mark-read.
  useEffect(() => {
    lastMarkedRef.current = null;
  }, [channelId]);

  // MSG-MEDIUM-055: auto-dismiss the non-blocking offline-media toast after a
  // few seconds so it never lingers; the user can also dismiss it manually.
  useEffect(() => {
    if (!offlineMediaNotice) return;
    const timer = window.setTimeout(() => setOfflineMediaNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [offlineMediaNotice]);

  // Track foreground visibility — a backgrounded tab must not mark messages read.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = (): void => setIsDocVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Group messages by date
  const messageGroups = useMemo(() => groupMessagesByDate(messages), [messages]);

  // Newest server-persisted message id. Optimistic sends (_status
  // 'pending'/'failed') are skipped — they have no server row yet, so
  // markMessagesRead would 404 on them. The cursor advances to this id
  // regardless of sender: the server unread subquery counts a member's OWN
  // messages after lastReadAt too, so the badge only clears once lastReadAt
  // passes the newest message (mine included).
  const lastReadableMessageId = useMemo<string | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m._status !== 'pending' && m._status !== 'failed') {
        return m.id;
      }
    }
    return null;
  }, [messages]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
      // We just pinned the view to the newest message — record at-bottom
      // deterministically rather than relying on the programmatic scroll to
      // re-fire onScroll.
      setIsAtBottom(true);
    }
  }, [messages.length]);

  // Wave-6 M2: advance the read cursor when the user has actually seen the
  // newest message (at the bottom AND foreground). markRead never throws — it
  // degrades to the offline queue — so this is fire-and-forget; lastMarkedRef
  // dedups repeat fires and breaks the invalidate→refetch→effect loop.
  useEffect(() => {
    if (!channelId || !lastReadableMessageId) return;
    if (!isAtBottom || !isDocVisible) return;
    if (lastMarkedRef.current === lastReadableMessageId) return;
    lastMarkedRef.current = lastReadableMessageId;
    void markRead(lastReadableMessageId);
  }, [channelId, lastReadableMessageId, isAtBottom, isDocVisible, markRead]);

  // Infinite scroll -- load older messages when scrolling to top; also track
  // whether the newest message is in view for the read-cursor trigger above.
  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    setIsAtBottom(distanceFromBottom < SCROLL_BOTTOM_THRESHOLD_PX);

    if (!hasNextPage || isLoadingMoreRef.current) return;

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

  // Context menu actions
  const handleReply = useCallback(
    (messageId: string) => {
      const msg = messages.find((m) => m.id === messageId);
      if (msg) {
        setReplyingTo(msg);
      }
    },
    [messages],
  );

  const handleCopy = useCallback(
    (messageId: string) => {
      const msg = messages.find((m) => m.id === messageId);
      if (msg?.content) {
        navigator.clipboard.writeText(msg.content).catch(() => {
          /* intentional no-op: clipboard copy is a best-effort convenience;
           a denied/unsupported Clipboard API must not surface an error. */
        });
      }
    },
    [messages],
  );

  /** Open ForwardModal for the selected message. */
  const handleForward = useCallback(
    (messageId: string) => {
      const msg = messages.find((m) => m.id === messageId);
      if (msg) {
        setForwardingMessage(msg);
      }
    },
    [messages],
  );

  const handleOpenImage = useCallback(
    (attachmentId: string) => {
      if (!channelId) return;
      navigate(`/messages/${channelId}/media/${attachmentId}`);
    },
    [channelId, navigate],
  );

  /**
   * MSG-MEDIUM-053: enter edit mode for the selected own message. Editing and
   * replying are mutually exclusive composer modes, so entering edit clears any
   * active reply. The next text submitted via MessageInput is routed to the
   * editMessage producer (online mutation or offline queue) in onSend below.
   */
  const handleEdit = useCallback(
    (messageId: string) => {
      const msg = messages.find((m) => m.id === messageId);
      if (msg) {
        setReplyingTo(null);
        setEditingMessage(msg);
      }
    },
    [messages],
  );

  /** Delete a message via deleteMessage GraphQL mutation (soft-delete). */
  const handleDelete = useCallback(
    async (messageId: string) => {
      if (!channelId) return;
      if (isOnline) {
        const { graphqlRequest } = await import('@/services/authenticated-fetch');
        const { DELETE_MESSAGE } = await import('@/graphql/messaging-operations');
        await graphqlRequest(DELETE_MESSAGE, { id: messageId });
        // Invalidate the message cache so the deleted message disappears. The
        // refetch is fire-and-forget — the UI updates reactively once the cache
        // settles. MSG-CRITICAL-055: use the messages-FAMILY prefix, not
        // `(...,'messages',channelId)` — the latter puts channelId in the user.id
        // slot and prefix-fails to match the reader key, so the invalidation never
        // fired. `messagesFamilyKey` prefix-matches every user/channel variant.
        void queryClient.invalidateQueries({
          queryKey: messagesFamilyKey(tenantId),
        });
      } else {
        // Queue for offline sync — the main queue supports 'deleteMessage'
        await addToQueue('deleteMessage', { id: messageId });
      }
    },
    [channelId, isOnline, addToQueue, queryClient, tenantId],
  );

  /**
   * MSG-MEDIUM-055: enqueue a media blob on the binary offline lane. Persists the
   * blob in the encrypted tenant-scoped store and queues an 'uploadAndSendMessage'
   * op whose in-app replay (on reconnect) presigns → PUTs → sends. The threaded
   * idempotencyKey makes that send at-most-once. Returns true if queued.
   */
  const enqueueOfflineMedia = useCallback(
    async (
      blob: Blob,
      contentType: 'IMAGE' | 'FILE' | 'VOICE',
      filename: string,
      mimeType: string,
      durationSeconds?: number,
    ): Promise<boolean> => {
      if (!channelId || !tenantId) return false;
      const blobId = await putPendingBlob(tenantId, blob);
      const idempotencyKey = crypto.randomUUID();
      await addToQueue(
        'uploadAndSendMessage',
        {
          blobId,
          channelId,
          contentType,
          filename,
          mimeType,
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          idempotencyKey,
        },
        // FARM-HIGH-057 pattern: thread a stable at-most-once command id so the
        // online attempt (none here) and the queued replay are one logical command.
        idempotencyKey,
      );
      return true;
    },
    [channelId, tenantId, addToQueue],
  );

  /**
   * Handle file selection from the AttachmentPicker. Online: upload via presigned
   * URL then send. Offline (MSG-MEDIUM-055): persist the blob and queue an
   * upload-and-send op for replay on reconnect — instead of the old blocking
   * alert() that discarded the attachment.
   */
  const handleFileSelect = useCallback(
    async (file: File) => {
      if (!channelId) return;
      // S1-CODEGEN: MessageContentType wire form is the UPPERCASE GraphQL enum NAME.
      const contentType = file.type.startsWith('image/') ? 'IMAGE' : 'FILE';
      if (!isOnline) {
        try {
          await enqueueOfflineMedia(file, contentType, file.name, file.type);
          setOfflineMediaNotice('Attachment queued — it will send when you are back online.');
        } catch (err) {
          setOfflineMediaNotice(
            err instanceof Error ? err.message : 'Could not queue attachment for offline send.',
          );
        }
        return;
      }
      try {
        const storageKey = await uploadMedia(file);
        await sendMessage({
          content: null,
          contentType,
          attachmentKeys: [storageKey],
        });
      } catch {
        // uploadMedia already sets error state — the UI will show it
      }
    },
    [channelId, isOnline, enqueueOfflineMedia, uploadMedia, sendMessage],
  );

  /**
   * Handle completed voice recording. Online: upload then send. Offline
   * (MSG-MEDIUM-055): persist the audio blob and queue an upload-and-send op.
   */
  const handleVoiceRecordingComplete = useCallback(
    async (blob: Blob, durationSeconds: number, mimeType: string) => {
      if (!channelId) return;
      const extension = mimeType.includes('webm')
        ? 'webm'
        : mimeType.includes('ogg')
          ? 'ogg'
          : 'mp4';
      const filename = `voice-note.${extension}`;
      if (!isOnline) {
        try {
          await enqueueOfflineMedia(blob, 'VOICE', filename, mimeType, durationSeconds);
          setOfflineMediaNotice('Voice message queued — it will send when you are back online.');
        } catch (err) {
          setOfflineMediaNotice(
            err instanceof Error ? err.message : 'Could not queue voice message for offline send.',
          );
        }
        return;
      }
      try {
        // Convert Blob to File for useMediaUpload which expects a File
        const file = new File([blob], filename, { type: mimeType });
        const storageKey = await uploadMedia(file);
        await sendMessage({
          content: null,
          contentType: 'VOICE',
          attachmentKeys: [storageKey],
          metadata: { durationSeconds },
        });
      } catch {
        // uploadMedia already sets error state
      }
    },
    [channelId, isOnline, enqueueOfflineMedia, uploadMedia, sendMessage],
  );

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

  const statusText =
    channel?.type === 'direct'
      ? isOtherOnline
        ? 'Online'
        : 'Offline'
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
    ? messagesError instanceof Error
      ? messagesError.message
      : 'Failed to load messages'
    : null;

  return (
    // The page ground comes from <body>, so no background is set here.
    <div
      className="flex flex-col h-screen"
      style={{ paddingBottom: 'var(--keyboard-offset, 0px)' }}
    >
      {/* Header. NOT the shared AppHeader: a chat header carries the channel
          avatar, the presence line and a tap target that opens settings, none of
          which AppHeader models — it renders a brand mark or a back chevron and
          a plain string title. Swapping it in would cost the avatar. */}
      <div className="bg-surface-1 border-b border-line flex-shrink-0 z-10">
        <div className="flex items-center gap-3 px-3 py-3 pt-safe-top">
          {/* IconButton supplies the touch floor and the accessible name this
              icon-only control was missing. */}
          <IconButton
            size="lg"
            onClick={() => navigate('/messages')}
            className="-ml-1 hover:bg-surface-2"
            aria-label="Back to messages"
          >
            <ArrowLeft size={22} className="text-ink-2" />
          </IconButton>

          <div
            className="flex-1 min-w-0 flex items-center gap-3 cursor-pointer"
            role="button"
            tabIndex={0}
            onClick={() => navigate(`/messages/${channelId}/settings`)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                navigate(`/messages/${channelId}/settings`);
              }
            }}
          >
            <ChannelAvatar
              type={avatarType}
              name={displayName}
              imageUrl={channel?.avatarUrl ?? undefined}
              isOnline={isOtherOnline}
              size="sm"
            />
            <div className="min-w-0">
              <h1 className="text-title font-bold text-ink-1 truncate">{displayName}</h1>
              {/* text-meta is 12px, the sunlight floor — it replaces an 11px
                  arbitrary size, so it LOWERS the tiny-text ratchet. */}
              {statusText && <p className="text-meta text-ink-3">{statusText}</p>}
            </div>
          </div>

          <IconButton
            size="lg"
            onClick={() => navigate(`/messages/${channelId}/settings`)}
            className="hover:bg-surface-2"
            aria-label="Channel settings"
          >
            <Settings size={20} className="text-ink-2" />
          </IconButton>
        </div>
      </div>

      {/* Message list */}
      <div
        ref={scrollContainerRef}
        onScroll={() => {
          void handleScroll();
        }}
        className="flex-1 overflow-y-auto overscroll-contain"
      >
        {hasNextPage && (
          <div className="flex justify-center py-3">
            <Button
              variant="ghost"
              onClick={() => {
                void fetchNextPage();
              }}
              className="text-acc text-body px-3"
            >
              <ChevronDown size={14} className="rotate-180" />
              Load older messages
            </Button>
          </div>
        )}

        {loading ? (
          <div className="px-4 py-6">
            <Skeleton variant="row" count={4} />
          </div>
        ) : errorMsg ? (
          // tone="error" announces itself and takes the alarm tile, so a failed
          // history fetch never reads as an empty channel.
          <EmptyState
            tone="error"
            icon={<AlertCircle size={22} />}
            title="Could not load messages"
            description={errorMsg}
          />
        ) : messages.length === 0 ? (
          <EmptyState icon={<Send size={22} />} title="No messages yet" description="Say hello!" />
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

                  const senderName = msg.sender ? getUserDisplayName(msg.sender) : undefined;

                  // Build reply preview from parentId
                  const replyPreview = msg.parentId
                    ? (() => {
                        const parent = messages.find((m) => m.id === msg.parentId);
                        if (!parent) return undefined;
                        return {
                          senderName: parent.sender ? getUserDisplayName(parent.sender) : 'Unknown',
                          text: parent.content ?? '',
                        };
                      })()
                    : undefined;

                  // Map attachment data
                  const firstAttachment = msg.attachments?.[0];
                  const image =
                    msg.contentType === 'IMAGE' && firstAttachment
                      ? {
                          url: firstAttachment.downloadUrl ?? '',
                          thumbnailUrl: firstAttachment.thumbnailUrl ?? undefined,
                          width: firstAttachment.width ?? undefined,
                          height: firstAttachment.height ?? undefined,
                        }
                      : undefined;
                  const file =
                    msg.contentType === 'FILE' && firstAttachment
                      ? {
                          name: firstAttachment.originalFilename,
                          size: `${Math.round(firstAttachment.fileSize / 1024)}KB`,
                          url: firstAttachment.downloadUrl ?? '',
                        }
                      : undefined;

                  // Map optimistic status to delivery status
                  const status =
                    msg._status === 'pending'
                      ? ('pending' as const)
                      : msg._status === 'failed'
                        ? ('pending' as const)
                        : msg.receipts?.some((r) => r.status === 'READ')
                          ? ('read' as const)
                          : msg.receipts?.some((r) => r.status === 'DELIVERED')
                            ? ('delivered' as const)
                            : ('sent' as const);

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
                      contentType={msg.contentType}
                      isEdited={!!msg.editedAt}
                      isDeleted={msg.isDeleted}
                      isGroup={channel?.type === 'group'}
                      replyTo={replyPreview}
                      image={image}
                      onImageOpen={
                        image && firstAttachment
                          ? () => handleOpenImage(firstAttachment.id)
                          : undefined
                      }
                      file={file}
                      attachments={msg.attachments ?? undefined}
                      onReply={handleReply}
                      onCopy={handleCopy}
                      onForward={handleForward}
                      onEdit={
                        isOwn && msg.contentType === 'TEXT' && !msg.isDeleted
                          ? handleEdit
                          : undefined
                      }
                      onDelete={
                        isOwn
                          ? (messageId) => {
                              void handleDelete(messageId);
                            }
                          : undefined
                      }
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

      {/* MessageInput component (replaces inline textarea/buttons) */}
      {/* WHY: isOnline is passed so MessageInput can show "Queue" instead of
       * "Send" when offline, giving the user honest feedback about delivery. */}
      <MessageInput
        onSend={(text) => {
          stopTyping();
          // MSG-MEDIUM-053: in edit mode the submitted text replaces the edited
          // message via the editMessage producer (online mutation or offline
          // queue); otherwise it is a fresh send. Both clear their composer mode.
          if (editingMessage) {
            const editedId = editingMessage.id;
            setEditingMessage(null);
            void editMessage(editedId, text);
            return;
          }
          setReplyingTo(null);
          // WHY runAsyncAction (not plain void): a send failure is already
          // surfaced in the UI via the optimistic message's _status: 'failed'
          // (useSendMessage's onError) — this only closes the separate gap
          // that mutateAsync()'s own promise rejection would otherwise become
          // an unhandled rejection on top of that.
          runAsyncAction(
            () =>
              sendMessage({
                content: text,
                // S1-CODEGEN: MessageContentType wire form is the UPPERCASE GraphQL enum NAME.
                contentType: 'TEXT',
                parentId: replyingTo?.id,
              }),
            'chat-send-message',
          );
        }}
        onAttachmentPress={() => {
          // MSG-MEDIUM-055: attachments are now supported offline via the binary
          // queue lane, so the picker opens regardless of connectivity. When
          // offline, handleFileSelect persists the blob and queues an
          // upload-and-send op (replayed on reconnect) instead of discarding it.
          setIsAttachmentPickerOpen(true);
        }}
        onVoiceRecordingComplete={(blob, durationSeconds, mimeType) => {
          // MSG-MEDIUM-055: offline voice notes are queued (not discarded) —
          // handleVoiceRecordingComplete persists the audio blob and enqueues an
          // upload-and-send op when offline.
          void handleVoiceRecordingComplete(blob, durationSeconds, mimeType);
        }}
        replyTo={
          editingMessage
            ? {
                // MSG-MEDIUM-053: reuse the preview bar to show the original
                // text being edited (MessageInput has no edit-mode prop), so
                // the operator sees what they are replacing before retyping.
                messageId: editingMessage.id,
                senderName: 'Editing message',
                text: editingMessage.content ?? '',
              }
            : replyingTo
              ? {
                  messageId: replyingTo.id,
                  senderName: replyingTo.sender ? getUserDisplayName(replyingTo.sender) : 'Unknown',
                  text: replyingTo.content ?? '',
                }
              : null
        }
        onCancelReply={() => {
          setReplyingTo(null);
          setEditingMessage(null);
        }}
        channelMembers={channel?.members ?? []}
        disabled={isSending || isUploading}
        isOnline={isOnline}
      />

      {/* Attachment picker bottom sheet */}
      <AttachmentPicker
        isOpen={isAttachmentPickerOpen}
        onClose={() => setIsAttachmentPickerOpen(false)}
        onFileSelect={(file) => {
          void handleFileSelect(file);
        }}
      />

      {/* Forward modal */}
      {forwardingMessage && (
        <ForwardModal
          message={forwardingMessage}
          onClose={() => setForwardingMessage(null)}
          visible={!!forwardingMessage}
        />
      )}

      {/* MSG-MEDIUM-055: non-blocking offline-media disclosure. Replaces the
          blocking alert() that discarded the attachment — a self-dismissing
          status toast (auto-clears via the effect above) with an explicit
          dismiss button, telling the worker their media is queued and will send
          on reconnect. */}
      {offlineMediaNotice && (
        <div
          role="status"
          className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 max-w-[90%] bg-surface-3 text-ink-1 text-body rounded-2xl border border-line-strong px-4 py-2 shadow-token flex items-center gap-2"
        >
          {/* Amber, because "queued until you are back online" is a watch
              condition — the send has not failed, it has not happened yet. */}
          <AlertCircle size={16} className="flex-shrink-0 text-warn" />
          <span>{offlineMediaNotice}</span>
          <IconButton
            aria-label="Dismiss"
            className="ml-1 hover:bg-surface-2"
            onClick={() => setOfflineMediaNotice(null)}
          >
            <X size={16} className="text-ink-2" />
          </IconButton>
        </div>
      )}
    </div>
  );
}
