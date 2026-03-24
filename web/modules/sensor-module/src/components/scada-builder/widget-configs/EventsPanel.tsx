/**
 * EventsPanel — UI for adding/editing/removing WidgetEventDef[] on a widget.
 */

import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { WidgetEventDef, EventTrigger, EventAction } from '../../../engine/events/types';
import { useScadaStore } from '../../../store/scada';

const TRIGGERS: EventTrigger[] = ['click', 'dblclick', 'mousedown', 'mouseup', 'mouseover', 'mouseout'];

const ACTIONS: EventAction[] = ['navigate', 'openCard', 'openDialog', 'setValue', 'toggleValue', 'openUrl'];

interface EventsPanelProps {
  events: WidgetEventDef[];
  onChange: (events: WidgetEventDef[]) => void;
}

export const EventsPanel: React.FC<EventsPanelProps> = ({ events, onChange }) => {
  const screens = useScadaStore((s) => s.screens);

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
                <option key={a} value={a}>{a}</option>
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

          {ev.action === 'setValue' && (
            <>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Target Tag</label>
                <input
                  type="text"
                  value={(ev.params.targetTag as string) || ''}
                  onChange={(e) => updateEventParams(ev.id, { targetTag: e.target.value })}
                  placeholder="sensor.tag"
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
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
              <input
                type="text"
                value={(ev.params.toggleTag as string) || ''}
                onChange={(e) => updateEventParams(ev.id, { toggleTag: e.target.value })}
                placeholder="sensor.tag"
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              />
            </div>
          )}

          {ev.action === 'openUrl' && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">URL</label>
              <input
                type="text"
                value={(ev.params.url as string) || ''}
                onChange={(e) => updateEventParams(ev.id, { url: e.target.value })}
                placeholder="https://..."
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
