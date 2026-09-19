/**
 * Scripts management panel for the SCADA package builder.
 *
 * Rendered as a tab in the PropertiesPanel alongside Widget, Events,
 * Animations, etc. Unlike those widget-scoped tabs, ScriptsPanel operates
 * at the *package* level -- scripts belong to the entire SCADA package
 * and can be referenced by any widget's runScript event action.
 *
 * Layout:
 * - "Add Script" button at top
 * - List of script cards, each expandable to show:
 *   - ScriptEditor (name, code, enable, delete, test)
 *   - ScriptTriggerConfig (when the script fires)
 * - Collapsed cards show: name + trigger badge + enabled dot
 */

import React, { useState, useCallback } from 'react';
import { Button } from '@aquaculture/shared-ui';
import { Plus, ChevronDown, ChevronRight, Code2 } from 'lucide-react';
import type { ScadaScript, ScriptTrigger } from '../../../engine/events/types';
import { ScriptEditor } from './ScriptEditor';
import { ScriptTriggerConfig } from './ScriptTriggerConfig';

interface ScriptsPanelProps {
  scripts: ScadaScript[];
  onChange: (scripts: ScadaScript[]) => void;
  onTestScript: (scriptId: string) => void;
  /** Edge device ID for tag discovery in TagBrowser */
  deviceId?: string | null;
}

/** Human-readable labels for trigger type badges */
const TRIGGER_LABELS: Record<ScriptTrigger, string> = {
  event: 'Event',
  tagChange: 'Tag',
  interval: 'Timer',
  load: 'Load',
};

/** Badge color classes keyed by trigger type */
const TRIGGER_BADGE_CLASS: Record<ScriptTrigger, string> = {
  event: 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300',
  tagChange: 'bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300',
  interval: 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300',
  load: 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300',
};

export const ScriptsPanel: React.FC<ScriptsPanelProps> = ({
  scripts,
  onChange,
  onTestScript,
  deviceId,
}) => {
  /** Track which script cards are expanded by ID. */
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  /**
   * Add a new script with sensible defaults.
   * Auto-expands the new card so the operator can start editing immediately.
   */
  const addScript = useCallback(() => {
    const id = crypto.randomUUID();
    const newScript: ScadaScript = {
      id,
      name: `Script ${scripts.length + 1}`,
      code: '',
      trigger: 'event',
      enabled: true,
    };
    onChange([...scripts, newScript]);
    setExpandedIds((prev) => ({ ...prev, [id]: true }));
  }, [scripts, onChange]);

  /** Update a single script by merging partial updates. */
  const updateScript = useCallback(
    (id: string, updates: Partial<ScadaScript>) => {
      onChange(scripts.map((s) => (s.id === id ? { ...s, ...updates } : s)));
    },
    [scripts, onChange],
  );

  /** Remove a script and clean up expanded state. */
  const deleteScript = useCallback(
    (id: string) => {
      onChange(scripts.filter((s) => s.id !== id));
      setExpandedIds((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [scripts, onChange],
  );

  const getTrigger = (script: ScadaScript): ScriptTrigger => script.trigger ?? 'event';

  return (
    <div className="space-y-3" data-testid="scripts-panel">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
          <Code2 className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          Scripts
        </h4>
        <Button
          variant="ghost"
          size="xs"
          leftIcon={<Plus className="w-3 h-3" />}
          onClick={addScript}
          data-testid="add-script-btn"
        >
          Add Script
        </Button>
      </div>

      {/* Empty state */}
      {scripts.length === 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400 py-4 text-center">
          No scripts configured. Scripts enable custom logic via a sandboxed executor.
        </p>
      )}

      {/* Script cards */}
      {scripts.map((script) => {
        const isExpanded = !!expandedIds[script.id];

        return (
          <div
            key={script.id}
            className="bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-100 dark:border-gray-700 overflow-hidden"
            data-testid={`script-card-${script.id}`}
          >
            {/* Collapsed header -- always visible */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => toggleExpanded(script.id)}
              data-testid={`script-toggle-${script.id}`}
            >
              {isExpanded ? (
                <ChevronDown className="w-3 h-3 text-gray-400 dark:text-gray-500 flex-shrink-0" />
              ) : (
                <ChevronRight className="w-3 h-3 text-gray-400 dark:text-gray-500 flex-shrink-0" />
              )}
              <span className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate flex-1">
                {script.name || 'Unnamed Script'}
              </span>
              <span
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                  TRIGGER_BADGE_CLASS[getTrigger(script)]
                }`}
              >
                {TRIGGER_LABELS[getTrigger(script)]}
              </span>
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  script.enabled ? 'bg-success-500' : 'bg-gray-300'
                }`}
                title={script.enabled ? 'Enabled' : 'Disabled'}
              />
            </Button>

            {/* Expanded body -- editor + trigger config */}
            {isExpanded && (
              <div className="px-3 pb-3 space-y-3 border-t border-gray-200 dark:border-gray-700 pt-3">
                <ScriptTriggerConfig
                  trigger={getTrigger(script)}
                  triggerTag={script.triggerTag}
                  triggerInterval={script.triggerInterval}
                  deviceId={deviceId}
                  onChange={(updates) => updateScript(script.id, updates)}
                />
                <ScriptEditor
                  script={script}
                  onChange={(updates) => updateScript(script.id, updates)}
                  onDelete={() => deleteScript(script.id)}
                  onTest={() => onTestScript(script.id)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
