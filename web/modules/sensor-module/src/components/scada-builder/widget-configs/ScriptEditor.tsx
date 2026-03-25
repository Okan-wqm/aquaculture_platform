/**
 * Lightweight script editor for SCADA client-side scripts.
 *
 * Design decision: Uses a standard <textarea> with monospace font instead of
 * Monaco/CodeMirror. This keeps the bundle small (~0KB vs ~200KB) which matters
 * for edge deployments where bandwidth is constrained.
 *
 * Features:
 * - Monospace textarea with CSS counter-based line numbers
 * - Tab key inserts 2 spaces (prevents focus trap)
 * - Script name and enable/disable toggle
 * - "Test Run" button with last run status display
 * - Collapsible API reference showing sandbox-available functions
 */

import React, { useCallback, useRef, useState } from 'react';
import { Trash2, Play, ChevronDown, ChevronRight, Power, BookOpen } from 'lucide-react';
import type { ScadaScript } from '../../../engine/events/types';

/** Shared input class to match existing panel styling. */
const INPUT_CLASS =
  'w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

interface ScriptEditorProps {
  script: ScadaScript;
  onChange: (updates: Partial<ScadaScript>) => void;
  onDelete: () => void;
  onTest: () => void;
}

/**
 * Available sandbox API functions displayed in the collapsible reference.
 * These mirror the ScriptExecutor API that Phase 5A exposes inside the
 * Web Worker sandbox, so operators know what's available without docs.
 */
const API_REFERENCE: Array<{ fn: string; desc: string }> = [
  { fn: '$getTag(name)', desc: 'Read a tag value by name' },
  { fn: '$setTag(name, value)', desc: 'Write a value to a tag' },
  { fn: '$log(message)', desc: 'Log a message to the console' },
  { fn: '$alarm(severity, message)', desc: 'Trigger a runtime alarm' },
  { fn: '$navigate(screenId)', desc: 'Navigate to another screen' },
  { fn: '$getTime()', desc: 'Get current timestamp (ms)' },
  { fn: '$delay(ms)', desc: 'Async wait (capped at 5000ms)' },
];

export const ScriptEditor: React.FC<ScriptEditorProps> = ({
  script,
  onChange,
  onDelete,
  onTest,
}) => {
  const [showApiRef, setShowApiRef] = useState(false);
  const [lastRunStatus, setLastRunStatus] = useState<{
    success: boolean;
    message: string;
    durationMs: number;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Intercept Tab key to insert 2 spaces instead of moving focus.
   * This is the standard UX pattern for code editors -- operators
   * expect Tab to indent, not jump to the next form field.
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const target = e.currentTarget;
        const start = target.selectionStart;
        const end = target.selectionEnd;
        const indent = '  ';

        // Insert 2 spaces at cursor position
        const newCode = script.code.substring(0, start) + indent + script.code.substring(end);
        onChange({ code: newCode });

        // Restore cursor position after React re-render
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.selectionStart = start + indent.length;
            textareaRef.current.selectionEnd = start + indent.length;
          }
        });
      }
    },
    [script.code, onChange],
  );

  const handleTestClick = useCallback(() => {
    const startTime = performance.now();
    try {
      onTest();
      setLastRunStatus({
        success: true,
        message: 'Test passed',
        durationMs: Math.round(performance.now() - startTime),
      });
    } catch (err) {
      setLastRunStatus({
        success: false,
        message: err instanceof Error ? err.message : 'Unknown error',
        durationMs: Math.round(performance.now() - startTime),
      });
    }
  }, [onTest]);

  /** Line count derived from newlines in the code string. */
  const lineCount = Math.max(script.code.split('\n').length, 1);

  return (
    <div className="space-y-2" data-testid="script-editor">
      {/* Header: name + enabled toggle + delete */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={script.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Script name"
          className="flex-1 px-2 py-1.5 text-xs font-medium border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          data-testid="script-name-input"
        />
        <button
          onClick={() => onChange({ enabled: !script.enabled })}
          className={`p-1.5 rounded-lg border transition-colors ${
            script.enabled
              ? 'bg-green-50 border-green-300 text-green-600'
              : 'bg-gray-50 border-gray-300 text-gray-400'
          }`}
          title={script.enabled ? 'Disable script' : 'Enable script'}
          data-testid="script-enabled-toggle"
        >
          <Power className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onDelete}
          className="p-1.5 text-red-400 hover:text-red-600 rounded-lg border border-gray-200 hover:border-red-200 transition-colors"
          title="Delete script"
          data-testid="script-delete-btn"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Code editor with line number gutter */}
      <div className="relative flex border border-gray-300 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-cyan-500 focus-within:border-cyan-500">
        {/* Line number gutter -- read-only, styled to match textarea lines */}
        <div
          className="flex-shrink-0 bg-gray-100 text-gray-400 text-right select-none px-2 py-2 text-xs leading-[1.375rem] font-mono border-r border-gray-300"
          aria-hidden="true"
          data-testid="line-numbers"
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          value={script.code}
          onChange={(e) => onChange({ code: e.target.value })}
          onKeyDown={handleKeyDown}
          rows={12}
          spellCheck={false}
          className="flex-1 px-3 py-2 text-xs font-mono leading-[1.375rem] resize-y border-none focus:outline-none focus:ring-0"
          placeholder="// Write your script here..."
          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}
          data-testid="script-code-textarea"
        />
      </div>

      {/* Footer: Test Run + status */}
      <div className="flex items-center justify-between">
        <button
          onClick={handleTestClick}
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-lg hover:bg-cyan-100 transition-colors"
          data-testid="script-test-btn"
        >
          <Play className="w-3 h-3" />
          Test Run
        </button>
        {lastRunStatus && (
          <span
            className={`text-[10px] font-mono ${
              lastRunStatus.success ? 'text-green-600' : 'text-red-600'
            }`}
            data-testid="script-run-status"
          >
            {lastRunStatus.success ? 'OK' : 'ERR'}: {lastRunStatus.message} ({lastRunStatus.durationMs}ms)
          </span>
        )}
      </div>

      {/* Collapsible API reference */}
      <div className="pt-1 border-t border-gray-200">
        <button
          onClick={() => setShowApiRef(!showApiRef)}
          className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-600 transition-colors"
          data-testid="api-ref-toggle"
        >
          {showApiRef ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
          <BookOpen className="w-3 h-3" />
          Sandbox API Reference
        </button>
        {showApiRef && (
          <div className="mt-1 space-y-0.5" data-testid="api-ref-panel">
            {API_REFERENCE.map((item) => (
              <div key={item.fn} className="flex items-baseline gap-2 text-[10px]">
                <code className="text-cyan-700 font-mono whitespace-nowrap bg-cyan-50 px-1 rounded">
                  {item.fn}
                </code>
                <span className="text-gray-500">{item.desc}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
