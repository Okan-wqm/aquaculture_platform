/**
 * VfdAutomationRuleList
 *
 * Tab 3 content: List VFD automation rules with toggle, execute, delete actions.
 */

import React, { useState, useCallback } from 'react';
import {
  Plus,
  Power,
  PowerOff,
  Play,
  Trash2,
  Edit3,
  AlertTriangle,
  Zap,
  Clock,
} from 'lucide-react';
import { VfdAutomationRule } from '../../types/vfd.types';
import { VfdAutomationRuleForm } from './VfdAutomationRuleForm';
import { Spinner, Button } from '@aquaculture/shared-ui';

// ============================================================================
// Props
// ============================================================================

interface VfdAutomationRuleListProps {
  rules: VfdAutomationRule[];
  loading: boolean;
  error: string | null;
  onToggle: (id: string, isActive: boolean) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onCreate: (input: Record<string, unknown>) => Promise<unknown>;
  onUpdate: (id: string, input: Record<string, unknown>) => Promise<unknown>;
}

// ============================================================================
// Component
// ============================================================================

export function VfdAutomationRuleList({
  rules,
  loading,
  error,
  onToggle,
  onDelete,
  onCreate,
  onUpdate,
}: VfdAutomationRuleListProps) {
  const [showForm, setShowForm] = useState(false);
  const [editingRule, setEditingRule] = useState<VfdAutomationRule | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleCreate = useCallback(() => {
    setEditingRule(null);
    setShowForm(true);
  }, []);

  const handleEdit = useCallback((rule: VfdAutomationRule) => {
    setEditingRule(rule);
    setShowForm(true);
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    await onDelete(id);
    setConfirmDeleteId(null);
  }, [onDelete]);

  const handleFormSubmit = useCallback(
    async (data: Record<string, unknown>) => {
      if (editingRule) {
        await onUpdate(editingRule.id, data);
      } else {
        await onCreate(data);
      }
      setShowForm(false);
      setEditingRule(null);
    },
    [editingRule, onCreate, onUpdate],
  );

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12" role="alert">
        <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  return (
    <div data-testid="vfd-automation-list">
      {/* Form modal */}
      {showForm && (
        <VfdAutomationRuleForm
          rule={editingRule}
          onSubmit={handleFormSubmit}
          onCancel={() => {
            setShowForm(false);
            setEditingRule(null);
          }}
        />
      )}

      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Automation Rules</h3>
        <Button variant="primary" size="xs" leftIcon={<Plus className="h-3.5 w-3.5" />} type="button" onClick={handleCreate}>Create Rule</Button>
      </div>

      {/* List */}
      {loading && rules.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Spinner size="md" />
        </div>
      ) : rules.length === 0 ? (
        <div className="py-12 text-center">
          <Zap className="mx-auto mb-2 h-8 w-8 text-gray-300" />
          <p className="text-sm text-gray-500 dark:text-gray-400">No automation rules yet</p>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            Create rules to automatically adjust VFD parameters based on conditions
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4"
              data-testid={`rule-card-${rule.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${
                        rule.isActive ? 'bg-green-500' : 'bg-gray-300'
                      }`}
                      aria-hidden="true"
                    />
                    <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{rule.name}</h4>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        rule.isActive
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {rule.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{rule.description}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-400 dark:text-gray-500">
                    <span>
                      Trigger: {formatTriggerCondition(rule.triggerCondition)}
                    </span>
                    <span>
                      Targets: {rule.targetVfdDeviceIds.length} VFD{rule.targetVfdDeviceIds.length !== 1 ? 's' : ''}
                    </span>
                    <span>
                      Requires Approval: {rule.requiresApproval ? 'Yes' : 'No (auto-execute)'}
                    </span>
                    <span className="flex items-center gap-1">
                      <Play className="h-3 w-3" /> Runs: {rule.triggerCount}
                    </span>
                    {rule.lastTriggeredAt && (
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" /> Last: {formatDate(rule.lastTriggeredAt)}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="secondary" size="xs" leftIcon={<Edit3 className="h-3 w-3" />} type="button" onClick={() => handleEdit(rule)}>Edit</Button>
                <button
                  type="button"
                  onClick={() => onToggle(rule.id, !rule.isActive)}
                  className={`inline-flex items-center gap-1 rounded-md border px-3 py-1 text-xs font-medium ${
                    rule.isActive
                      ? 'border-yellow-200 text-yellow-700 hover:bg-yellow-50'
                      : 'border-green-200 text-green-700 hover:bg-green-50'
                  }`}
                  data-testid={`toggle-btn-${rule.id}`}
                >
                  {rule.isActive ? (
                    <><PowerOff className="h-3 w-3" /> Disable</>
                  ) : (
                    <><Power className="h-3 w-3" /> Enable</>
                  )}
                </button>
                {confirmDeleteId === rule.id ? (
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-red-600">Confirm?</span>
                    <Button variant="danger" size="xs" type="button" onClick={() => handleDelete(rule.id)} data-testid={`confirm-delete-${rule.id}`}>Yes</Button>
                    <Button variant="secondary" size="xs" type="button" onClick={() => setConfirmDeleteId(null)}>No</Button>
                  </div>
                ) : (
                  <Button variant="secondary" size="xs" leftIcon={<Trash2 className="h-3 w-3" />} type="button" onClick={() => setConfirmDeleteId(rule.id)} data-testid={`delete-btn-${rule.id}`}>Delete</Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function formatTriggerCondition(condition: Record<string, unknown>): string {
  if (condition.conditions && Array.isArray(condition.conditions)) {
    const parts = (condition.conditions as Array<Record<string, unknown>>).map((c) => {
      return `${String(c.field)} ${String(c.operator)} ${String(c.value)}${c.unit ? ` ${c.unit}` : ''}`;
    });
    return parts.join(` ${String(condition.operator ?? 'AND')} `);
  }
  return JSON.stringify(condition).slice(0, 80);
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
