/**
 * EventsPanel — UI for adding/editing/removing WidgetEventDef[] on a widget.
 *
 * Tag selection uses the device-aware TagBrowser component instead of
 * plain text inputs. This ensures tag names are valid, discoverable,
 * and consistent with the device's actual tag inventory.
 * The deviceId comes from the SCADA package's target edge device.
 *
 * Phase 5B: runScript and openUrl actions are now enabled. runScript
 * references a package-level script by ID. openUrl validates that the
 * URL uses https:// protocol on the main thread before opening.
 */

import React, { useState } from 'react';
import { Button, Input, Select } from '@aquaculture/shared-ui';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import type {
  WidgetEventDef,
  EventTrigger,
  EventAction,
  ScadaScript,
} from '../../../engine/events/types';
import { useScadaPackageStore } from '../../../store/scada';
import { TagBrowser } from '../TagBrowser';

const TRIGGERS: EventTrigger[] = [
  'click',
  'dblclick',
  'mousedown',
  'mouseup',
  'mouseover',
  'mouseout',
];

/**
 * All available event actions including sandbox-backed runScript and openUrl.
 * These were re-enabled in Phase 5B now that the Web Worker sandbox provides
 * secure execution isolation for scripts and URL validation for openUrl.
 */
const ACTIONS: EventAction[] = [
  'navigate',
  'openCard',
  'openDialog',
  'setValue',
  'toggleValue',
  'runScript',
  'openUrl',
  'setProperty',
  'closeDialog',
];

/** Human-readable labels for actions in the dropdown. */
const ACTION_LABELS: Record<EventAction, string> = {
  navigate: 'Navigate',
  openCard: 'Open Card',
  openDialog: 'Open Dialog',
  setValue: 'Set Value',
  toggleValue: 'Toggle Value',
  runScript: 'Run Script',
  openUrl: 'Open URL',
  setProperty: 'Set Property',
  closeDialog: 'Close Dialog',
};

interface EventsPanelProps {
  events: WidgetEventDef[];
  onChange: (events: WidgetEventDef[]) => void;
  /** Edge device ID for tag discovery via TagBrowser */
  deviceId?: string | null;
  /** Package-level scripts for runScript action's script selector */
  scripts?: ScadaScript[];
}

/**
 * Inline URL input with https:// protocol validation.
 * Validates on every keystroke and shows a warning for non-https URLs
 * to prevent javascript: injection and open-redirect attacks.
 */
