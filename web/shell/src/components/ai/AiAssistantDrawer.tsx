import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, X, Send, RefreshCw, AlertCircle } from 'lucide-react';
import { useAiAssistantSocket, type AiAssistantStatus } from '../../hooks/useAiAssistantSocket';

interface AiAssistantDrawerProps {
  open: boolean;
  onClose: () => void;
}

const STATUS_LABEL: Record<AiAssistantStatus, string> = {
  connecting: 'Connecting…',
  ready: 'Ready',
  thinking: 'Thinking…',
  offline: 'Offline',
};

/**
 * Shell-level AI assistant drawer. Opens over any module; talks to ai-service
 * through the gateway `/ai` socket.io bridge. Only mounts a live socket while
 * open. A key_missing / FORBIDDEN error steers the user to AI settings rather
 * than showing a raw failure.
 */
const AiAssistantDrawer: React.FC<AiAssistantDrawerProps> = ({ open, onClose }) => {
  const { messages, status, sendMessage, reset } = useAiAssistantSocket(open);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, status]);

  const handleSend = () => {
    if (!draft.trim() || status === 'thinking') return;
    sendMessage(draft);
    setDraft('');
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-label="AI assistant">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/20"
        onClick={onClose}
        aria-hidden="true"
      />

      <aside className="relative flex h-full w-full max-w-md flex-col bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-tenant-600" />
            <div>
              <h2 className="text-sm font-semibold text-gray-900">AI Assistant</h2>
              <p className="text-xs text-gray-400">{STATUS_LABEL[status]}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={reset}
              title="New conversation"
              className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              title="Close"
              className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <div className="mt-10 text-center text-sm text-gray-400">
              <Sparkles className="mx-auto mb-2 h-8 w-8 text-gray-300" />
              Ask about your farm — batches, water quality, feeding, tasks.
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
            >
              <div
                className={
                  m.role === 'user'
                    ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-tenant-600 px-3 py-2 text-sm text-white'
                    : m.errorCode
                      ? 'max-w-[85%] rounded-2xl rounded-bl-sm border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800'
                      : 'max-w-[85%] rounded-2xl rounded-bl-sm bg-gray-100 px-3 py-2 text-sm text-gray-800'
                }
              >
                {m.errorCode && (
                  <AlertCircle className="mb-1 inline h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span className="whitespace-pre-wrap">{m.content}</span>
                {m.errorCode === 'AI_KEY_MISSING' && (
                  <span className="mt-1 block text-xs text-amber-700">
                    A tenant admin can add an API key in Settings → AI Assistant.
                  </span>
                )}
              </div>
            </div>
          ))}
          {status === 'thinking' && (
            <div className="flex justify-start">
              <div className="rounded-2xl rounded-bl-sm bg-gray-100 px-3 py-2 text-sm text-gray-400">
                <RefreshCw className="inline h-4 w-4 animate-spin" />
              </div>
            </div>
          )}
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
                  handleSend();
                }
              }}
              rows={1}
              placeholder="Message the assistant…"
              disabled={status === 'offline' || status === 'connecting'}
              className="max-h-32 flex-1 resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-transparent focus:outline-hidden focus:ring-2 focus:ring-tenant-500 disabled:bg-gray-100"
            />
            <button
              onClick={handleSend}
              disabled={!draft.trim() || status === 'thinking' || status === 'offline'}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-tenant-600 text-white hover:bg-tenant-700 disabled:cursor-not-allowed disabled:opacity-50"
              title="Send"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
};

export default AiAssistantDrawer;
