import React, { useCallback } from 'react';
import {
  Button,
  Checkbox,
  ColorInput,
  colors as themeColors,
  Input,
  Select,
} from '@aquaculture/shared-ui';

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

const DEFAULT_COLORS = [
  themeColors.info[500],
  themeColors.success[500],
  themeColors.warning[500],
  themeColors.error[500],
  themeColors.primary[700],
  themeColors.accent[500],
  themeColors.primary[400],
  themeColors.accent[600],
];

function generateId(): string {
  return `sch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export const SchedulerConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  const entries = (config.entries ?? []) as ScheduleEntry[];
  const title = (config.title ?? 'Schedule') as string;
  const showHourLabels = (config.showHourLabels ?? true) as boolean;

  const updateEntry = useCallback(
    (idx: number, patch: Partial<ScheduleEntry>) => {
      const updated = entries.map((e, i) => (i === idx ? { ...e, ...patch } : e));
      onChange({ entries: updated });
    },
    [entries, onChange],
  );

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

  const removeEntry = useCallback(
    (idx: number) => {
      onChange({ entries: entries.filter((_, i) => i !== idx) });
    },
    [entries, onChange],
  );

  return (
    <div className="space-y-3">
      {/* Title */}
      <Input
        label="Title"
        fullWidth
        type="text"
        value={title}
        onChange={(e) => onChange({ title: e.target.value })}
        placeholder="Schedule"
      />

      {/* Show Hour Labels */}
      <Checkbox
        label="Show hour labels"
        checked={showHourLabels}
        onChange={(e) => onChange({ showHourLabels: e.target.checked })}
      />

      {/* Entries */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-xs text-gray-500 dark:text-gray-400 font-medium">
            Schedule Entries
          </label>
          <button
            type="button"
            onClick={addEntry}
            className="px-2 py-1 text-xs font-medium text-info-700 dark:text-info-300 bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded-md hover:bg-info-100 dark:hover:bg-info-900/50 transition-colors"
          >
            + Add Entry
          </button>
        </div>

        {entries.length === 0 && (
          <p className="text-xs text-gray-400 dark:text-gray-500 italic">
            No schedule entries yet. Click &quot;Add Entry&quot; to begin.
          </p>
        )}

        <div className="space-y-3">
          {entries.map((entry, idx) => (
            <div
              key={entry.id}
              className="p-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 space-y-2"
            >
              {/* Header row with label + remove */}
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  value={entry.label}
                  onChange={(e) => updateEntry(idx, { label: e.target.value })}
                  placeholder="Block label"
                />
                <Button
                  variant="ghost"
                  size="xs"
                  type="button"
                  onClick={() => removeEntry(idx)}
                  title="Remove entry"
                >
                  Remove
                </Button>
              </div>

              {/* Day + Hours */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                <Select
                  label="Day"
                  value={entry.day}
                  onChange={(e) => updateEntry(idx, { day: Number(e.target.value) })}
                  options={DAY_OPTIONS.map((d) => ({ value: d.value, label: d.label }))}
                />
                <Select
                  label="Start Hour"
                  value={entry.startHour}
                  onChange={(e) => updateEntry(idx, { startHour: Number(e.target.value) })}
                  options={HOUR_OPTIONS.map((h) => ({
                    value: h,
                    label: `${String(h).padStart(2, '0')}:00`,
                  }))}
                />
                <Select
                  label="End Hour"
                  value={entry.endHour}
                  onChange={(e) => updateEntry(idx, { endHour: Number(e.target.value) })}
                  options={HOUR_OPTIONS.map((h) => ({
                    value: h,
                    label: `${String(h).padStart(2, '0')}:00`,
                  }))}
                />
              </div>

              {/* Color */}
              <div>
                <label
                  htmlFor={`scheduler-entry-${idx}-color`}
                  className="block text-[10px] text-gray-400 dark:text-gray-500 mb-0.5"
                >
                  Color
                </label>
                <div className="flex items-center gap-2">
                  <ColorInput
                    id={`scheduler-entry-${idx}-color`}
                    variant="swatch"
                    size="xs"
                    value={entry.color || themeColors.info[500]}
                    onChange={(e) => updateEntry(idx, { color: e.target.value })}
                  />
                  <Input
                    type="text"
                    value={entry.color || themeColors.info[500]}
                    onChange={(e) => updateEntry(idx, { color: e.target.value })}
                  />
                </div>
              </div>

              {/* Optional: Tag Name + Tag Value */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Input
                  label="Tag Name (optional)"
                  fullWidth
                  type="text"
                  value={entry.tagName ?? ''}
                  onChange={(e) => updateEntry(idx, { tagName: e.target.value || undefined })}
                  placeholder="e.g. pump1.schedule"
                />
                <Input
                  label="Tag Value (optional)"
                  fullWidth
                  type="text"
                  value={entry.tagValue ?? ''}
                  onChange={(e) => updateEntry(idx, { tagValue: e.target.value || undefined })}
                  placeholder="e.g. ON"
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