const OpenUrlConfig: React.FC<{ url: string; onChange: (url: string) => void }> = ({
  url,
  onChange,
}) => {
  const isValid = url === '' || /^https:\/\/.+/.test(url);

  return (
    <div data-testid="openurl-config">
      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
        URL (https:// only)
      </label>
      <input
        type="url"
        value={url}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://example.com/dashboard"
        className={`w-full px-2 py-1.5 text-xs border rounded-lg focus:ring-2 focus:border-info-500 ${
          !isValid
            ? 'border-error-300 dark:border-error-700 focus:ring-error-500 bg-error-50 dark:bg-error-900/20'
            : 'border-gray-300 dark:border-gray-600 focus:ring-info-500'
        }`}
        data-testid="openurl-input"
      />
      {!isValid && url !== '' && (
        <div
          className="flex items-center gap-1 mt-1 text-[10px] text-error-600 dark:text-error-400"
          data-testid="openurl-error"
        >
          <AlertTriangle className="w-3 h-3" />
          Only https:// URLs are allowed for security.
        </div>
      )}
    </div>
  );
};

export const EventsPanel: React.FC<EventsPanelProps> = ({
  events,
  onChange,
  deviceId,
  scripts = [],
}) => {
  const screens = useScadaPackageStore((s) => s.screens);

  const addEvent = () => {
    const newEvent: WidgetEventDef = {
      id: crypto.randomUUID(),
      trigger: 'click',
      action: 'navigate',
      params: {},
    };
    onChange([...events, newEvent]);
  };

  const updateEvent = (id: string, updates: Partial<WidgetEventDef>) => {
    onChange(events.map((ev) => (ev.id === id ? { ...ev, ...updates } : ev)));
  };

  const updateEventParams = (id: string, paramUpdates: Record<string, unknown>) => {
    onChange(
      events.map((ev) =>
        ev.id === id ? { ...ev, params: { ...ev.params, ...paramUpdates } } : ev,
      ),
    );
  };

  const removeEvent = (id: string) => {
    onChange(events.filter((ev) => ev.id !== id));
  };

  const handleActionChange = (id: string, action: EventAction) => {
    // Reset params when action changes
    updateEvent(id, { action, params: {} });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Events</h4>
        <Button
          variant="ghost"
          size="xs"
          leftIcon={<Plus className="w-3 h-3" />}
          onClick={addEvent}
        >
          Add Event
        </Button>
      </div>

      {events.length === 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400 py-4 text-center">
          No events configured.
        </p>
      )}

      {events.map((ev) => (
        <div
          key={ev.id}
          className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg space-y-2 border border-gray-100 dark:border-gray-700"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase">
              Event
            </span>
            <Button variant="ghost" iconOnly aria-label="Delete" onClick={() => removeEvent(ev.id)}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>

          {/* Trigger */}
          <Select
            label="Trigger"
            value={ev.trigger}
            onChange={(e) => updateEvent(ev.id, { trigger: e.target.value as EventTrigger })}
            options={TRIGGERS.map((t) => ({ value: t, label: t }))}
          />

          {/* Action */}
          <Select
            label="Action"
            value={ev.action}
            onChange={(e) => handleActionChange(ev.id, e.target.value as EventAction)}
            options={ACTIONS.map((a) => ({ value: a, label: ACTION_LABELS[a] }))}
          />

          {/* Conditional fields based on action */}
          {(ev.action === 'navigate' || ev.action === 'openCard' || ev.action === 'openDialog') && (
            <Select
              label="Target Screen"
              value={(ev.params.targetScreenId as string) || ''}
              onChange={(e) =>
                updateEventParams(ev.id, { targetScreenId: e.target.value || undefined })
              }
              placeholder="Select screen..."
              options={screens.map((screen) => ({
                value: screen.id,
                label: `[${screen.screenType}] ${screen.name}`,
              }))}
            />
          )}

          {(ev.action === 'openCard' || ev.action === 'openDialog') && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Input
                label="Width"
                fullWidth
                type="number"
                value={(ev.params.width as number) ?? ''}
                onChange={(e) =>
                  updateEventParams(ev.id, {
                    width: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
                placeholder="px"
                min={100}
              />
              <Input
                label="Height"
                fullWidth
                type="number"
                value={(ev.params.height as number) ?? ''}
                onChange={(e) =>
                  updateEventParams(ev.id, {
                    height: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
                placeholder="px"
                min={100}
              />
            </div>
          )}

          {/* Variable Mapping for overlay actions */}
          {(ev.action === 'openCard' || ev.action === 'openDialog') && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] text-gray-500 dark:text-gray-400">
                  Variable Mapping
                </label>
                <Button
                  variant="ghost"
                  onClick={() => {
                    const existing = (ev.params.variableMap ?? {}) as Record<string, string>;
                    const map: Record<string, string> = { ...existing };
                    map[`placeholder_${Object.keys(map).length + 1}`] = '';
                    updateEvent(ev.id, { params: { ...ev.params, variableMap: map } });
                  }}
                >
                  + Add
                </Button>
              </div>
              {Object.entries((ev.params.variableMap ?? {}) as Record<string, string>).map(
                ([placeholder, realTag]) => (
                  <div key={placeholder} className="flex items-center gap-1 mb-1">
                    <Input
                      type="text"
                      value={placeholder}
                      onChange={(e) => {
                        const existing = (ev.params.variableMap ?? {}) as Record<string, string>;
                        const map: Record<string, string> = { ...existing };
                        const val = map[placeholder];
                        delete map[placeholder];
                        map[e.target.value] = val ?? '';
                        updateEvent(ev.id, { params: { ...ev.params, variableMap: map } });
                      }}
                      placeholder="placeholder_tag"
                    />
                    <span className="text-[10px] text-gray-400 dark:text-gray-500">{'\u2192'}</span>
                    <Input
                      type="text"
                      value={realTag}
                      onChange={(e) => {
                        const existing = (ev.params.variableMap ?? {}) as Record<string, string>;
                        const map: Record<string, string> = { ...existing };
                        map[placeholder] = e.target.value;
                        updateEvent(ev.id, { params: { ...ev.params, variableMap: map } });
                      }}
                      placeholder="real_tag"
                    />
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        const existing = (ev.params.variableMap ?? {}) as Record<string, string>;
                        const map: Record<string, string> = { ...existing };
                        delete map[placeholder];
                        updateEvent(ev.id, { params: { ...ev.params, variableMap: map } });
                      }}
                    >
                      {'\u00d7'}
                    </Button>
                  </div>
                ),
              )}
            </div>
          )}

          {ev.action === 'setValue' && (
            <>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                  Target Tag
                </label>
                <TagBrowser
                  deviceId={deviceId ?? null}
                  value={(ev.params.targetTag as string) || ''}
                  onChange={(tag) => updateEventParams(ev.id, { targetTag: tag })}
                  placeholder="Select target tag..."
                />
              </div>
              <Input
                label="Value"
                fullWidth
                type="text"
                value={ev.params.value != null ? String(ev.params.value) : ''}
                onChange={(e) => updateEventParams(ev.id, { value: e.target.value })}
                placeholder="Value to set"
              />
            </>
          )}

          {ev.action === 'toggleValue' && (
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                Toggle Tag
              </label>
              <TagBrowser
                deviceId={deviceId ?? null}
                value={(ev.params.toggleTag as string) || ''}
                onChange={(tag) => updateEventParams(ev.id, { toggleTag: tag })}
                placeholder="Select toggle tag..."
              />
            </div>
          )}

          {/* runScript: Select a script from the package's script list.
             The script executes via the ScriptExecutor sandbox when the event fires. */}
          {ev.action === 'runScript' && (
            <div data-testid="runscript-config">
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Script</label>
              {scripts.length > 0 ? (
                <Select
                  value={(ev.params.scriptId as string) || ''}
                  onChange={(e) =>
                    updateEventParams(ev.id, { scriptId: e.target.value || undefined })
                  }
                  data-testid="runscript-select"
                  placeholder="Select script..."
                  options={scripts
                    .filter((s) => s.enabled)
                    .map((s) => ({ value: s.id, label: s.name }))}
                />
              ) : (
                <p className="text-[10px] text-warning-600 dark:text-warning-400 bg-warning-50 dark:bg-warning-900/20 px-2 py-1.5 rounded-lg">
                  No scripts defined. Add scripts in the Scripts tab first.
                </p>
              )}
            </div>
          )}

          {/* openUrl: Opens a URL in a new tab after validating the protocol.
             Only https:// URLs are allowed to prevent javascript: injection
             and other open-redirect / SSRF attacks. */}
          {ev.action === 'openUrl' && (
            <OpenUrlConfig
              url={(ev.params.url as string) || ''}
              onChange={(url) => updateEventParams(ev.id, { url })}
            />
          )}

          {/* setProperty: Dynamically change another widget's config property.
             Enables interactive patterns like: click button -> change color. */}
          {ev.action === 'setProperty' && (
            <div className="space-y-2" data-testid="setproperty-config">
              <Input
                label="Target Widget ID"
                className="font-mono"
                fullWidth
                type="text"
                value={(ev.params.targetWidgetId as string) || ''}
                onChange={(e) =>
                  updateEventParams(ev.id, { targetWidgetId: e.target.value || undefined })
                }
                placeholder="widget-uuid-here"
                data-testid="target-widget-id-input"
              />
              <Input
                label="Property Path"
                className="font-mono"
                fullWidth
                type="text"
                value={(ev.params.propertyPath as string) || ''}
                onChange={(e) =>
                  updateEventParams(ev.id, { propertyPath: e.target.value || undefined })
                }
                placeholder="fill, config.opacity, etc."
                data-testid="property-path-input"
              />
              <Input
                label="Value"
                fullWidth
                type="text"
                value={ev.params.propertyValue != null ? String(ev.params.propertyValue) : ''}
                onChange={(e) => {
                  const raw = e.target.value;
                  // Auto-detect type: boolean, number, or string
                  let parsed: string | number | boolean = raw;
                  if (raw === 'true') parsed = true;
                  else if (raw === 'false') parsed = false;
                  else if (raw !== '' && !Number.isNaN(Number(raw))) parsed = Number(raw);
                  updateEventParams(ev.id, { propertyValue: parsed });
                }}
                placeholder="Value (auto-detects type)"
                data-testid="property-value-input"
              />
            </div>
          )}

          {/* closeDialog: Closes the topmost overlay — no parameters needed. */}
          {ev.action === 'closeDialog' && (
            <div
              className="px-2 py-2 text-[10px] text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-lg"
              data-testid="closedialog-config"
            >
              Closes the topmost popup card or modal dialog. No additional configuration needed.
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
