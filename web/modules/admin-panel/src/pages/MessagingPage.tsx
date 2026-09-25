/**
 * Messaging Page
 *
 * Admin-tenant mesajlaşma sistemi - direct messaging, bulk messaging.
 * Thread management, attachment support, read receipts.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Checkbox, Modal, PageHeader, Select, Spinner, ToggleButton } from '@aquaculture/shared-ui';
import {
  MessageSquare,
  Send,
  Users,
  Search,
  Archive,
  Paperclip,
  Clock,
  CheckCheck,
  AlertCircle,
  Plus,
  RefreshCw,
  Inbox,
} from 'lucide-react';
import {
  supportApi,
  type MessageThreadSummary,
  type SupportMessage,
  type SupportMessageAttachment,
} from '../services/adminApi';

// ============================================================================
// Types
// ============================================================================

/**
 * The list rows as this page renders them. `unreadCount` and `isClosed` come
 * from the response as-is — the endpoint already computes both. They used to be
 * re-derived here from `unreadCountAdmin` and `status`, GraphQL field names
 * this REST endpoint does not send, which overwrote the correct values with
 * `0` and `false` (ADMIN-HIGH-110).
 */
type ThreadSummary = MessageThreadSummary;

interface MessagingStats {
  totalThreads: number;
  activeThreads: number;
  closedThreads: number;
  totalMessages: number;
  unreadMessages: number;
  avgResponseTimeMinutes: number;
}

// ============================================================================
// Component
// ============================================================================

