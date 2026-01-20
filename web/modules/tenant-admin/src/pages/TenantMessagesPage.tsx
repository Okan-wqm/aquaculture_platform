/**
 * TenantMessagesPage
 *
 * Messaging interface for TenantAdmin to communicate with SuperAdmin.
 * Thread-based conversations with read receipts.
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
import { messagingApi, type MessageThread, type Message } from '../services/tenantApi';
import { useAuthContext } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

// Types are imported from tenantApi

// ============================================================================
// Component
// ============================================================================

const TenantMessagesPage: React.FC = () => {
  const { user } = useAuthContext();
  const [threads, setThreads] = useState<MessageThread[]>([]);
  const [selectedThread, setSelectedThread] = useState<MessageThread | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [newMessage, setNewMessage] = useState('');
  const [showNewThreadModal, setShowNewThreadModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Fetch threads from backend
  const fetchThreads = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await messagingApi.getThreads();
      setThreads(result.data || []);
    } catch (err) {
      console.error('Failed to fetch threads:', err);
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    } finally {
      setLoading(false);
    }
  };

  // Fetch messages for selected thread
  const fetchMessages = async (threadId: string) => {
    try {
      setMessagesLoading(true);
      const msgs = await messagingApi.getThreadMessages(threadId);
      setMessages(msgs || []);
      
      // Mark as read
      await messagingApi.markAsRead(threadId);
      
      // Refresh threads to update unread count
      fetchThreads();
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    } finally {
      setMessagesLoading(false);
    }
  };

  useEffect(() => {
    fetchThreads();
  }, []);

  useEffect(() => {
    if (selectedThread) {
      fetchMessages(selectedThread.id);
    }
  }, [selectedThread]);

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

    try {
      const userName = user?.firstName && user?.lastName 
        ? `${user.firstName} ${user.lastName}` 
        : user?.email || 'You';
      
      await messagingApi.sendMessage(selectedThread.id, newMessage, userName);
      setNewMessage('');
      
      // Refresh messages
      await fetchMessages(selectedThread.id);
      
      // Refresh threads to update last message
      fetchThreads();
    } catch (err) {
      console.error('Failed to send message:', err);
      alert('Failed to send message. Please try again.');
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
              className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 disabled:opacity-50"
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
            <div className="text-xl font-semibold text-gray-900">{threads.length}</div>
          </div>
          <div className="bg-tenant-50 rounded-lg p-3">
            <div className="text-sm text-tenant-600">Active</div>
            <div className="text-xl font-semibold text-tenant-700">
              {threads.filter((t) => !t.isClosed).length}
            </div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-sm text-gray-500">Closed</div>
            <div className="text-xl font-semibold text-gray-900">
              {threads.filter((t) => t.isClosed).length}
            </div>
          </div>
          <div className="bg-red-50 rounded-lg p-3">
            <div className="text-sm text-red-600">Unread</div>
            <div className="text-xl font-semibold text-red-700">
              {threads.reduce((sum, t) => sum + t.unreadCount, 0)}
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
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
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
                <MessageSquare size={48} className="mb-2 text-gray-300" />
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
                    <div className="flex items-center gap-2 mt-2 text-xs text-gray-400">
                      <Clock size={12} />
                      <span>{formatTime(thread.lastMessageAt)}</span>
                      <span>·</span>
                      <span>{thread.messageCount} messages</span>
                    </div>
                  </div>
                    <div className="flex flex-col items-end ml-2">
                      {thread.isClosed && (
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
                      {selectedThread.isClosed && (
                        <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                          Closed
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-500">{selectedThread.messageCount} messages</p>
                  </div>
                  <button className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
                    <MoreVertical size={18} />
                  </button>
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
                    <MessageSquare size={48} className="mb-2 text-gray-300" />
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
                            message.senderType === 'tenant_admin' ? 'text-tenant-200' : 'text-gray-400'
                          }`}
                        >
                          {formatTime(message.createdAt)}
                        </span>
                      </div>
                      <p className="text-sm whitespace-pre-wrap">{message.content}</p>

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
              {!selectedThread.isClosed && (
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
                      <button className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
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
                  <div className="text-xs text-gray-400 mt-2">Press Ctrl+Enter to send</div>
                </div>
              )}

              {/* Closed Thread Notice */}
              {selectedThread.isClosed && (
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
                <MessageSquare size={64} className="mx-auto mb-4 text-gray-300" />
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
              const userName = user?.firstName && user?.lastName 
                ? `${user.firstName} ${user.lastName}` 
                : user?.email || 'User';
              
              await messagingApi.createThread(subject, content, userName);
              setShowNewThreadModal(false);
              
              // Refresh threads
              await fetchThreads();
            } catch (err) {
              console.error('Failed to create thread:', err);
              alert('Failed to create conversation. Please try again.');
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

  const handleSubmit = async () => {
    if (!subject.trim() || !message.trim()) return;
    
    try {
      setSubmitting(true);
      await onSubmit(subject, message);
    } catch (err) {
      // Error handled by parent
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">New Conversation</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
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
