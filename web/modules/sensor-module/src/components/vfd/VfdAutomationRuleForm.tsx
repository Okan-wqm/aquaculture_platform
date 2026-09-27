/**
 * VfdAutomationRuleForm
 *
 * Modal form for creating or editing VFD automation rules.
 * Includes trigger condition builder and parameter changes builder.
 */

import React, { useState, useCallback } from 'react';
import { Modal, Button, Input, Textarea } from '@aquaculture/shared-ui';
import { Plus, Trash2 } from 'lucide-react';
import type { CreateAutomationRuleInput, VfdAutomationRule } from '../../types/vfd.types';

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
  onSubmit: (data: CreateAutomationRuleInput) => Promise<unknown>;
  onCancel: () => void;
}

// ============================================================================
// Component
// ============================================================================

export function VfdAutomationRuleForm({ rule, onSubmit, onCancel }: VfdAutomationRuleFormProps) {
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [requiresApproval, setRequiresApproval] = useState(rule?.requiresApproval ?? true);
  const [priority, setPriority] = useState(String(rule?.priority ?? 10));
  const [targetDevices, setTargetDevices] = useState(rule?.targetVfdDeviceIds.join(', ') ?? '');
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
          targetVfdDeviceIds: targetDevices
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
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
    [
      name,
      description,
      requiresApproval,
      priority,
      targetDevices,
      conditions,
      paramChanges,
      validate,
      onSubmit,
    ],
  );

  const addCondition = useCallback(() => {
    setConditions((prev) => [...prev, { field: '', operator: '>', value: '', unit: '' }]);
  }, []);

  const removeCondition = useCallback((idx: number) => {
    setConditions((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const updateCondition = useCallback(
    (idx: number, field: keyof TriggerConditionRow, val: string) => {
      setConditions((prev) => prev.map((c, i) => (i === idx ? { ...c, [field]: val } : c)));
    },
    [],
  );

  const addParamChange = useCallback(() => {
    setParamChanges((prev) => [...prev, { parameterName: '', newValue: '' }]);
  }, []);

  const removeParamChange = useCallback((idx: number) => {
    setParamChanges((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const updateParamChange = useCallback(
    (idx: number, field: keyof ParameterChangeRow, val: string) => {
      setParamChanges((prev) => prev.map((p, i) => (i === idx ? { ...p, [field]: val } : p)));
    },
    [],
  );

  return (
    <Modal
      isOpen
      onClose={onCancel}
      size="md"
      title={rule ? 'Edit Rule' : 'Create Automation Rule'}
      showCloseButton={!submitting}
      closeOnEscape={!submitting}
      closeOnOverlayClick={!submitting}
      className="max-h-[90vh] overflow-hidden flex flex-col"
      bodyClassName="flex-1 min-h-0 overflow-y-auto p-6"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Name */}
        <div>
          <label
            htmlFor="rule-name"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Name *
          </label>
          <Input
            fullWidth
            id="rule-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {errors.name && (
            <p className="mt-1 text-xs text-error-600 dark:text-error-400">{errors.name}</p>
          )}
        </div>

        {/* Description */}
        <div>
          <label
            htmlFor="rule-desc"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Description
          </label>
          <Textarea
            fullWidth
            id="rule-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>

        {/* Target devices */}
        <div>
          <label
            htmlFor="rule-targets"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Target VFD Device IDs * (comma separated)
          </label>
          <Input
            fullWidth
            id="rule-targets"
            type="text"
            value={targetDevices}
            onChange={(e) => setTargetDevices(e.target.value)}
            placeholder="vfd-1, vfd-2"
          />
          {errors.targets && (
            <p className="mt-1 text-xs text-error-600 dark:text-error-400">{errors.targets}</p>
          )}
        </div>

        {/* Trigger conditions */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Trigger Conditions
            </label>
            <Button
              variant="ghost"
              size="xs"
              leftIcon={<Plus className="h-3 w-3" />}
              type="button"
              onClick={addCondition}
            >
              Add
            </Button>
          </div>
          <div className="space-y-2">
            {conditions.map((cond, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  type="text"
                  value={cond.field}
                  onChange={(e) => updateCondition(idx, 'field', e.target.value)}
                  placeholder="field"
                  aria-label={`Condition ${idx + 1} field`}
                />
                <select
                  value={cond.operator}
                  onChange={(e) => updateCondition(idx, 'operator', e.target.value)}
                  className="rounded-md border border-gray-300 dark:border-gray-600 px-2 py-1.5 text-xs"
                  aria-label={`Condition ${idx + 1} operator`}
                >
                  <option value=">">{'>'}</option>
                  <option value="<">{'<'}</option>
                  <option value=">=">{'>='}</option>
                  <option value="<=">{'<='}</option>
                  <option value="==">{'=='}</option>
                  <option value="between">between</option>
                </select>
                <Input
                  type="text"
                  value={cond.value}
                  onChange={(e) => updateCondition(idx, 'value', e.target.value)}
                  placeholder="value"
                  aria-label={`Condition ${idx + 1} value`}
                />
                <Input
                  type="text"
                  value={cond.unit}
                  onChange={(e) => updateCondition(idx, 'unit', e.target.value)}
                  placeholder="unit"
                  aria-label={`Condition ${idx + 1} unit`}
                />
                {conditions.length > 1 && (
                  <Button
                    variant="ghost"
                    iconOnly
                    type="button"
                    onClick={() => removeCondition(idx)}
                    aria-label={`Remove condition ${idx + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
          {errors.conditions && (
            <p className="mt-1 text-xs text-error-600 dark:text-error-400">{errors.conditions}</p>
          )}
        </div>

        {/* Parameter changes */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Parameter Changes
            </label>
            <Button
              variant="ghost"
              size="xs"
              leftIcon={<Plus className="h-3 w-3" />}
              type="button"
              onClick={addParamChange}
            >
              Add
            </Button>
          </div>
          <div className="space-y-2">
            {paramChanges.map((pc, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  type="text"
                  value={pc.parameterName}
                  onChange={(e) => updateParamChange(idx, 'parameterName', e.target.value)}
                  placeholder="Parameter"
                  aria-label={`Parameter change ${idx + 1} name`}
                />
                <Input
                  type="text"
                  value={pc.newValue}
                  onChange={(e) => updateParamChange(idx, 'newValue', e.target.value)}
                  placeholder="New value"
                  aria-label={`Parameter change ${idx + 1} value`}
                />
                {paramChanges.length > 1 && (
                  <Button
                    variant="ghost"
                    iconOnly
                    type="button"
                    onClick={() => removeParamChange(idx)}
                    aria-label={`Remove parameter change ${idx + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
          {errors.params && (
            <p className="mt-1 text-xs text-error-600 dark:text-error-400">{errors.params}</p>
          )}
        </div>

        {/* Options row */}
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={requiresApproval}
              onChange={(e) => setRequiresApproval(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-primary-600"
            />
            Requires Approval
          </label>
          <div className="flex items-center gap-2">
            <label htmlFor="rule-priority" className="text-sm text-gray-700 dark:text-gray-300">
              Priority:
            </label>
            <Input
              id="rule-priority"
              type="number"
              min={1}
              max={100}
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
          </div>
        </div>

        {/* Submit */}
        <div className="flex justify-end gap-3 border-t pt-4">
          <Button variant="secondary" type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={submitting}>
            {submitting ? 'Saving...' : rule ? 'Save Changes' : 'Create Rule'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
