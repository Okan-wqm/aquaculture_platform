/**
 * Messaging Page — the internal note delivered to the customer, the broadcast
 * that could only ever 400, and six writes that failed in silence
 * (ADMIN-CRITICAL-157 / ADMIN-HIGH-121).
 *
 * This is the platform's one admin↔tenant conversation surface, and almost
 * nothing on it did what it said:
 *
 *  - **The internal-note toggle was never sent.** The composer had a working
 *    Internal Note / Public Message switch, styled the draft yellow, and then
 *    posted `{ content, senderName }` — no `isInternal`. `AddMessageDto`
 *    accepts the field and the column defaults to `false`, so every internal
 *    note an admin has ever written about a customer was delivered INTO that
 *    customer's thread as an ordinary message.
 *  - **Every broadcast answered 400.** The Bulk Message dialog previewed
 *    "This message will be sent to all active tenants" and sent neither
 *    `tenantIds` nor `targetCriteria` — the one combination
 *    `sendBulkMessage` refuses. The refusal went to `console.error`, so the
 *    dialog just sat there. The reply it never got carries `sent` and
 *    `failed`, and was typed `void`.
 *  - **The platform's own replies rendered as the tenant's.** The page keyed
 *    alignment, colour and the read receipt on `senderType === 'super_admin'`.
 *    admin-api writes `'admin'`; `'super_admin'` belongs to the OTHER support
 *    stack (auth-service's GraphQL subgraph). The test was false for every
 *    message ever written, so an operator read their own outbound replies as
 *    inbound customer messages, and no receipt ever drew.
 *  - **Every attachment was a nameless "NaN MB" link**, the wire's `fileName`
 *    and `fileSize` read as `filename` and `size`.
 *  - **Every message was signed "Admin"**, a literal the page sent beside a
 *    `// TODO: Use actual admin name` — and the handler preferred it over the
 *    authenticated user.
 *  - **A thread longer than 50 messages showed its oldest 50** and said so
 *    nowhere, under a header printing the real `messageCount` from a different
 *    query.
 *  - **Six writes and two reads were swallowed** into `console.error`: send,
 *    close, reopen, archive, create thread, broadcast, the stats read and the
 *    mark-as-read.
 *
 * The reads and writes now go through the data layer (`useAdminQuery` /
 * `useAdminMutation` + `adminKeys`), so a reply refreshes the thread list and
 * the unread counts without a reload, the requests carry abort signals, and
 * `QueryFailureNotice` reports what failed. This is the LAST page of
 * ADMIN-HIGH-121's migration; `admin-panel-unmigrated-reads.yaml` goes with it.
 *
 * Two decorative buttons are gone rather than left: a paperclip that opened no
 * file picker (there is no attachment-upload route — `attachments` can only be
 * set by a caller that already has a stored file) and a `MoreVertical` menu
 * that had no menu.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, Spinner, PageHeader } from '@aquaculture/shared-ui';
import {
  MessageSquare,
  Send,
  Users,
  Search,
  Archive,
  Paperclip,
  AlertCircle,
  Plus,
  RefreshCw,
  Inbox,
} from 'lucide-react';
import {
  supportApi,
  type BulkMessageAudience,
  type BulkMessageResult,
  type MessageThreadSummary,
  type SupportMessage,
} from '../services/adminApi';
import { adminKeys, useAdminMutation, useAdminQuery } from '../hooks';
import { QueryFailureNotice } from '../components/QueryFailureNotice';
import { TenantSelect } from '../components/TenantSelect';

// ============================================================================
// Constants
// ============================================================================

/** Threads per list read. The list shows its total, so the cap is visible. */
const THREAD_PAGE_SIZE = 100;

/** Messages per page. Mirrors `MessagingService.getMessages`'s own default. */
const MESSAGE_PAGE_SIZE = 50;

// ============================================================================
// Helpers
// ============================================================================

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const diff = Date.now() - date.getTime();
  const hours = diff / (1000 * 60 * 60);

  if (hours < 1) return `${Math.round(diff / (1000 * 60))}m ago`;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  if (hours < 48) return 'Yesterday';
  return date.toLocaleDateString();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The average response time, or an em dash.
 *
 * `null` means no admin has ever answered a tenant, and the card used to draw
 * that as `0m` — an instant reply from a platform that has never replied.
 */
