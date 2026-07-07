import { useAuth } from '@aquaculture/shared-ui';
import { ArrowLeft, Send, Sparkles, RefreshCw } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

import { useChannelMessages, useSendMessage } from '../hooks/useMessagingData';
import { useMessagingSocket } from '../hooks/useMessagingSocket';
import type { Message } from '../types/messaging';

function senderName(m: Message): string {
  const u = m.sender;
  return [u?.firstName, u?.lastName].filter(Boolean).join(' ') || 'Member';
}

const ChatRoomPage: React.FC = () => {
  const { channelId } = useParams<{ channelId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const myId = user?.id;

  const { data: messages, isLoading } = useChannelMessages(channelId);
  const sendMutation = useSendMessage(channelId);
  useMessagingSocket(channelId);

  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const handleSend = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sendMutation.isPending) return;
    setDraft('');
    try {
      await sendMutation.mutateAsync(text);
    } catch {
      setDraft(text); // restore on failure
    }
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col overflow-hidden rounded-lg border border-gray-200 bg-white">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3">
        <button
          onClick={() => navigate('/messaging')}
          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          aria-label="Back to channels"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <span className="text-sm font-semibold text-gray-900">Conversation</span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <RefreshCw className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
        {messages?.filter((m) => !m.isDeleted).map((m) => {
          const mine = m.senderId === myId;
          return (
            <div key={m.id} className={mine ? 'flex justify-end' : 'flex justify-start'}>
              <div className="max-w-[80%]">
                {!mine && (
                  <div className="mb-0.5 flex items-center gap-1 text-xs text-gray-400">
                    {m.isAiGenerated && <Sparkles className="h-3 w-3 text-tenant-600" />}
                    {m.isAiGenerated ? 'AI Assistant' : senderName(m)}
                  </div>
                )}
                <div
                  className={
                    mine
                      ? 'rounded-2xl rounded-br-sm bg-tenant-600 px-3 py-2 text-sm text-white'
                      : m.isAiGenerated
                        ? 'rounded-2xl rounded-bl-sm border border-tenant-100 bg-tenant-50 px-3 py-2 text-sm text-gray-800'
                        : 'rounded-2xl rounded-bl-sm bg-gray-100 px-3 py-2 text-sm text-gray-800'
                  }
                >
                  <span className="whitespace-pre-wrap">{m.content}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Composer */}
      <div className="border-t border-gray-200 p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            rows={1}
            placeholder="Type a message…"
            className="max-h-32 flex-1 resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-transparent focus:outline-hidden focus:ring-2 focus:ring-tenant-500"
          />
          <button
            onClick={() => void handleSend()}
            disabled={!draft.trim() || sendMutation.isPending}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-tenant-600 text-white hover:bg-tenant-700 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatRoomPage;
