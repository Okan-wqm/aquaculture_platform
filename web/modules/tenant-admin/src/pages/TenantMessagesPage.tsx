/**
 * TenantMessagesPage
 *
 * Messaging interface for TenantAdmin to communicate with SuperAdmin.
 * Thread-based conversations with read receipts.
 *
 * Data layer: GraphQL via graphqlRequest (messaging resolver).
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  MessageSquare,
  Send,
  Search,
  Plus,
  X,
  Paperclip,
  CheckCheck,
  Clock,
  MoreVertical,
  RefreshCw,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { graphqlRequest } from '../services/tenant-api.service';
import {
  MY_THREADS_QUERY,
  THREAD_MESSAGES_QUERY,
  MESSAGING_STATS_QUERY,
  CREATE_THREAD_MUTATION,
  SEND_MESSAGE_MUTATION,
  CLOSE_THREAD_MUTATION,
  REOPEN_THREAD_MUTATION,
} from '../graphql';
import { logError } from '../utils/error-handling';

// ============================================================================
// Types (aligned with backend GraphQL DTOs)
// ============================================================================

type ThreadStatus = 'open' | 'closed' | 'archived';
type SenderType = 'super_admin' | 'tenant_admin' | 'system';
type MessageStatus = 'sent' | 'delivered' | 'read';

interface ThreadListItem {
  id: string;
  tenantId: string;
  tenantName: string;
  subject: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  messageCount: number;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
}

interface MessageItem {
  id: string;
  threadId: string;
  senderId: string;
  senderType: SenderType;
  senderName: string;
  content: string;
  status: MessageStatus;
  isInternal: boolean;
  attachments: Array<{
    id: string;
    filename: string;
    url: string;
    size: number;
    mimeType: string;
  }> | null;
  readAt: string | null;
  createdAt: string;
}

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

const TenantMessagesPage: React.FC = () => {
  const [threads, setThreads] = useState<ThreadListItem[]>([]);
  const [selectedThread, setSelectedThread] = useState<ThreadListItem | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [stats, setStats] = useState<MessagingStats | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [newMessage, setNewMessage] = useState('');
  const [showNewThreadModal, setShowNewThreadModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Fetch threads and stats from GraphQL
  const fetchThreads = async () => {
    try {
      setLoading(true);
      setError(null);

      const statusVar = statusFilter !== 'all' ? statusFilter : undefined;
      const searchVar = searchQuery.trim() || undefined;

      const [threadsResult, statsResult] = await Promise.all([
        graphqlRequest<{ myThreads: ThreadListItem[] }>(MY_THREADS_QUERY, {
          status: statusVar,
          search: searchVar,
        }),
        graphqlRequest<{ messagingStats: MessagingStats }>(MESSAGING_STATS_QUERY),
      ]);

      setThreads(threadsResult.myThreads || []);
      setStats(statsResult.messagingStats);
    } catch (err) {
      logError('TenantMessagesPage.fetchThreads', err);
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    } finally {
      setLoading(false);
    }
  };

  // Fetch messages for selected thread
  const fetchMessages = async (threadId: string) => {
    try {
      setMessagesLoading(true);
      const result = await graphqlRequest<{ threadMessages: MessageItem[] }>(
        THREAD_MESSAGES_QUERY,
        { threadId },
      );
      setMessages(result.threadMessages || []);
    } catch (err) {
      logError('TenantMessagesPage.fetchMessages', err);
    } finally {
      setMessagesLoading(false);
    }
  };

  useEffect(() => {
    fetchThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedThread) {
      fetchMessages(selectedThread.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThread?.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const filteredThreads = threads.filter((thread) => {
    if (searchQuery && !thread.subject.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (statusFilter === 'open' && thread.status !== 'open') return false;
    if (statusFilter === 'closed' && thread.status !== 'closed') return false;
    return true;
  });

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !selectedThread) return;

    setSendError(null);
    try {
      await graphqlRequest<{ sendMessage: MessageItem }>(SEND_MESSAGE_MUTATION, {
        input: {
          threadId: selectedThread.id,
          content: newMessage.trim(),
          isInternal: false,
        },
      });
      setNewMessage('');

      // Refresh messages and threads in parallel
      await Promise.all([
        fetchMessages(selectedThread.id),
        fetchThreads(),
      ]);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send message. Please try again.');
    }
  };

  const handleCloseThread = async (threadId: string) => {
    try {
      await graphqlRequest<{ closeThread: { id: string; status: string } }>(
        CLOSE_THREAD_MUTATION,
        { threadId },
      );
      await fetchThreads();
      if (selectedThread?.id === threadId) {
        setSelectedThread(prev => prev ? { ...prev, status: 'closed' as ThreadStatus } : null);
      }
    } catch (err) {
      logError('TenantMessagesPage.closeThread', err);
    }
  };

  const handleReopenThread = async (threadId: string) => {
    try {
      await graphqlRequest<{ reopenThread: { id: string; status: string } }>(
        REOPEN_THREAD_MUTATION,
        { threadId },
      );
      await fetchThreads();
      if (selectedThread?.id === threadId) {
        setSelectedThread(prev => prev ? { ...prev, status: 'open' as ThreadStatus } : null);
      }
    } catch (err) {
      logError('TenantMessagesPage.reopenThread', err);
    }
  };

  const formatTime = (dateString: string | null) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = diff / (1000 * 60 * 60);

    if (hours < 1) return `${Math.round(diff / (1000 * 60))}m ago`;
    if (hours < 24) return `${Math.round(hours)}h ago`;
    if (hours < 48) return 'Yesterday';
    return date.toLocaleDateString();
  };

  return (
    <div className="h-[calc(100vh-180px)] flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 rounded-t-xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Messages</h1>
            <p className="text-gray-500 mt-1">Communicate with platform support</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={fetchThreads}
              disabled={loading}
              className="p-2 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100 disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={() => setShowNewThreadModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-tenant-600 text-white rounded-lg hover:bg-tenant-700 transition-colors"
            >
              <Plus size={18} />
              New Message
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mt-4">
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-sm text-gray-500">Total Threads</div>
            <div className="text-xl font-semibold text-gray-900">
              {stats?.totalThreads ?? threads.length}
            </div>
          </div>
          <div className="bg-tenant-50 rounded-lg p-3">
            <div className="text-sm text-tenant-600">Active</div>
            <div className="text-xl font-semibold text-tenant-700">
              {stats?.activeThreads ?? threads.filter((t) => t.status === 'open').length}
            </div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-sm text-gray-500">Closed</div>
            <div className="text-xl font-semibold text-gray-900">
              {stats?.closedThreads ?? threads.filter((t) => t.status === 'closed').length}
            </div>
          </div>
          <div className="bg-red-50 rounded-lg p-3">
            <div className="text-sm text-red-600">Unread</div>
            <div className="text-xl font-semibold text-red-700">
              {stats?.unreadMessages ?? threads.reduce((sum, t) => sum + t.unreadCount, 0)}
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden bg-white rounded-b-xl">
        {/* Thread List */}
        <div className="w-96 border-r border-gray-200 flex flex-col">
          {/* Search & Filter */}
          <div className="p-4 border-b border-gray-200 space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={18} />
              <input
                type="text"
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
              />
            </div>
            <div className="flex items-center gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'all' | 'open' | 'closed')}
                className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-tenant-500"
              >
                <option value="all">All Threads</option>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </select>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-4 bg-red-50 border-b border-red-100">
              <div className="flex items-center gap-2 text-red-700">
                <AlertCircle size={18} />
                <span className="text-sm">{error}</span>
                <button
                  onClick={fetchThreads}
                  className="ml-auto text-sm underline hover:no-underline"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {/* Thread List */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-8 h-8 animate-spin text-tenant-600" />
              </div>
            ) : filteredThreads.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 p-4">
                <MessageSquare size={48} className="mb-2 text-gray-500" />
                <p>No conversations found</p>
                {threads.length === 0 && (
                  <p className="text-sm mt-1">Start a new conversation with the admin</p>
                )}
              </div>
            ) : (
              filteredThreads.map((thread) => (
              <div
                key={thread.id}
                onClick={() => setSelectedThread(thread)}
                className={`p-4 border-b border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors ${
                  selectedThread?.id === thread.id ? 'bg-tenant-50 border-l-4 border-l-tenant-500' : ''
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900 truncate">{thread.subject}</span>
                      {thread.unreadCount > 0 && (
                        <span className="px-1.5 py-0.5 bg-tenant-600 text-white text-xs rounded-full">
                          {thread.unreadCount}
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-gray-500 truncate mt-1">{thread.lastMessage}</div>
                    <div className="flex items-center gap-2 mt-2 text-xs text-gray-500">
                      <Clock size={12} />
                      <span>{formatTime(thread.lastMessageAt)}</span>
                      <span>·</span>
                      <span>{thread.messageCount} messages</span>
                    </div>
                  </div>
                    <div className="flex flex-col items-end ml-2">
                      {thread.status === 'closed' && (
                        <span className="text-xs text-gray-500 px-1.5 py-0.5 bg-gray-100 rounded">
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
        <div className="flex-1 flex flex-col bg-gray-50">
          {selectedThread ? (
            <>
              {/* Thread Header */}
              <div className="bg-white border-b border-gray-200 px-6 py-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold text-gray-900">{selectedThread.subject}</h2>
                      {selectedThread.status === 'closed' && (
                        <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                          Closed
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-500">{selectedThread.messageCount} messages</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedThread.status === 'open' ? (
                      <button
                        onClick={() => handleCloseThread(selectedThread.id)}
                        className="px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
                      >
                        Close Thread
                      </button>
                    ) : selectedThread.status === 'closed' ? (
                      <button
                        onClick={() => handleReopenThread(selectedThread.id)}
                        className="px-3 py-1.5 text-sm text-tenant-600 border border-tenant-300 rounded-lg hover:bg-tenant-50"
                      >
                        Reopen
                      </button>
                    ) : null}
                    <button className="p-2 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100">
                      <MoreVertical size={18} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                {messagesLoading ? (
                  <div className="flex items-center justify-center h-full">
                    <Loader2 className="w-8 h-8 animate-spin text-tenant-600" />
                  </div>
                ) : messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-gray-500">
                    <MessageSquare size={48} className="mb-2 text-gray-500" />
                    <p>No messages yet</p>
                  </div>
                ) : (
                  messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex ${message.senderType === 'tenant_admin' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-2xl rounded-lg p-4 ${
                        message.senderType === 'tenant_admin'
                          ? 'bg-tenant-600 text-white'
                          : 'bg-white border border-gray-200'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`text-sm font-medium ${
                            message.senderType === 'tenant_admin' ? 'text-tenant-100' : 'text-gray-700'
                          }`}
                        >
                          {message.senderName}
                        </span>
                        <span
                          className={`text-xs ${
                            message.senderType === 'tenant_admin' ? 'text-tenant-200' : 'text-gray-500'
                          }`}
                        >
                          {formatTime(message.createdAt)}
                        </span>
                      </div>
                      {/* SEC-008: Use whitespace-pre-line (newlines only) not pre-wrap to avoid tab/space injection layout attacks */}
                      <p className="text-sm whitespace-pre-line">{message.content}</p>

                      {/* Read Status */}
                      {message.senderType === 'tenant_admin' && (
                        <div className="flex justify-end mt-2">
                          {message.status === 'read' ? (
                            <CheckCheck size={14} className="text-tenant-200" />
                          ) : (
                            <CheckCheck size={14} className="text-tenant-300 opacity-50" />
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
              {selectedThread.status === 'open' && (
                <div className="bg-white border-t border-gray-200 p-4">
                  <div className="flex items-end gap-3">
                    <div className="flex-1">
                      <textarea
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        placeholder="Type your message..."
                        rows={3}
                        className="w-full px-4 py-3 border border-gray-200 rounded-lg resize-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            handleSendMessage();
                          }
                        }}
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <button className="p-2 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100">
                        <Paperclip size={20} />
                      </button>
                      <button
                        onClick={handleSendMessage}
                        disabled={!newMessage.trim()}
                        className="p-3 bg-tenant-600 text-white rounded-lg hover:bg-tenant-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        <Send size={20} />
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-2">
                    <div className="text-xs text-gray-500">Press Ctrl+Enter to send</div>
                    {sendError && (
                      <div className="flex items-center gap-1 text-xs text-red-600">
                        <AlertCircle size={12} />
                        {sendError}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Closed Thread Notice */}
              {selectedThread.status === 'closed' && (
                <div className="bg-gray-100 border-t border-gray-200 px-6 py-4 text-center">
                  <p className="text-sm text-gray-500">
                    This conversation is closed. Start a new conversation if you need further assistance.
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-gray-500">
                <MessageSquare size={64} className="mx-auto mb-4 text-gray-500" />
                <h3 className="text-lg font-medium text-gray-700">Select a conversation</h3>
                <p className="mt-1">Choose a thread from the list to view messages</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* New Thread Modal */}
      {showNewThreadModal && (
        <NewThreadModal
          onClose={() => setShowNewThreadModal(false)}
          onSubmit={async (subject, content) => {
            try {
              await graphqlRequest<{ createThread: { id: string } }>(
                CREATE_THREAD_MUTATION,
                {
                  input: {
                    subject,
                    initialMessage: content,
                  },
                },
              );
              setShowNewThreadModal(false);
              await fetchThreads();
            } catch (err) {
              throw err;
            }
          }}
        />
      )}
    </div>
  );
};

// ============================================================================
// Sub-components
// ============================================================================

const NewThreadModal: React.FC<{
  onClose: () => void;
  onSubmit: (subject: string, content: string) => Promise<void>;
}> = ({ onClose, onSubmit }) => {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!subject.trim() || !message.trim()) return;

    setSubmitError(null);
    try {
      setSubmitting(true);
      await onSubmit(subject, message);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create conversation. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">New Conversation</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-600">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
              placeholder="Enter subject..."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Message</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-tenant-500 focus:border-transparent resize-none"
              placeholder="Describe your question or issue..."
            />
          </div>
        </div>

        {submitError && (
          <div className="px-6 pb-2">
            <div className="flex items-center gap-2 p-3 bg-red-50 text-red-700 rounded-lg text-sm">
              <AlertCircle size={16} className="flex-shrink-0" />
              {submitError}
            </div>
          </div>
        )}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!subject || !message || submitting}
            className="flex items-center gap-2 px-4 py-2 bg-tenant-600 text-white rounded-lg hover:bg-tenant-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <MessageSquare size={18} />
            )}
            {submitting ? 'Creating...' : 'Start Conversation'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TenantMessagesPage;