function formatAvgResponse(minutes: number | null): string {
  if (minutes === null) return '—';
  return minutes > 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`;
}

/** Whether this message was written by the platform side of the conversation. */
function isFromPlatform(message: SupportMessage): boolean {
  return message.senderType === 'admin';
}

// ============================================================================
// Component
// ============================================================================

export const MessagingPage: React.FC = () => {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [showNewThreadModal, setShowNewThreadModal] = useState(false);
  const [lastBroadcast, setLastBroadcast] = useState<BulkMessageResult | null>(null);
  /** The page the operator asked for. `null` means "the newest one". */
  const [requestedMessagePage, setRequestedMessagePage] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ── Reads ──

  const threadFilters = useMemo(() => {
    const filters: { limit: number; status?: string; hasUnread?: string } = {
      limit: THREAD_PAGE_SIZE,
    };
    if (statusFilter !== 'all') filters.status = statusFilter;
    if (showUnreadOnly) filters.hasUnread = 'true';
    return filters;
  }, [statusFilter, showUnreadOnly]);

  const threadsQuery = useAdminQuery(adminKeys.messaging.threads(threadFilters), ({ signal }) =>
    supportApi.getMessageThreads(threadFilters, signal),
  );

  const statsQuery = useAdminQuery(adminKeys.messaging.stats(), ({ signal }) =>
    supportApi.getMessagingStats(signal),
  );

  const threads: readonly MessageThreadSummary[] = threadsQuery.data?.data ?? [];
  const threadTotal = threadsQuery.data?.total ?? 0;

  /**
   * The open thread, DERIVED from the list rather than held beside it.
   *
   * A local copy is what forced the old page to hand-patch `isClosed` after
   * every close and reopen, so the header and the list could disagree about
   * the same thread. The list is invalidated by those writes; the header
   * follows it.
   */
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;

  const messagePage = requestedMessagePage ?? 1;

  const messagesQuery = useAdminQuery(
    adminKeys.messaging.messages(selectedThreadId ?? 'none', messagePage),
    ({ signal }) =>
      supportApi.getThreadMessages(
        selectedThreadId as string,
        { page: messagePage, limit: MESSAGE_PAGE_SIZE },
        signal,
      ),
    { enabled: selectedThreadId !== null },
  );

  const messages: readonly SupportMessage[] = messagesQuery.data?.data ?? [];
  const messageTotal = messagesQuery.data?.total ?? 0;
  const messageTotalPages = messagesQuery.data?.totalPages ?? 1;

  // Opening a conversation means seeing its newest messages. The route orders
  // oldest-first, so page 1 of a long thread is the part nobody needs.
  useEffect(() => {
    if (requestedMessagePage === null && messageTotalPages > 1) {
      setRequestedMessagePage(messageTotalPages);
    }
  }, [requestedMessagePage, messageTotalPages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Writes ──

  const markReadMutation = useAdminMutation(
    (threadId: string) => supportApi.markAsRead(threadId),
    {
      invalidateKeys: [adminKeys.messaging.all(), adminKeys.messaging.stats()],
    },
  );

  /**
   * Clear the unread badge once the messages are actually on screen.
   *
   * Separated from the read (ADMIN-CRITICAL-157): the two were in one `try`,
   * so a refused mark-as-read looked exactly like a failed message load, and
   * both were silent. `markReadMutation.error` now says which one failed.
   */
  const markRead = markReadMutation.mutate;
  useEffect(() => {
    if (selectedThread === null) return;
    if (selectedThread.unreadCount === 0) return;
    if (messagesQuery.data === undefined) return;
    markRead(selectedThread.id);
  }, [selectedThread, messagesQuery.data, markRead]);

  const sendMutation = useAdminMutation(
    (input: { threadId: string; content: string; isInternal: boolean }) =>
      supportApi.sendSupportMessage(input.threadId, {
        content: input.content,
        // The toggle finally reaches the wire. Without it every internal note
        // was posted to the tenant as a public message.
        isInternal: input.isInternal,
      }),
    {
      invalidateKeys: [adminKeys.messaging.all(), adminKeys.messaging.stats()],
      mutationOptions: {
        onSuccess: () => {
          setNewMessage('');
          setIsInternalNote(false);
        },
      },
    },
  );

  const closeMutation = useAdminMutation((threadId: string) => supportApi.closeThread(threadId), {
    invalidateKeys: [adminKeys.messaging.all(), adminKeys.messaging.stats()],
  });

  const reopenMutation = useAdminMutation((threadId: string) => supportApi.reopenThread(threadId), {
    invalidateKeys: [adminKeys.messaging.all(), adminKeys.messaging.stats()],
  });

  const archiveMutation = useAdminMutation(
    (threadId: string) => supportApi.archiveThread(threadId),
    {
      invalidateKeys: [adminKeys.messaging.all(), adminKeys.messaging.stats()],
      mutationOptions: { onSuccess: () => setSelectedThreadId(null) },
    },
  );

  const createThreadMutation = useAdminMutation(
    (input: { tenantId: string; subject: string; content: string }) =>
      supportApi.createThread(input),
    {
      invalidateKeys: [adminKeys.messaging.all(), adminKeys.messaging.stats()],
      mutationOptions: { onSuccess: () => setShowNewThreadModal(false) },
    },
  );

  const bulkMutation = useAdminMutation(
    (input: { subject: string; content: string; audience: BulkMessageAudience; sendEmail: boolean }) =>
      supportApi.sendBulkMessage({
        subject: input.subject,
        content: input.content,
        targetCriteria: input.audience,
        sendEmail: input.sendEmail,
      }),
    {
      invalidateKeys: [adminKeys.messaging.all(), adminKeys.messaging.stats()],
      mutationOptions: {
        onSuccess: (result) => {
          setLastBroadcast(result);
          setShowBulkModal(false);
        },
      },
    },
  );

  // ── Derived ──

  const filteredThreads = threads.filter((thread) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      thread.subject.toLowerCase().includes(query) ||
      (thread.tenantName || '').toLowerCase().includes(query) ||
      thread.lastMessage.toLowerCase().includes(query)
    );
  });

  const stats = statsQuery.data ?? null;

  const selectThread = (threadId: string): void => {
    setSelectedThreadId(threadId);
    setRequestedMessagePage(null);
  };

  const handleSendMessage = (): void => {
    if (!newMessage.trim() || selectedThread === null) return;
    sendMutation.mutate({
      threadId: selectedThread.id,
      content: newMessage,
      isInternal: isInternalNote,
    });
  };

  const reload = (): void => {
    void threadsQuery.refetch();
    void statsQuery.refetch();
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-6 py-4">
        <PageHeader
          title="Messaging"
          description="Communicate with tenant administrators"
          actions={
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={reload}
                aria-label="Refresh"
                className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <RefreshCw size={18} />
              </button>
              <button
                type="button"
                onClick={() => setShowBulkModal(true)}
                className="flex items-center gap-2 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                <Users size={18} />
                Bulk Message
              </button>
              <button
                type="button"
                onClick={() => setShowNewThreadModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-info-600 text-white rounded-lg hover:bg-info-700"
              >
                <Plus size={18} />
                New Conversation
              </button>
            </div>
          }
        />

        <div className="mt-4">
          <QueryFailureNotice
            errors={[
              threadsQuery.error,
              statsQuery.error,
              messagesQuery.error,
              markReadMutation.error,
              sendMutation.error,
              closeMutation.error,
              reopenMutation.error,
              archiveMutation.error,
              createThreadMutation.error,
              bulkMutation.error,
            ]}
            hasContent
            onRetry={reload}
          />
        </div>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mt-4">
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
              <div className="text-sm text-gray-500 dark:text-gray-400">Total Threads</div>
              <div className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                {stats.totalThreads}
              </div>
            </div>
            <div className="bg-info-50 dark:bg-info-900/20 rounded-lg p-3">
              <div className="text-sm text-info-600 dark:text-info-400">Active</div>
              <div className="text-xl font-semibold text-info-700 dark:text-info-300">
                {stats.activeThreads}
              </div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
              <div className="text-sm text-gray-500 dark:text-gray-400">Closed</div>
              <div className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                {stats.closedThreads}
              </div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
              <div className="text-sm text-gray-500 dark:text-gray-400">Total Messages</div>
              <div className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                {stats.totalMessages}
              </div>
            </div>
            <div className="bg-error-50 dark:bg-error-900/20 rounded-lg p-3">
              <div className="text-sm text-error-600 dark:text-error-400">Unread</div>
              <div className="text-xl font-semibold text-error-700 dark:text-error-300">
                {stats.unreadMessages}
              </div>
            </div>
            <div className="bg-success-50 dark:bg-success-900/20 rounded-lg p-3">
              <div className="text-sm text-success-600 dark:text-success-400">Avg Response</div>
              <div className="text-xl font-semibold text-success-700 dark:text-success-300">
                {formatAvgResponse(stats.avgResponseTimeMinutes)}
              </div>
              {stats.avgResponseTimeMinutes === null && (
                <div className="text-xs text-success-700 dark:text-success-300 mt-0.5">
                  No admin reply to measure yet
                </div>
              )}
            </div>
          </div>
        )}

        {lastBroadcast && (
          <div
            role="status"
            className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
              lastBroadcast.failed > 0
                ? 'border-warning-200 dark:border-warning-800 bg-warning-50 dark:bg-warning-900/20 text-warning-800 dark:text-warning-200'
                : 'border-success-200 dark:border-success-800 bg-success-50 dark:bg-success-900/20 text-success-800 dark:text-success-200'
            }`}
          >
            {lastBroadcast.failed > 0
              ? `Broadcast partially delivered: ${lastBroadcast.sent} sent, ${lastBroadcast.failed} failed.`
              : `Broadcast delivered to ${lastBroadcast.sent} tenant(s).`}
          </div>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Thread List */}
        <div className="w-96 border-r border-gray-200 dark:border-gray-700 flex flex-col bg-white dark:bg-gray-900">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 space-y-3">
            <div className="relative">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400"
                size={18}
              />
              <input
                type="text"
                aria-label="Search conversations"
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500 focus:border-info-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <select
                aria-label="Thread status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'all' | 'open' | 'closed')}
                className="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500"
              >
                <option value="all">All Threads</option>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </select>
              <button
                type="button"
                onClick={() => setShowUnreadOnly(!showUnreadOnly)}
                className={`px-3 py-1.5 rounded-lg text-sm border ${
                  showUnreadOnly
                    ? 'bg-info-100 dark:bg-info-900/40 border-info-300 dark:border-info-700 text-info-700 dark:text-info-300'
                    : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}
              >
                Unread
              </button>
            </div>
            {/* The list reads one page. Saying so is the difference between a
                platform with 100 conversations and one whose first 100 these
                are. */}
            {threadTotal > threads.length && (
              <p className="text-xs text-warning-700 dark:text-warning-300">
                Showing the {threads.length} most recent of {threadTotal.toLocaleString()}{' '}
                conversations. Narrow the filter to reach the rest.
              </p>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {threadsQuery.isPending ? (
              <div className="flex items-center justify-center h-full">
                <Spinner size="lg" />
              </div>
            ) : threadsQuery.isError ? null : filteredThreads.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 dark:text-gray-400 p-4">
                <Inbox size={48} className="mb-2 text-gray-500 dark:text-gray-400" />
                <p>No conversations found</p>
              </div>
            ) : (
              filteredThreads.map((thread) => (
                <button
                  type="button"
                  key={thread.id}
                  onClick={() => selectThread(thread.id)}
                  className={`w-full text-left p-4 border-b border-gray-100 dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 ${
                    selectedThreadId === thread.id ? 'bg-info-50 dark:bg-info-900/20' : ''
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
                          {thread.tenantName || 'Unknown Tenant'}
                        </span>
                        {thread.unreadCount > 0 && (
                          <span className="px-1.5 py-0.5 bg-info-600 text-white text-xs rounded-full">
                            {thread.unreadCount}
                          </span>
                        )}
                      </div>
                      <div className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate mt-0.5">
                        {thread.subject}
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400 truncate mt-1">
                        {thread.lastMessage}
                      </div>
                    </div>
                    <div className="flex flex-col items-end ml-2">
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {thread.lastMessageAt ? formatRelativeTime(String(thread.lastMessageAt)) : ''}
                      </span>
                      {thread.isClosed && (
                        <span className="text-xs text-gray-500 dark:text-gray-400 mt-1 px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">
                          Closed
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Message Area */}
        <div className="flex-1 flex flex-col bg-gray-50 dark:bg-gray-800">
          {selectedThread ? (
            <>
              <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-6 py-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                        {selectedThread.subject}
                      </h2>
                      {selectedThread.isClosed && (
                        <span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 text-xs rounded">
                          Closed
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {selectedThread.tenantName} · {selectedThread.messageCount} messages
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedThread.isClosed ? (
                      <button
                        type="button"
                        onClick={() => reopenMutation.mutate(selectedThread.id)}
                        disabled={reopenMutation.isPending}
                        className="px-3 py-1.5 text-sm text-info-600 dark:text-info-400 hover:bg-info-50 dark:hover:bg-info-900/30 rounded-lg disabled:opacity-50"
                      >
                        Reopen
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => closeMutation.mutate(selectedThread.id)}
                        disabled={closeMutation.isPending}
                        className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg disabled:opacity-50"
                      >
                        Close Thread
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label="Archive thread"
                      onClick={() => archiveMutation.mutate(selectedThread.id)}
                      disabled={archiveMutation.isPending}
                      className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
                    >
                      <Archive size={18} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                {messageTotalPages > 1 && (
                  <div className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-2 text-sm">
                    <span className="text-gray-600 dark:text-gray-400">
                      Showing {messages.length} of {messageTotal.toLocaleString()} messages — page{' '}
                      {messagePage} of {messageTotalPages}
                    </span>
                    <span className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setRequestedMessagePage(messagePage - 1)}
                        disabled={messagePage <= 1}
                      >
                        Older
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setRequestedMessagePage(messagePage + 1)}
                        disabled={messagePage >= messageTotalPages}
                      >
                        Newer
                      </Button>
                    </span>
                  </div>
                )}

                {messagesQuery.isPending ? (
                  <div className="flex items-center justify-center h-full">
                    <Spinner size="lg" />
                  </div>
                ) : messagesQuery.isError ? null : messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-gray-500 dark:text-gray-400">
                    <MessageSquare size={48} className="mb-2 text-gray-500 dark:text-gray-400" />
                    <p>No messages yet</p>
                  </div>
                ) : (
                  messages.map((message) => {
                    const fromPlatform = isFromPlatform(message);
                    const onBlue = fromPlatform && !message.isInternal;
                    return (
                      <div
                        key={message.id}
                        className={`flex ${fromPlatform ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={`max-w-2xl rounded-lg p-4 ${
                            message.isInternal
                              ? 'bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800'
                              : fromPlatform
                                ? 'bg-info-600 text-white'
                                : 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700'
                          }`}
                        >
                          {message.isInternal && (
                            <div className="flex items-center gap-1 text-warning-700 dark:text-warning-300 text-xs mb-2">
                              <AlertCircle size={12} />
                              Internal Note — not shown to the tenant
                            </div>
                          )}
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className={`text-sm font-medium ${
                                onBlue ? 'text-info-100' : 'text-gray-700 dark:text-gray-300'
                              }`}
                            >
                              {message.senderName ?? 'Unknown sender'}
                            </span>
                            <span
                              className={`text-xs ${
                                onBlue ? 'text-info-200' : 'text-gray-500 dark:text-gray-400'
                              }`}
                            >
                              {formatRelativeTime(String(message.createdAt))}
                            </span>
                          </div>
                          <p
                            className={`text-sm whitespace-pre-wrap ${
                              message.isInternal ? 'text-warning-800 dark:text-warning-200' : ''
                            }`}
                          >
                            {message.content}
                          </p>

                          {message.attachments && message.attachments.length > 0 && (
                            <div className="mt-3 space-y-2">
                              {message.attachments.map((att) => (
                                <a
                                  key={att.id}
                                  href={att.url}
                                  className={`flex items-center gap-2 p-2 rounded border ${
                                    onBlue
                                      ? 'border-info-400 bg-info-500 hover:bg-info-400'
                                      : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700'
                                  }`}
                                >
                                  <Paperclip size={14} />
                                  <span className="text-sm truncate">{att.fileName}</span>
                                  <span
                                    className={`text-xs ${
                                      onBlue ? 'text-info-200' : 'text-gray-500 dark:text-gray-400'
                                    }`}
                                  >
                                    {formatFileSize(att.fileSize)}
                                  </span>
                                </a>
                              ))}
                            </div>
                          )}

                          {onBlue && (
                            <div className="flex justify-end mt-2 text-xs text-info-100">
                              {message.status === 'failed' ? (
                                <span className="text-warning-200">Failed to send</span>
                              ) : message.status === 'read' ? (
                                <span>Read</span>
                              ) : (
                                <span className="opacity-70">Sent</span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Composer */}
              {!selectedThread.isClosed && (
                <div className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <button
                      type="button"
                      onClick={() => setIsInternalNote(!isInternalNote)}
                      aria-pressed={isInternalNote}
                      className={`text-xs px-2 py-1 rounded ${
                        isInternalNote
                          ? 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300 border border-warning-300 dark:border-warning-700'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                    >
                      {isInternalNote ? 'Internal Note' : 'Public Message'}
                    </button>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {isInternalNote
                        ? 'Kept internal — the tenant does not see this.'
                        : 'Delivered to the tenant.'}
                    </span>
                  </div>
                  <div className="flex items-end gap-3">
                    <div className="flex-1">
                      <textarea
                        aria-label="Reply"
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        placeholder={
                          isInternalNote ? 'Write an internal note...' : 'Type your message...'
                        }
                        rows={3}
                        className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg resize-none focus:ring-2 focus:ring-info-500 focus:border-info-500"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            handleSendMessage();
                          }
                        }}
                      />
                    </div>
                    <button
                      type="button"
                      aria-label="Send message"
                      onClick={handleSendMessage}
                      disabled={!newMessage.trim() || sendMutation.isPending}
                      className="p-3 bg-info-600 text-white rounded-lg hover:bg-info-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Send size={20} />
                    </button>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    Press Cmd+Enter to send
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-gray-500 dark:text-gray-400">
                <MessageSquare
                  size={64}
                  className="mx-auto mb-4 text-gray-500 dark:text-gray-400"
                />
                <h3 className="text-lg font-medium text-gray-700 dark:text-gray-300">
                  Select a conversation
                </h3>
                <p className="mt-1">Choose a thread from the list to view messages</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {showBulkModal && (
        <BulkMessageModal
          isSending={bulkMutation.isPending}
          onClose={() => setShowBulkModal(false)}
          onSubmit={(data) => bulkMutation.mutate(data)}
        />
      )}

      {showNewThreadModal && (
        <NewThreadModal
          isSaving={createThreadMutation.isPending}
          onClose={() => setShowNewThreadModal(false)}
          onSubmit={(data) => createThreadMutation.mutate(data)}
        />
      )}
    </div>
  );
};

// ============================================================================
// Sub-components
// ============================================================================

type BroadcastAudience = 'all-active' | 'selected';

interface BulkMessageModalProps {
  isSending: boolean;
  onClose: () => void;
  onSubmit: (data: {
    subject: string;
    content: string;
    audience: BulkMessageAudience;
    sendEmail: boolean;
  }) => void;
}

/**
 * The broadcast dialog.
 *
 * The audience is CHOSEN, not asserted (ADMIN-CRITICAL-157). This previewed
 * "This message will be sent to all active tenants" while sending a body with
 * no audience at all — the one shape the route refuses — so no broadcast this
 * platform ever attempted was delivered. `targetCriteria` is now required by
 * the contract, and each choice here maps to a clause the server actually
 * applies: `{}` is every active tenant, `{ tenantIds }` a chosen one.
 */
const BulkMessageModal: React.FC<BulkMessageModalProps> = ({ isSending, onClose, onSubmit }) => {
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [audience, setAudience] = useState<BroadcastAudience>('all-active');
  const [tenantId, setTenantId] = useState<string | null>(null);

  const audienceIsReady = audience === 'all-active' || tenantId !== null;

  const handleSubmit = (): void => {
    if (!subject || !content || !audienceIsReady) return;
    onSubmit({
      subject,
      content,
      audience: audience === 'all-active' ? {} : { tenantIds: [tenantId as string] },
      sendEmail,
    });
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title="Bulk Message"
      bodyClassName="p-6 space-y-4"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!subject || !content || !audienceIsReady || isSending}
            className="flex items-center gap-2 px-4 py-2 bg-info-600 text-white rounded-lg hover:bg-info-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send size={18} />
            Send broadcast
          </button>
        </>
      }
    >
      {/* Audience */}
      <div>
        <label
          htmlFor="bulk-audience"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
        >
          Audience
        </label>
        <select
          id="bulk-audience"
          value={audience}
          onChange={(e) => setAudience(e.target.value as BroadcastAudience)}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500"
        >
          <option value="all-active">Every active tenant</option>
          <option value="selected">One selected tenant</option>
        </select>
      </div>

      {audience === 'selected' && (
        <div>
          <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Tenant
          </span>
          <TenantSelect value={tenantId} onChange={(id) => setTenantId(id || null)} />
        </div>
      )}

      {/* Subject */}
      <div>
        <label
          htmlFor="bulk-subject"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
        >
          Subject
        </label>
        <input
          id="bulk-subject"
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500"
          placeholder="Enter message subject..."
        />
      </div>

      {/* Content */}
      <div>
        <label
          htmlFor="bulk-content"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
        >
          Message Content
        </label>
        <textarea
          id="bulk-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={6}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 resize-none"
          placeholder="Enter your message..."
        />
      </div>

      {/* Options */}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={sendEmail}
            onChange={(e) => setSendEmail(e.target.checked)}
            className="w-4 h-4 text-info-600 rounded border-gray-300 dark:border-gray-600 focus:ring-info-500"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">Send email notification</span>
        </label>
      </div>

      {/* Preview */}
      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
        <div className="text-sm text-gray-500 dark:text-gray-400 mb-2">Preview</div>
        <div className="text-sm text-gray-700 dark:text-gray-300">
          {audience === 'all-active'
            ? 'This opens one conversation with every ACTIVE tenant.'
            : 'This opens one conversation with the selected tenant.'}
        </div>
      </div>
    </Modal>
  );
};

interface NewThreadModalProps {
  isSaving: boolean;
  onClose: () => void;
  onSubmit: (data: { tenantId: string; subject: string; content: string }) => void;
}

/**
 * The new-conversation dialog.
 *
 * The tenant is PICKED, not typed (ADMIN-CRITICAL-157 / the same class as
 * ADMIN-HIGH-153). A free-text UUID box accepts a valid-but-wrong id, and here
 * that opens a support conversation — with its first message — against a
 * tenant nobody meant to contact.
 */
const NewThreadModal: React.FC<NewThreadModalProps> = ({ isSaving, onClose, onSubmit }) => {
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');

  const handleSubmit = (): void => {
    if (tenantId === null || !subject || !message) return;
    onSubmit({ tenantId, subject, content: message });
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="md"
      title="New Conversation"
      bodyClassName="p-6 space-y-4"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={tenantId === null || !subject || !message || isSaving}
            className="flex items-center gap-2 px-4 py-2 bg-info-600 text-white rounded-lg hover:bg-info-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MessageSquare size={18} />
            Start Conversation
          </button>
        </>
      }
    >
      {/* Tenant */}
      <div>
        <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Tenant
        </span>
        <TenantSelect value={tenantId} onChange={(id) => setTenantId(id || null)} />
      </div>

      {/* Subject */}
      <div>
        <label
          htmlFor="thread-subject"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
        >
          Subject
        </label>
        <input
          id="thread-subject"
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500"
          placeholder="Enter conversation subject..."
        />
      </div>

      {/* Initial Message */}
      <div>
        <label
          htmlFor="thread-message"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
        >
          Initial Message
        </label>
        <textarea
          id="thread-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 resize-none"
          placeholder="Enter your message..."
        />
      </div>
    </Modal>
  );
};

export default MessagingPage;
