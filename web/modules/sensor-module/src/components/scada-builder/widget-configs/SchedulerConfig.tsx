import React, { useCallback } from 'react';

interface ScheduleEntry {
  id: string;
  day: number;
  startHour: number;
  endHour: number;
  label: string;
  color: string;
  tagName?: string;
  tagValue?: string;
}

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

const DAY_OPTIONS = [
  { value: 0, label: 'Monday' },
  { value: 1, label: 'Tuesday' },
  { value: 2, label: 'Wednesday' },
  { value: 3, label: 'Thursday' },
  { value: 4, label: 'Friday' },
  { value: 5, label: 'Saturday' },
  { value: 6, label: 'Sunday' },
] as const;

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i);

const DEFAULT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];

function generateId(): string {
  return `sch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export const SchedulerConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  const entries = (config.entries ?? []) as ScheduleEntry[];
  const title = (config.title ?? 'Schedule') as string;
  const showHourLabels = (config.showHourLabels ?? true) as boolean;

  const updateEntry = useCallback((idx: number, patch: Partial<ScheduleEntry>) => {
    const updated = entries.map((e, i) => (i === idx ? { ...e, ...patch } : e));
    onChange({ entries: updated });
  }, [entries, onChange]);

  const addEntry = useCallback(() => {
    const newEntry: ScheduleEntry = {
      id: generateId(),
      day: 0,
      startHour: 8,
      endHour: 17,
      label: 'New Block',
      color: DEFAULT_COLORS[entries.length % DEFAULT_COLORS.length],
    };
    onChange({ entries: [...entries, newEntry] });
  }, [entries, onChange]);

  const removeEntry = useCallback((idx: number) => {
    onChange({ entries: entries.filter((_, i) => i !== idx) });
  }, [entries, onChange]);

  return (
    <div className="space-y-3">
      {/* Title */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="Schedule"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>

      {/* Show Hour Labels */}
      <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
        <input
          type="checkbox"
          checked={showHourLabels}
          onChange={(e) => onChange({ showHourLabels: e.target.checked })}
          className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
        />
        Show hour labels
      </label>

      {/* Entries */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-xs text-gray-500 font-medium">Schedule Entries</label>
          <button
            type="button"
            onClick={addEntry}
            className="px-2 py-1 text-xs font-medium text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-md hover:bg-cyan-100 transition-colors"
          >
            + Add Entry
          </button>
        </div>

        {entries.length === 0 && (
          <p className="text-xs text-gray-400 italic">No schedule entries yet. Click &quot;Add Entry&quot; to begin.</p>
        )}

        <div className="space-y-3">
          {entries.map((entry, idx) => (
            <div key={entry.id} className="p-2 border border-gray-200 rounded-lg bg-gray-50 space-y-2">
              {/* Header row with label + remove */}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={entry.label}
                  onChange={(e) => updateEntry(idx, { label: e.target.value })}
                  placeholder="Block label"
                  className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
                <button
                  type="button"
                  onClick={() => removeEntry(idx)}
                  className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded transition-colors"
                  title="Remove entry"
                >
                  Remove
                </button>
              </div>

              {/* Day + Hours */}
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[10px] text-gray-400 mb-0.5">Day</label>
                  <select
                    value={entry.day}
                    onChange={(e) => updateEntry(idx, { day: Number(e.target.value) })}
                    className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  >
                    {DAY_OPTIONS.map((d) => (
                      <option key={d.value} value={d.value}>{d.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-gray-400 mb-0.5">Start Hour</label>
                  <select
                    value={entry.startHour}
                    onChange={(e) => updateEntry(idx, { startHour: Number(e.target.value) })}
                    className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  >
                    {HOUR_OPTIONS.map((h) => (
                      <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-gray-400 mb-0.5">End Hour</label>
                  <select
                    value={entry.endHour}
                    onChange={(e) => updateEntry(idx, { endHour: Number(e.target.value) })}
                    className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  >
                    {HOUR_OPTIONS.map((h) => (
                      <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Color */}
              <div>
                <label className="block text-[10px] text-gray-400 mb-0.5">Color</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={entry.color || '#3b82f6'}
                    onChange={(e) => updateEntry(idx, { color: e.target.value })}
                    className="w-6 h-6 rounded border border-gray-300 cursor-pointer"
                  />
                  <input
                    type="text"
                    value={entry.color || '#3b82f6'}
                    onChange={(e) => updateEntry(idx, { color: e.target.value })}
                    className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  />
                </div>
              </div>

              {/* Optional: Tag Name + Tag Value */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] text-gray-400 mb-0.5">Tag Name (optional)</label>
                  <input
                    type="text"
                    value={entry.tagName ?? ''}
                    onChange={(e) => updateEntry(idx, { tagName: e.target.value || undefined })}
                    placeholder="e.g. pump1.schedule"
                    className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-400 mb-0.5">Tag Value (optional)</label>
                  <input
                    type="text"
                    value={entry.tagValue ?? ''}
                    onChange={(e) => updateEntry(idx, { tagValue: e.target.value || undefined })}
                    placeholder="e.g. ON"
                    className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