export const MessagingPage: React.FC = () => {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [stats, setStats] = useState<MessagingStats | null>(null);
  const [selectedThread, setSelectedThread] = useState<ThreadSummary | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [showNewThreadModal, setShowNewThreadModal] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Fetch threads from API
  const fetchThreads = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const params: Record<string, unknown> = { limit: 100 };
      if (statusFilter !== 'all') params.status = statusFilter;
      if (showUnreadOnly) params.hasUnread = 'true';

      const result = await supportApi.getMessageThreads(params);
      // Copied because the paginated envelope hands back a readonly view.
      setThreads([...result.data]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setThreads([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, showUnreadOnly]);

  // Fetch stats from API
  const fetchStats = useCallback(async () => {
    try {
      const data = await supportApi.getMessagingStats();
      setStats(data as unknown as MessagingStats);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  }, []);

  // Fetch messages for a thread
  const fetchMessages = useCallback(
    async (threadId: string) => {
      try {
        setMessagesLoading(true);
        const data = await supportApi.getThreadMessages(threadId);
        setMessages(data || []);

        // Mark as read
        await supportApi.markAsRead(threadId);

        // Refresh threads to update unread count
        fetchThreads();
      } catch (err) {
        console.error('Failed to fetch messages:', err);
      } finally {
        setMessagesLoading(false);
      }
    },
    [fetchThreads],
  );

  useEffect(() => {
    fetchThreads();
    fetchStats();
  }, [fetchThreads, fetchStats]);

  useEffect(() => {
    if (selectedThread) {
      fetchMessages(selectedThread.id);
    }
  }, [selectedThread, fetchMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const filteredThreads = threads.filter((thread) => {
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return (
        thread.subject.toLowerCase().includes(query) ||
        (thread.tenantName || '').toLowerCase().includes(query) ||
        thread.lastMessage.toLowerCase().includes(query)
      );
    }
    return true;
  });

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !selectedThread) return;

    try {
      await supportApi.sendSupportMessage(selectedThread.id, {
        content: newMessage,
        senderName: 'Admin', // TODO: Use actual admin name
      });
      setNewMessage('');
      setIsInternalNote(false);
      fetchMessages(selectedThread.id);
      fetchThreads();
    } catch (err) {
      console.error('Failed to send message:', err);
    }
  };

  const handleCloseThread = async (threadId: string) => {
    try {
      await supportApi.closeThread(threadId);
      fetchThreads();
      if (selectedThread?.id === threadId) {
        setSelectedThread({ ...selectedThread, isClosed: true });
      }
    } catch (err) {
      console.error('Failed to close thread:', err);
    }
  };

  const handleReopenThread = async (threadId: string) => {
    try {
      await supportApi.reopenThread(threadId);
      fetchThreads();
      if (selectedThread?.id === threadId) {
        setSelectedThread({ ...selectedThread, isClosed: false });
      }
    } catch (err) {
      console.error('Failed to reopen thread:', err);
    }
  };

  const handleArchiveThread = async (threadId: string) => {
    try {
      await supportApi.archiveThread(threadId);
      fetchThreads();
      if (selectedThread?.id === threadId) {
        setSelectedThread(null);
      }
    } catch (err) {
      console.error('Failed to archive thread:', err);
    }
  };

  const handleCreateThread = async (data: {
    tenantId: string;
    subject: string;
    content: string;
  }) => {
    try {
      await supportApi.createThread({
        ...data,
        senderName: 'Admin', // TODO: Use actual admin name
      });
      setShowNewThreadModal(false);
      fetchThreads();
      fetchStats();
    } catch (err) {
      console.error('Failed to create thread:', err);
    }
  };

  const handleBulkMessage = async (data: {
    subject: string;
    content: string;
    tenantIds?: string[];
    sendEmail: boolean;
  }) => {
    try {
      await supportApi.sendBulkMessage(data);
      setShowBulkModal(false);
      fetchThreads();
      fetchStats();
    } catch (err) {
      console.error('Failed to send bulk message:', err);
    }
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = diff / (1000 * 60 * 60);

    if (hours < 1) return `${Math.round(diff / (1000 * 60))}m ago`;
    if (hours < 24) return `${Math.round(hours)}h ago`;
    if (hours < 48) return 'Yesterday';
    return date.toLocaleDateString();
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
                aria-label="Refresh threads"
                onClick={() => {
                  fetchThreads();
                  fetchStats();
                }}
                className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <RefreshCw size={18} />
              </button>
              <button
                onClick={() => setShowBulkModal(true)}
                className="flex items-center gap-2 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                <Users size={18} />
                Bulk Message
              </button>
              <button
                onClick={() => setShowNewThreadModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-info-600 text-white rounded-lg hover:bg-info-700"
              >
                <Plus size={18} />
                New Conversation
              </button>
            </div>
          }
        />

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
                {stats.avgResponseTimeMinutes > 60
                  ? `${Math.round(stats.avgResponseTimeMinutes / 60)}h`
                  : `${stats.avgResponseTimeMinutes}m`}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Thread List */}
        <div className="w-96 border-r border-gray-200 dark:border-gray-700 flex flex-col bg-white dark:bg-gray-900">
          {/* Search & Filter */}
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 space-y-3">
            <div className="relative">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400"
                size={18}
              />
              <input
                type="text"
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500 focus:border-info-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'all' | 'open' | 'closed')}
                options={[
                  { value: 'all', label: 'All Threads' },
                  { value: 'open', label: 'Open' },
                  { value: 'closed', label: 'Closed' },
                ]}
              />
              <ToggleButton
                onClick={() => setShowUnreadOnly(!showUnreadOnly)}
                pressed={showUnreadOnly}
                className="px-3 py-1.5 rounded-lg text-sm border"
                pressedClassName="bg-info-100 dark:bg-info-900/40 border-info-300 dark:border-info-700 text-info-700 dark:text-info-300"
                idleClassName="border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Unread
              </ToggleButton>
            </div>
          </div>

          {/* Thread List */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <Spinner size="lg" />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center h-full text-error-500 p-4">
                <AlertCircle size={32} className="mb-2" />
                <p className="text-center">{error}</p>
                <button
                  onClick={fetchThreads}
                  className="mt-2 text-sm text-info-600 dark:text-info-400 hover:text-info-700 dark:hover:text-info-200"
                >
                  Retry
                </button>
              </div>
            ) : filteredThreads.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 dark:text-gray-400 p-4">
                <Inbox size={48} className="mb-2 text-gray-500 dark:text-gray-400" />
                <p>No conversations found</p>
              </div>
            ) : (
              filteredThreads.map((thread) => (
                <div
                  key={thread.id}
                  onClick={() => setSelectedThread(thread)}
                  className={`p-4 border-b border-gray-100 dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 ${
                    selectedThread?.id === thread.id ? 'bg-info-50 dark:bg-info-900/20' : ''
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
                        {thread.lastMessageAt ? formatTime(thread.lastMessageAt) : ''}
                      </span>
                      {thread.isClosed && (
                        <span className="text-xs text-gray-500 dark:text-gray-400 mt-1 px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">
                          Closed
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Message Area */}
        <div className="flex-1 flex flex-col bg-gray-50 dark:bg-gray-800">
          {selectedThread ? (
            <>
              {/* Thread Header */}
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
                        onClick={() => handleReopenThread(selectedThread.id)}
                        className="px-3 py-1.5 text-sm text-info-600 dark:text-info-400 hover:bg-info-50 dark:hover:bg-info-900/30 rounded-lg"
                      >
                        Reopen
                      </button>
                    ) : (
                      <button
                        onClick={() => handleCloseThread(selectedThread.id)}
                        className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
                      >
                        Close Thread
                      </button>
                    )}
                    <button
                      aria-label="Archive thread"
                      onClick={() => handleArchiveThread(selectedThread.id)}
                      className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <Archive size={18} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                {messagesLoading ? (
                  <div className="flex items-center justify-center h-full">
                    <Spinner size="lg" />
                  </div>
                ) : messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-gray-500 dark:text-gray-400">
                    <MessageSquare size={48} className="mb-2 text-gray-500 dark:text-gray-400" />
                    <p>No messages yet</p>
                  </div>
                ) : (
                  messages.map((message) => (
                    <div
                      key={message.id}
                      className={`flex ${message.senderType === 'super_admin' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-2xl rounded-lg p-4 ${
                          message.isInternal
                            ? 'bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800'
                            : message.senderType === 'super_admin'
                              ? 'bg-info-600 text-white'
                              : 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700'
                        }`}
                      >
                        {message.isInternal && (
                          <div className="flex items-center gap-1 text-warning-700 dark:text-warning-300 text-xs mb-2">
                            <AlertCircle size={12} />
                            Internal Note
                          </div>
                        )}
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className={`text-sm font-medium ${
                              message.senderType === 'super_admin' && !message.isInternal
                                ? 'text-info-100'
                                : 'text-gray-700 dark:text-gray-300'
                            }`}
                          >
                            {message.senderName}
                          </span>
                          <span
                            className={`text-xs ${
                              message.senderType === 'super_admin' && !message.isInternal
                                ? 'text-info-200'
                                : 'text-gray-500 dark:text-gray-400'
                            }`}
                          >
                            {formatTime(message.createdAt)}
                          </span>
                        </div>
                        <p
                          className={`text-sm whitespace-pre-wrap ${
                            message.isInternal ? 'text-warning-800 dark:text-warning-200' : ''
                          }`}
                        >
                          {message.content}
                        </p>

                        {/* Attachments */}
                        {message.attachments && message.attachments.length > 0 && (
                          <div className="mt-3 space-y-2">
                            {message.attachments.map((att) => (
                              <a
                                key={att.id}
                                href={att.url}
                                className={`flex items-center gap-2 p-2 rounded border ${
                                  message.senderType === 'super_admin' && !message.isInternal
                                    ? 'border-info-400 bg-info-500 hover:bg-info-400'
                                    : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700'
                                }`}
                              >
                                <Paperclip size={14} />
                                <span className="text-sm truncate">{att.filename}</span>
                                <span
                                  className={`text-xs ${
                                    message.senderType === 'super_admin' && !message.isInternal
                                      ? 'text-info-200'
                                      : 'text-gray-500 dark:text-gray-400'
                                  }`}
                                >
                                  {formatFileSize(att.size)}
                                </span>
                              </a>
                            ))}
                          </div>
                        )}

                        {/* Read Status */}
                        {message.senderType === 'super_admin' && !message.isInternal && (
                          <div className="flex justify-end mt-2">
                            {message.status === 'read' ? (
                              <CheckCheck size={14} className="text-info-200" />
                            ) : (
                              <CheckCheck size={14} className="text-info-300 opacity-50" />
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Message Input */}
              {!selectedThread.isClosed && (
                <div className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <ToggleButton
                      onClick={() => setIsInternalNote(!isInternalNote)}
                      pressed={isInternalNote}
                      className="text-xs px-2 py-1 rounded"
                      pressedClassName="bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300 border border-warning-300 dark:border-warning-700"
                      idleClassName="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
                    >
                      {isInternalNote ? 'Internal Note' : 'Public Message'}
                    </ToggleButton>
                  </div>
                  <div className="flex items-end gap-3">
                    <div className="flex-1">
                      <textarea
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
                    <div className="flex flex-col gap-2">
                      <button
                        aria-label="Send message"
                        onClick={handleSendMessage}
                        disabled={!newMessage.trim()}
                        className="p-3 bg-info-600 text-white rounded-lg hover:bg-info-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Send size={20} />
                      </button>
                    </div>
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

      {/* Bulk Message Modal */}
      {showBulkModal && (
        <BulkMessageModal onClose={() => setShowBulkModal(false)} onSubmit={handleBulkMessage} />
      )}

      {/* New Thread Modal */}
      {showNewThreadModal && (
        <NewThreadModal
          onClose={() => setShowNewThreadModal(false)}
          onSubmit={handleCreateThread}
        />
      )}
    </div>
  );
};

// ============================================================================
// Sub-components
// ============================================================================

interface BulkMessageModalProps {
  onClose: () => void;
  onSubmit: (data: {
    subject: string;
    content: string;
    tenantIds?: string[];
    sendEmail: boolean;
  }) => void;
}

const BulkMessageModal: React.FC<BulkMessageModalProps> = ({ onClose, onSubmit }) => {
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [sendEmail, setSendEmail] = useState(true);

  const handleSubmit = () => {
    if (subject && content) {
      onSubmit({ subject, content, sendEmail });
    }
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
            disabled={!subject || !content}
            className="flex items-center gap-2 px-4 py-2 bg-info-600 text-white rounded-lg hover:bg-info-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send size={18} />
            Send to All
          </button>
        </>
      }
    >
      {/* Subject */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Subject
        </label>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500"
          placeholder="Enter message subject..."
        />
      </div>

      {/* Content */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Message Content
        </label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={6}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 resize-none"
          placeholder="Enter your message..."
        />
      </div>

      {/* Options */}
      <div className="flex items-center gap-3">
        <Checkbox
          label="Send email notification"
          checked={sendEmail}
          onChange={(e) => setSendEmail(e.target.checked)}
        />
      </div>

      {/* Preview */}
      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
        <div className="text-sm text-gray-500 dark:text-gray-400 mb-2">Preview</div>
        <div className="text-sm text-gray-700 dark:text-gray-300">
          This message will be sent to <strong>all active tenants</strong>.
        </div>
      </div>
    </Modal>
  );
};

interface NewThreadModalProps {
  onClose: () => void;
  onSubmit: (data: { tenantId: string; subject: string; content: string }) => void;
}

const NewThreadModal: React.FC<NewThreadModalProps> = ({ onClose, onSubmit }) => {
  const [tenantId, setTenantId] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');

  const handleSubmit = () => {
    if (tenantId && subject && message) {
      onSubmit({ tenantId, subject, content: message });
    }
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
            disabled={!tenantId || !subject || !message}
            className="flex items-center gap-2 px-4 py-2 bg-info-600 text-white rounded-lg hover:bg-info-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MessageSquare size={18} />
            Start Conversation
          </button>
        </>
      }
    >
      {/* Tenant ID */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Tenant ID
        </label>
        <input
          type="text"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500"
          placeholder="Enter tenant ID..."
        />
      </div>

      {/* Subject */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Subject
        </label>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500"
          placeholder="Enter conversation subject..."
        />
      </div>

      {/* Initial Message */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Initial Message
        </label>
        <textarea
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
