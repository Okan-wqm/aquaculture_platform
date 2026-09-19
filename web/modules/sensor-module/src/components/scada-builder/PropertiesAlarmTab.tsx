/**
 * SCADA Builder — Alarm Rules tab content
 * Extracted from PropertiesPanel for maintainability (<500 LOC rule).
 */

import React from 'react';
import { Button, Input } from '@aquaculture/shared-ui';
import { Plus, Trash2 } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AlarmRule {
  id: string;
  tag: string;
  condition: string;
  value: number;
  severity: 'critical' | 'high' | 'warning' | 'info';
  message: string;
  deadband?: number;
  delay?: number;
}

interface PropertiesAlarmTabProps {
  alarmRules: AlarmRule[];
  onAlarmRulesChange?: (rules: AlarmRule[]) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONDITIONS = ['>', '<', '>=', '<=', '==', '!='];
const SEVERITIES = ['critical', 'high', 'warning', 'info'];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PropertiesAlarmTab: React.FC<PropertiesAlarmTabProps> = ({
  alarmRules,
  onAlarmRulesChange,
}) => {
  const addAlarmRule = () => {
    const rule: AlarmRule = {
      id: crypto.randomUUID(),
      tag: '',
      condition: '>',
      value: 0,
      severity: 'warning',
      message: '',
    };
    onAlarmRulesChange?.([...alarmRules, rule]);
  };

  const updateAlarmRule = (id: string, field: string, value: string | number | undefined) => {
    onAlarmRulesChange?.(
      alarmRules.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
    );
  };

  const removeAlarmRule = (id: string) => {
    onAlarmRulesChange?.(alarmRules.filter((r) => r.id !== id));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Alarm Rules</h4>
        <Button variant="ghost" size="xs" leftIcon={<Plus className="w-3 h-3" />} onClick={addAlarmRule}>Add Alarm</Button>
      </div>

      {alarmRules.length === 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400 py-4 text-center">No alarm rules yet</p>
      )}

      {alarmRules.map((rule) => (
        <div key={rule.id} className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg space-y-2 border border-gray-100 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <select
              value={rule.severity}
              onChange={(e) => updateAlarmRule(rule.id, 'severity', e.target.value)}
              className={`text-xs font-medium rounded px-2 py-1 border-0 ${
                rule.severity === 'critical' ? 'bg-red-100 text-red-700' :
                rule.severity === 'high' ? 'bg-orange-100 text-orange-700' :
                rule.severity === 'warning' ? 'bg-yellow-100 text-yellow-700' :
                'bg-blue-100 text-blue-700'
              }`}
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <Button variant="ghost" iconOnly onClick={() => removeAlarmRule(rule.id)} aria-label="Remove alarm rule"><Trash2 className="w-3.5 h-3.5" /></Button>
          </div>
          <Input fullWidth type="text" value={rule.tag} onChange={(e) => updateAlarmRule(rule.id, 'tag', e.target.value)} placeholder="Tag" />
          <div className="flex gap-1">
            <select
              value={rule.condition}
              onChange={(e) => updateAlarmRule(rule.id, 'condition', e.target.value)}
              className="w-16 px-1 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
            >
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <Input type="number" value={rule.value} onChange={(e) => updateAlarmRule(rule.id, 'value', Number(e.target.value))} />
          </div>
          <Input fullWidth type="text" value={rule.message} onChange={(e) => updateAlarmRule(rule.id, 'message', e.target.value)} placeholder="Alarm message" />
          <div className="flex gap-1">
            <div className="flex-1">
              <label className="block text-[11px] text-gray-600 dark:text-gray-400 mb-0.5">Deadband</label>
              <Input fullWidth type="number" value={rule.deadband ?? ''} onChange={(e) => updateAlarmRule(rule.id, 'deadband', e.target.value === '' ? undefined : Number(e.target.value))} placeholder="Hysteresis value" min={0} step={0.1} />
            </div>
            <div className="flex-1">
              <label className="block text-[11px] text-gray-600 dark:text-gray-400 mb-0.5">Delay (sec)</label>
              <Input fullWidth type="number" value={rule.delay ?? ''} onChange={(e) => updateAlarmRule(rule.id, 'delay', e.target.value === '' ? undefined : Number(e.target.value))} placeholder="Seconds" min={0} step={1} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
