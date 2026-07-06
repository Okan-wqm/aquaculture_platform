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
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import type { WidgetEventDef, EventTrigger, EventAction, ScadaScript } from '../../../engine/events/types';
import { useScadaPackageStore } from '../../../store/scada';
import { TagBrowser } from '../TagBrowser';

const TRIGGERS: EventTrigger[] = ['click', 'dblclick', 'mousedown', 'mouseup', 'mouseover', 'mouseout'];

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
      <label className="block text-xs text-gray-500 mb-1">URL (https:// only)</label>
      <input
        type="url"
        value={url}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://example.com/dashboard"
        className={`w-full px-2 py-1.5 text-xs border rounded-lg focus:ring-2 focus:border-cyan-500 ${
          !isValid
            ? 'border-red-300 focus:ring-red-500 bg-red-50'
            : 'border-gray-300 focus:ring-cyan-500'
        }`}
        data-testid="openurl-input"
      />
      {!isValid && url !== '' && (
        <div className="flex items-center gap-1 mt-1 text-[10px] text-red-600" data-testid="openurl-error">
          <AlertTriangle className="w-3 h-3" />
          Only https:// URLs are allowed for security.
        </div>
      )}
    </div>
  );
};

export const EventsPanel: React.FC<EventsPanelProps> = ({ events, onChange, deviceId, scripts = [] }) => {
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
    onChange(
      events.map((ev) => (ev.id === id ? { ...ev, ...updates } : ev)),
    );
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
        <h4 className="text-sm font-medium text-gray-700">Events</h4>
        <button
          onClick={addEvent}
          className="flex items-center gap-1 text-xs text-cyan-600 hover:text-cyan-700"
        >
          <Plus className="w-3 h-3" />
          Add Event
        </button>
      </div>

      {events.length === 0 && (
        <p className="text-xs text-gray-500 py-4 text-center">No events configured.</p>
      )}

      {events.map((ev) => (
        <div key={ev.id} className="p-3 bg-gray-50 rounded-lg space-y-2 border border-gray-100">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-gray-400 uppercase">Event</span>
            <button
              onClick={() => removeEvent(ev.id)}
              className="text-red-400 hover:text-red-600"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Trigger */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Trigger</label>
            <select
              value={ev.trigger}
              onChange={(e) => updateEvent(ev.id, { trigger: e.target.value as EventTrigger })}
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
            >
              {TRIGGERS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {/* Action */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Action</label>
            <select
              value={ev.action}
              onChange={(e) => handleActionChange(ev.id, e.target.value as EventAction)}
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
            >
              {ACTIONS.map((a) => (
                <option key={a} value={a}>{ACTION_LABELS[a]}</option>
              ))}
            </select>
          </div>

          {/* Conditional fields based on action */}
          {(ev.action === 'navigate' || ev.action === 'openCard' || ev.action === 'openDialog') && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Target Screen</label>
              <select
                value={(ev.params.targetScreenId as string) || ''}
                onChange={(e) => updateEventParams(ev.id, { targetScreenId: e.target.value || undefined })}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              >
                <option value="">Select screen...</option>
                {screens.map((screen) => (
                  <option key={screen.id} value={screen.id}>
                    [{screen.screenType}] {screen.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {(ev.action === 'openCard' || ev.action === 'openDialog') && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Width</label>
                <input
                  type="number"
                  value={(ev.params.width as number) ?? ''}
                  onChange={(e) => updateEventParams(ev.id, { width: e.target.value === '' ? undefined : Number(e.target.value) })}
                  placeholder="px"
                  min={100}
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Height</label>
                <input
                  type="number"
                  value={(ev.params.height as number) ?? ''}
                  onChange={(e) => updateEventParams(ev.id, { height: e.target.value === '' ? undefined : Number(e.target.value) })}
                  placeholder="px"
                  min={100}
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
              </div>
            </div>
          )}

          {/* Variable Mapping for overlay actions */}
          {(ev.action === 'openCard' || ev.action === 'openDialog') && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] text-gray-500">Variable Mapping</label>
                <button
                  onClick={() => {
                    const existing = (ev.params.variableMap ?? {}) as Record<string, string>;
                    const map: Record<string, string> = { ...existing };
                    map[`placeholder_${Object.keys(map).length + 1}`] = '';
                    updateEvent(ev.id, { params: { ...ev.params, variableMap: map } });
                  }}
                  className="text-[10px] text-cyan-600 hover:text-cyan-700"
                >
                  + Add
                </button>
              </div>
              {Object.entries(((ev.params.variableMap ?? {}) as Record<string, string>)).map(([placeholder, realTag]) => (
                <div key={placeholder} className="flex items-center gap-1 mb-1">
                  <input
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
                    className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded"
                  />
                  <span className="text-[10px] text-gray-400">{'\u2192'}</span>
                  <input
                    type="text"
                    value={realTag}
                    onChange={(e) => {
                      const existing = (ev.params.variableMap ?? {}) as Record<string, string>;
                      const map: Record<string, string> = { ...existing };
                      map[placeholder] = e.target.value;
                      updateEvent(ev.id, { params: { ...ev.params, variableMap: map } });
                    }}
                    placeholder="real_tag"
                    className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded"
                  />
                  <button
                    onClick={() => {
                      const existing = (ev.params.variableMap ?? {}) as Record<string, string>;
                      const map: Record<string, string> = { ...existing };
                      delete map[placeholder];
                      updateEvent(ev.id, { params: { ...ev.params, variableMap: map } });
                    }}
                    className="text-red-400 hover:text-red-600 text-xs px-1"
                  >
                    {'\u00d7'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {ev.action === 'setValue' && (
            <>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Target Tag</label>
                <TagBrowser
                  deviceId={deviceId ?? null}
                  value={(ev.params.targetTag as string) || ''}
                  onChange={(tag) => updateEventParams(ev.id, { targetTag: tag })}
                  placeholder="Select target tag..."
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Value</label>
                <input
                  type="text"
                  value={ev.params.value != null ? String(ev.params.value) : ''}
                  onChange={(e) => updateEventParams(ev.id, { value: e.target.value })}
                  placeholder="Value to set"
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
              </div>
            </>
          )}

          {ev.action === 'toggleValue' && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Toggle Tag</label>
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
              <label className="block text-xs text-gray-500 mb-1">Script</label>
              {scripts.length > 0 ? (
                <select
                  value={(ev.params.scriptId as string) || ''}
                  onChange={(e) => updateEventParams(ev.id, { scriptId: e.target.value || undefined })}
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  data-testid="runscript-select"
                >
                  <option value="">Select script...</option>
                  {scripts.filter((s) => s.enabled).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-[10px] text-amber-600 bg-amber-50 px-2 py-1.5 rounded-lg">
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
              <div>
                <label className="block text-xs text-gray-500 mb-1">Target Widget ID</label>
                <input
                  type="text"
                  value={(ev.params.targetWidgetId as string) || ''}
                  onChange={(e) => updateEventParams(ev.id, { targetWidgetId: e.target.value || undefined })}
                  placeholder="widget-uuid-here"
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 font-mono"
                  data-testid="target-widget-id-input"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Property Path</label>
                <input
                  type="text"
                  value={(ev.params.propertyPath as string) || ''}
                  onChange={(e) => updateEventParams(ev.id, { propertyPath: e.target.value || undefined })}
                  placeholder="fill, config.opacity, etc."
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 font-mono"
                  data-testid="property-path-input"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Value</label>
                <input
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
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  data-testid="property-value-input"
                />
              </div>
            </div>
          )}

          {/* closeDialog: Closes the topmost overlay — no parameters needed. */}
          {ev.action === 'closeDialog' && (
            <div className="px-2 py-2 text-[10px] text-gray-500 bg-gray-100 rounded-lg" data-testid="closedialog-config">
              Closes the topmost popup card or modal dialog. No additional configuration needed.
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
