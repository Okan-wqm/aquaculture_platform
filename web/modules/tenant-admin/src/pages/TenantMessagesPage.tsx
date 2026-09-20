/**
 * TenantMessagesPage
 *
 * Messaging interface for TenantAdmin to communicate with SuperAdmin.
 * Thread-based conversations with read receipts.
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  ArrowLeft,
  MessageSquare,
  Send,
  Search,
  Plus,
  Paperclip,
  CheckCheck,
  Clock,
  MoreVertical,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import {
  Modal,
  Spinner,
  PageHeader,
  Button,
  Input,
  Select,
  Textarea,
} from '@aquaculture/shared-ui';
import { useQueryClient } from '@tanstack/react-query';
import {
  useMessageThreads,
  useThreadMessages,
  useSendMessage,
  useCreateThread,
  tenantKeys,
  type MessageThread,
  type Message,
} from '../hooks/useTenantData';
import { sanitizeErrorMessage } from '../utils/error-handling';

// ============================================================================
// Component
// ============================================================================

const TenantMessagesPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [selectedThread, setSelectedThread] = useState<MessageThread | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [newMessage, setNewMessage] = useState('');
  const [showNewThreadModal, setShowNewThreadModal] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // TanStack Query hooks
  const { data: threads = [], isLoading: loading, error: threadsError } = useMessageThreads();
  const { data: messages = [], isLoading: messagesLoading } = useThreadMessages(
    selectedThread?.id ?? null,
  );
  const sendMessageMutation = useSendMessage();
  const createThreadMutation = useCreateThread();

  const error = threadsError ? (threadsError as Error).message : null;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const filteredThreads = threads.filter((thread) => {
    if (searchQuery && !thread.subject.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (statusFilter === 'open' && thread.isClosed) return false;
    if (statusFilter === 'closed' && !thread.isClosed) return false;
    return true;
  });

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !selectedThread) return;

    setSendError(null);
    try {
      // senderName/senderId are resolved server-side from the authenticated user.
      await sendMessageMutation.mutateAsync({
        threadId: selectedThread.id,
        content: newMessage,
      });
      setNewMessage('');
    } catch (err) {
      // BUG-014: Use inline error state instead of alert()
      setSendError(sanitizeErrorMessage(err));
    }
  };

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: tenantKeys.threads() });
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

  return (
    // dvh (not vh): mobile browser chrome makes 100vh taller than the visible
    // viewport, which pushed the composer off-screen on phones.
    <div className="h-[calc(100dvh-180px)] flex flex-col">
      {/* Header */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-4 sm:px-6 py-4 rounded-t-xl">
        <PageHeader
          title="Messages"
          description="Communicate with platform support"
          actions={
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                iconOnly
                aria-label="Refresh"
                onClick={handleRefresh}
                disabled={loading}
                title="Refresh"
              >
                <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
              </Button>
              <Button
                variant="primary"
                leftIcon={<Plus size={18} />}
                onClick={() => setShowNewThreadModal(true)}
              >
                New Message
              </Button>
            </div>
          }
        />

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
            <div className="text-sm text-gray-500 dark:text-gray-400">Total Threads</div>
            <div className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              {threads.length}
            </div>
          </div>
          <div className="bg-success-50 dark:bg-success-900/20 rounded-lg p-3">
            <div className="text-sm text-success-600 dark:text-success-400">Active</div>
            <div className="text-xl font-semibold text-success-700 dark:text-success-300">
              {threads.filter((t) => !t.isClosed).length}
            </div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
            <div className="text-sm text-gray-500 dark:text-gray-400">Closed</div>
            <div className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              {threads.filter((t) => t.isClosed).length}
            </div>
          </div>
          <div className="bg-error-50 dark:bg-error-900/20 rounded-lg p-3">
            <div className="text-sm text-error-600 dark:text-error-400">Unread</div>
            <div className="text-xl font-semibold text-error-700 dark:text-error-300">
              {threads.reduce((sum, t) => sum + t.unreadCount, 0)}
            </div>
          </div>
        </div>
      </div>

      {/* Main Content — master-detail: below `md` only ONE pane is visible at a
          time (the fixed 384px list column alone is wider than a phone viewport
          and squeezed the message pane to zero width, so the page looked like it
          never loaded on mobile). */}
      <div className="flex-1 flex overflow-hidden bg-white dark:bg-gray-900 rounded-b-xl">
        {/* Thread List */}
        <div
          className={`w-full md:w-96 border-r border-gray-200 dark:border-gray-700 flex-col ${
            selectedThread ? 'hidden md:flex' : 'flex'
          }`}
        >
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
                className="w-full pl-10 pr-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-success-500 focus:border-transparent"
              />
            </div>
            <div className="flex items-center gap-2">
              <Select
                options={[
                  { value: 'all', label: 'All Threads' },
                  { value: 'open', label: 'Open' },
                  { value: 'closed', label: 'Closed' },
                ]}
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'all' | 'open' | 'closed')}
              />
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-4 bg-error-50 dark:bg-error-900/20 border-b border-error-100 dark:border-error-800">
              <div className="flex items-center gap-2 text-error-700 dark:text-error-300">
                <AlertCircle size={18} />
                <span className="text-sm">{error}</span>
                <Button variant="ghost" onClick={handleRefresh}>
                  Retry
                </Button>
              </div>
            </div>
          )}

          {/* Thread List */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <Spinner size="lg" />
              </div>
            ) : filteredThreads.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 dark:text-gray-400 p-4">
                <MessageSquare size={48} className="mb-2 text-gray-500 dark:text-gray-400" />
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
                  className={`p-4 border-b border-gray-100 dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${
                    selectedThread?.id === thread.id
                      ? 'bg-success-50 dark:bg-success-900/20 border-l-4 border-l-green-500'
                      : ''
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
                          {thread.subject}
                        </span>
                        {thread.unreadCount > 0 && (
                          <span className="px-1.5 py-0.5 bg-success-600 text-white text-xs rounded-full">
                            {thread.unreadCount}
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400 truncate mt-1">
                        {thread.lastMessage}
                      </div>
                      <div className="flex items-center gap-2 mt-2 text-xs text-gray-500 dark:text-gray-400">
                        <Clock size={12} />
                        <span>{formatTime(thread.lastMessageAt || thread.updatedAt)}</span>
                        <span>·</span>
                        <span>{thread.messageCount} messages</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end ml-2">
                      {thread.isClosed && (
                        <span className="text-xs text-gray-500 dark:text-gray-400 px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">
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
        <div
          className={`flex-1 flex-col bg-gray-50 dark:bg-gray-800 ${
            selectedThread ? 'flex' : 'hidden md:flex'
          }`}
        >
          {selectedThread ? (
            <>
              {/* Thread Header */}
              <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-4 sm:px-6 py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    {/* Mobile-only back to the thread list (master-detail) */}
                    <Button
                      variant="ghost"
                      iconOnly
                      className="md:hidden"
                      onClick={() => setSelectedThread(null)}
                      aria-label="Back to conversations"
                    >
                      <ArrowLeft size={20} />
                    </Button>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
                          {selectedThread.subject}
                        </h2>
                        {selectedThread.isClosed && (
                          <span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 text-xs rounded">
                            Closed
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {selectedThread.messageCount} messages
                      </p>
                    </div>
                  </div>
                  <Button variant="ghost" iconOnly aria-label="More actions">
                    <MoreVertical size={18} />
                  </Button>
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
                  messages.map((message: Message) => (
                    <div
                      key={message.id}
                      className={`flex ${message.senderType === 'tenant_admin' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-2xl rounded-lg p-4 ${
                          message.senderType === 'tenant_admin'
                            ? 'bg-success-600 text-white'
                            : 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className={`text-sm font-medium ${
                              message.senderType === 'tenant_admin'
                                ? 'text-success-100'
                                : 'text-gray-700 dark:text-gray-300'
                            }`}
                          >
                            {message.senderName}
                          </span>
                          <span
                            className={`text-xs ${
                              message.senderType === 'tenant_admin'
                                ? 'text-success-200'
                                : 'text-gray-500 dark:text-gray-400'
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
                              <CheckCheck size={14} className="text-success-200" />
                            ) : (
                              <CheckCheck size={14} className="text-success-300 opacity-50" />
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
                  <div className="flex items-end gap-3">
                    <div className="flex-1">
                      <Textarea
                        className="resize-none"
                        fullWidth
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        placeholder="Type your message..."
                        rows={3}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            handleSendMessage();
                          }
                        }}
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Button variant="ghost" iconOnly aria-label="Attach file">
                        <Paperclip size={20} />
                      </Button>
                      <Button
                        variant="primary"
                        iconOnly
                        aria-label="Send"
                        onClick={handleSendMessage}
                        disabled={!newMessage.trim() || sendMessageMutation.isPending}
                      >
                        <Send size={20} />
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-2">
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      Press Ctrl+Enter to send
                    </div>
                    {sendError && (
                      <div className="flex items-center gap-1 text-xs text-error-600 dark:text-error-400">
                        <AlertCircle size={12} />
                        {sendError}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Closed Thread Notice */}
              {selectedThread.isClosed && (
                <div className="bg-gray-100 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 px-6 py-4 text-center">
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    This conversation is closed. Start a new conversation if you need further
                    assistance.
                  </p>
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

      {/* New Thread Modal */}
      {showNewThreadModal && (
        <NewThreadModal
          onClose={() => setShowNewThreadModal(false)}
          onSubmit={async (subject, content) => {
            // senderName/senderId are resolved server-side from the authenticated user.
            await createThreadMutation.mutateAsync({ subject, content });
            setShowNewThreadModal(false);
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
      // BUG-014: Show inline error instead of alert()
      setSubmitError(sanitizeErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="md"
      title="New Conversation"
      showCloseButton={!submitting}
      closeOnEscape={!submitting}
      closeOnOverlayClick={!submitting}
      bodyClassName="p-6 space-y-4"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!subject || !message || submitting}
          >
            {submitting ? <Spinner size="sm" color="inherit" /> : <MessageSquare size={18} />}
            {submitting ? 'Creating...' : 'Start Conversation'}
          </Button>
        </>
      }
    >
      <Input
        label="Subject"
        fullWidth
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Enter subject..."
      />

      <Textarea
        label="Message"
        className="resize-none"
        fullWidth
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={5}
        placeholder="Describe your question or issue..."
      />
      {submitError && (
        <div className="flex items-center gap-2 p-3 bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-300 rounded-lg text-sm">
          <AlertCircle size={16} className="flex-shrink-0" />
          {submitError}
        </div>
      )}
    </Modal>
  );
};

export default TenantMessagesPage;
