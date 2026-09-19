import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Send, RefreshCw, AlertCircle } from 'lucide-react';
import { Drawer, useAuth } from '@aquaculture/shared-ui';
import {
  AI_GENERAL_ASSISTANT_PICKER_ENTRY,
  AI_PERSONA_CATALOGUE,
  type AiPersonaCatalogueEntry,
} from '@aquaculture/shared-contracts';
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

/** The `<select>` value for "no persona pinned" (the tenant default). */
const DEFAULT_PERSONA_VALUE = '';

/**
 * Shell-level AI assistant drawer. Opens over any module; talks to ai-service
 * through the gateway `/ai` socket.io bridge. Only mounts a live socket while
 * open. A key_missing / FORBIDDEN error steers the user to AI settings rather
 * than showing a raw failure.
 *
 * The persona picker offers the tenant default plus every catalogue persona
 * whose required capabilities the signed-in user holds — the same rule
 * ai-service enforces per turn, so nothing offered here is later refused.
 */
const AiAssistantDrawer: React.FC<AiAssistantDrawerProps> = ({ open, onClose }) => {
  const { hasPermission } = useAuth();
  const { messages, status, persona, setPersona, sendMessage, reset } = useAiAssistantSocket(open);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const permittedPersonas = useMemo<readonly AiPersonaCatalogueEntry[]>(
    () =>
      AI_PERSONA_CATALOGUE.filter((entry) =>
        entry.requiredCapabilities.every((capability) => hasPermission(capability)),
      ),
    [hasPermission],
  );
  const selected =
    permittedPersonas.find((entry) => entry.id === persona) ?? AI_GENERAL_ASSISTANT_PICKER_ENTRY;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, status]);

  const handleSend = () => {
    if (!draft.trim() || status === 'thinking') return;
    sendMessage(draft);
    setDraft('');
  };

  return (
    <Drawer
      isOpen={open}
      onClose={onClose}
      side="right"
      size="md"
      closeLabel="Close"
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary-600" />
          <span>AI Assistant</span>
        </span>
      }
      description={STATUS_LABEL[status]}
      bodyClassName="flex-1 min-h-0 flex flex-col"
      footer={
        <div className="w-full">
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
              className="max-h-32 flex-1 resize-none rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm focus:border-transparent focus:outline-hidden focus:ring-2 focus:ring-primary-500 disabled:bg-gray-100 dark:disabled:bg-gray-800"
            />
            <button
              onClick={handleSend}
              disabled={!draft.trim() || status === 'thinking' || status === 'offline'}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary-600 text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
              title="Send"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      }
    >
      <div className="flex items-center justify-end border-b border-gray-100 dark:border-gray-700 px-2 py-1">
        <button
          type="button"
          onClick={reset}
          title="New conversation"
          className="rounded-lg p-2 text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>
      {/* Persona picker — switching starts a new conversation. */}
      <div className="border-b border-gray-100 px-4 py-2">
        <label htmlFor="ai-assistant-persona" className="sr-only">
          Assistant
        </label>
        <select
          id="ai-assistant-persona"
          value={persona ?? DEFAULT_PERSONA_VALUE}
          onChange={(e) =>
            setPersona(e.target.value === DEFAULT_PERSONA_VALUE ? null : e.target.value)
          }
          disabled={status === 'thinking'}
          className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm text-gray-800 dark:text-gray-200 focus:border-transparent focus:outline-hidden focus:ring-2 focus:ring-tenant-500 disabled:bg-gray-100 dark:disabled:bg-gray-800"
        >
          <option value={DEFAULT_PERSONA_VALUE}>{AI_GENERAL_ASSISTANT_PICKER_ENTRY.name}</option>
          {permittedPersonas.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-gray-400">{selected.description}</p>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="mt-10 text-center text-sm text-gray-400 dark:text-gray-500">
            <Sparkles className="mx-auto mb-2 h-8 w-8 text-gray-300" />
            Ask about your farm — batches, water quality, feeding, tasks.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={
                m.role === 'user'
                  ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-primary-600 px-3 py-2 text-sm text-white'
                  : m.errorCode
                    ? 'max-w-[85%] rounded-2xl rounded-bl-sm border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800'
                    : 'max-w-[85%] rounded-2xl rounded-bl-sm bg-gray-100 dark:bg-gray-800 px-3 py-2 text-sm text-gray-800 dark:text-gray-200'
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
            <div className="rounded-2xl rounded-bl-sm bg-gray-100 dark:bg-gray-800 px-3 py-2 text-sm text-gray-400 dark:text-gray-500">
              <RefreshCw className="inline h-4 w-4 animate-spin" />
            </div>
          </div>
        )}
      </div>
    </Drawer>
  );
};

export default AiAssistantDrawer;
