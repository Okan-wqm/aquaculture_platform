/**
 * VfdAutomationRuleForm
 *
 * Modal form for creating or editing VFD automation rules.
 * Includes trigger condition builder and parameter changes builder.
 */

import React, { useState, useCallback } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import { VfdAutomationRule } from '../../types/vfd.types';

// ============================================================================
// Types
// ============================================================================

interface TriggerConditionRow {
  field: string;
  operator: string;
  value: string;
  unit: string;
}

interface ParameterChangeRow {
  parameterName: string;
  newValue: string;
}

// ============================================================================
// Props
// ============================================================================

interface VfdAutomationRuleFormProps {
  rule: VfdAutomationRule | null;
  onSubmit: (data: Record<string, unknown>) => Promise<unknown>;
  onCancel: () => void;
}

// ============================================================================
// Component
// ============================================================================

export function VfdAutomationRuleForm({
  rule,
  onSubmit,
  onCancel,
}: VfdAutomationRuleFormProps) {
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [requiresApproval, setRequiresApproval] = useState(rule?.requiresApproval ?? true);
  const [priority, setPriority] = useState(String(rule?.priority ?? 10));
  const [targetDevices, setTargetDevices] = useState(
    rule?.targetVfdDeviceIds.join(', ') ?? '',
  );
  const [submitting, setSubmitting] = useState(false);

  // Trigger conditions
  const [conditions, setConditions] = useState<TriggerConditionRow[]>(() => {
    if (rule?.triggerCondition?.conditions && Array.isArray(rule.triggerCondition.conditions)) {
      return (rule.triggerCondition.conditions as Array<Record<string, unknown>>).map((c) => ({
        field: String(c.field ?? ''),
        operator: String(c.operator ?? '>'),
        value: String(c.value ?? ''),
        unit: String(c.unit ?? ''),
      }));
    }
    return [{ field: '', operator: '>', value: '', unit: '' }];
  });

  // Parameter changes
  const [paramChanges, setParamChanges] = useState<ParameterChangeRow[]>(() => {
    if (rule?.parameterChanges && Array.isArray(rule.parameterChanges)) {
      return rule.parameterChanges.map((c) => ({
        parameterName: String((c as Record<string, unknown>).parameterName ?? ''),
        newValue: String((c as Record<string, unknown>).newValue ?? ''),
      }));
    }
    return [{ parameterName: '', newValue: '' }];
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = useCallback((): boolean => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Name is required';
    if (!targetDevices.trim()) errs.targets = 'At least one target device is required';
    if (conditions.some((c) => !c.field || !c.value)) {
      errs.conditions = 'All condition fields must be filled';
    }
    if (paramChanges.some((p) => !p.parameterName || !p.newValue)) {
      errs.params = 'All parameter changes must be filled';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }, [name, targetDevices, conditions, paramChanges]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!validate()) return;

      setSubmitting(true);
      try {
        await onSubmit({
          name: name.trim(),
          description: description.trim(),
          requiresApproval,
          priority: parseInt(priority, 10) || 10,
          targetVfdDeviceIds: targetDevices.split(',').map((s) => s.trim()).filter(Boolean),
          triggerCondition: {
            operator: 'AND',
            conditions: conditions.map((c) => ({
              field: c.field,
              operator: c.operator,
              value: parseFloat(c.value) || c.value,
              unit: c.unit || undefined,
            })),
          },
          parameterChanges: paramChanges.map((p) => ({
            parameterName: p.parameterName,
            newValue: parseFloat(p.newValue) || p.newValue,
          })),
        });
      } finally {
        setSubmitting(false);
      }
    },
    [name, description, requiresApproval, priority, targetDevices, conditions, paramChanges, validate, onSubmit],
  );

  const addCondition = useCallback(() => {
    setConditions((prev) => [...prev, { field: '', operator: '>', value: '', unit: '' }]);
  }, []);

  const removeCondition = useCallback((idx: number) => {
    setConditions((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const updateCondition = useCallback((idx: number, field: keyof TriggerConditionRow, val: string) => {
    setConditions((prev) => prev.map((c, i) => (i === idx ? { ...c, [field]: val } : c)));
  }, []);

  const addParamChange = useCallback(() => {
    setParamChanges((prev) => [...prev, { parameterName: '', newValue: '' }]);
  }, []);

  const removeParamChange = useCallback((idx: number) => {
    setParamChanges((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const updateParamChange = useCallback((idx: number, field: keyof ParameterChangeRow, val: string) => {
    setParamChanges((prev) => prev.map((p, i) => (i === idx ? { ...p, [field]: val } : p)));
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={rule ? 'Edit automation rule' : 'Create automation rule'}
    >
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} aria-hidden="true" />
      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">
            {rule ? 'Edit Rule' : 'Create Automation Rule'}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close form"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div>
            <label htmlFor="rule-name" className="block text-sm font-medium text-gray-700">
              Name *
            </label>
            <input
              id="rule-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
            {errors.name && <p className="mt-1 text-xs text-red-600">{errors.name}</p>}
          </div>

          {/* Description */}
          <div>
            <label htmlFor="rule-desc" className="block text-sm font-medium text-gray-700">
              Description
            </label>
            <textarea
              id="rule-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>

          {/* Target devices */}
          <div>
            <label htmlFor="rule-targets" className="block text-sm font-medium text-gray-700">
              Target VFD Device IDs * (comma separated)
            </label>
            <input
              id="rule-targets"
              type="text"
              value={targetDevices}
              onChange={(e) => setTargetDevices(e.target.value)}
              placeholder="vfd-1, vfd-2"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
            {errors.targets && <p className="mt-1 text-xs text-red-600">{errors.targets}</p>}
          </div>

          {/* Trigger conditions */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="block text-sm font-medium text-gray-700">Trigger Conditions</label>
              <button
                type="button"
                onClick={addCondition}
                className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700"
              >
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
            <div className="space-y-2">
              {conditions.map((cond, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={cond.field}
                    onChange={(e) => updateCondition(idx, 'field', e.target.value)}
                    placeholder="field"
                    className="w-28 rounded-md border border-gray-300 px-2 py-1.5 text-xs"
                    aria-label={`Condition ${idx + 1} field`}
                  />
                  <select
                    value={cond.operator}
                    onChange={(e) => updateCondition(idx, 'operator', e.target.value)}
                    className="rounded-md border border-gray-300 px-2 py-1.5 text-xs"
                    aria-label={`Condition ${idx + 1} operator`}
                  >
                    <option value=">">{'>'}</option>
                    <option value="<">{'<'}</option>
                    <option value=">=">{'>='}</option>
                    <option value="<=">{'<='}</option>
                    <option value="==">{'=='}</option>
                    <option value="between">between</option>
                  </select>
                  <input
                    type="text"
                    value={cond.value}
                    onChange={(e) => updateCondition(idx, 'value', e.target.value)}
                    placeholder="value"
                    className="w-20 rounded-md border border-gray-300 px-2 py-1.5 text-xs"
                    aria-label={`Condition ${idx + 1} value`}
                  />
                  <input
                    type="text"
                    value={cond.unit}
                    onChange={(e) => updateCondition(idx, 'unit', e.target.value)}
                    placeholder="unit"
                    className="w-16 rounded-md border border-gray-300 px-2 py-1.5 text-xs"
                    aria-label={`Condition ${idx + 1} unit`}
                  />
                  {conditions.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeCondition(idx)}
                      className="text-red-400 hover:text-red-600"
                      aria-label={`Remove condition ${idx + 1}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {errors.conditions && <p className="mt-1 text-xs text-red-600">{errors.conditions}</p>}
          </div>

          {/* Parameter changes */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="block text-sm font-medium text-gray-700">Parameter Changes</label>
              <button
                type="button"
                onClick={addParamChange}
                className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700"
              >
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
            <div className="space-y-2">
              {paramChanges.map((pc, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={pc.parameterName}
                    onChange={(e) => updateParamChange(idx, 'parameterName', e.target.value)}
                    placeholder="Parameter"
                    className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-xs"
                    aria-label={`Parameter change ${idx + 1} name`}
                  />
                  <input
                    type="text"
                    value={pc.newValue}
                    onChange={(e) => updateParamChange(idx, 'newValue', e.target.value)}
                    placeholder="New value"
                    className="w-24 rounded-md border border-gray-300 px-2 py-1.5 text-xs"
                    aria-label={`Parameter change ${idx + 1} value`}
                  />
                  {paramChanges.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeParamChange(idx)}
                      className="text-red-400 hover:text-red-600"
                      aria-label={`Remove parameter change ${idx + 1}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {errors.params && <p className="mt-1 text-xs text-red-600">{errors.params}</p>}
          </div>

          {/* Options row */}
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={requiresApproval}
                onChange={(e) => setRequiresApproval(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-indigo-600"
              />
              Requires Approval
            </label>
            <div className="flex items-center gap-2">
              <label htmlFor="rule-priority" className="text-sm text-gray-700">
                Priority:
              </label>
              <input
                id="rule-priority"
                type="number"
                min={1}
                max={100}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-16 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
              />
            </div>
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-3 border-t pt-4">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting ? 'Saving...' : rule ? 'Save Changes' : 'Create Rule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
