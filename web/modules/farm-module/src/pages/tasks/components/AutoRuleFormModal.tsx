import React, { useState } from 'react';
import { Modal } from '@aquaculture/shared-ui';
import {
  AutoRule,
  AutoRuleTrigger,
  TaskCategory,
  TaskPriority,
  TRIGGER_CONFIG,
  CATEGORY_CONFIG,
  PRIORITY_CONFIG,
} from '../types/task.types';

interface AutoRuleFormModalProps {
  rule?: AutoRule | null;
  onClose: () => void;
  onSave: (data: AutoRuleFormData) => void;
  saving?: boolean;
  users?: { id: string; name: string }[];
}

export interface AutoRuleFormData {
  name: string;
  description: string;
  trigger: AutoRuleTrigger;
  triggerCondition: string;
  taskTitle: string;
  taskDescription: string;
  taskCategory: TaskCategory;
  taskPriority: TaskPriority;
  assignTo: string;
}

const TRIGGER_PLACEHOLDERS: Record<AutoRuleTrigger, string> = {
  STOCK_LOW: 'E.g. When feed stock drops below 500 kg',
  EXPIRY_NEAR: 'E.g. 30 days before medicine expiry',
  MAINTENANCE_DUE: 'E.g. After 500 running hours of the generator',
  SCHEDULE: 'E.g. Every Monday at 08:00',
  LICENSE_EXPIRY: 'E.g. 60 days before licence expiry',
  WATER_PARAM_ALERT: 'E.g. When pH drops below 6.5',
};

export const AutoRuleFormModal: React.FC<AutoRuleFormModalProps> = ({
  rule,
  onClose,
  onSave,
  saving = false,
  users = [],
}) => {
  const isEdit = !!rule;

  const [formData, setFormData] = useState<AutoRuleFormData>({
    name: rule?.name || '',
    description: rule?.description || '',
    trigger: rule?.trigger || 'STOCK_LOW',
    triggerCondition: rule?.triggerCondition || '',
    taskTitle: rule?.taskTitle || '',
    taskDescription: rule?.taskDescription || '',
    taskCategory: rule?.taskCategory || 'GENERAL',
    taskPriority: rule?.taskPriority || 'MEDIUM',
    assignTo: rule?.assignTo || '',
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim() || !formData.triggerCondition.trim() || !formData.taskTitle.trim()) {
      return;
    }
    onSave(formData);
  };

  return (
    <Modal
      className="sd-f2"
      isOpen
      onClose={onClose}
      title={isEdit ? 'Edit Rule' : 'New Auto Rule'}
      description="When the condition is met, a task is created automatically."
      size="lg"
    >
      <form onSubmit={handleSubmit}>
        <div className="space-y-4">
          {/* Rule Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Rule Name *</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="Create an ordering task when stock runs low"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              required
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
              rows={2}
              placeholder="Briefly describe what this rule does…"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Trigger Section */}
          <div className="bg-blue-50 rounded-lg p-4 space-y-3">
            <h4 className="text-sm font-semibold text-blue-900">Tetikleyici</h4>

            {/* Trigger Type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tetikleyici Tipi *
              </label>
              <select
                value={formData.trigger}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, trigger: e.target.value as AutoRuleTrigger }))
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white"
              >
                {Object.entries(TRIGGER_CONFIG).map(([key, val]) => (
                  <option key={key} value={key}>
                    {val.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Trigger Condition */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Trigger Condition *
              </label>
              <input
                type="text"
                value={formData.triggerCondition}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, triggerCondition: e.target.value }))
                }
                placeholder={TRIGGER_PLACEHOLDERS[formData.trigger]}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                required
              />
            </div>
          </div>

          {/* Task Section */}
          <div className="bg-green-50 rounded-lg p-4 space-y-3">
            <h4 className="text-sm font-semibold text-green-900">Task to Create</h4>

            {/* Task Title */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Task Title *
              </label>
              <input
                type="text"
                value={formData.taskTitle}
                onChange={(e) => setFormData((prev) => ({ ...prev, taskTitle: e.target.value }))}
                placeholder="Order feed"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                required
              />
            </div>

            {/* Task Description */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Task Description
              </label>
              <textarea
                value={formData.taskDescription}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, taskDescription: e.target.value }))
                }
                rows={2}
                placeholder="Task details…"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            {/* Category + Priority */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Kategori *</label>
                <select
                  value={formData.taskCategory}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      taskCategory: e.target.value as TaskCategory,
                    }))
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  {Object.entries(CATEGORY_CONFIG).map(([key, val]) => (
                    <option key={key} value={key}>
                      {val.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Priority *</label>
                <select
                  value={formData.taskPriority}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      taskPriority: e.target.value as TaskPriority,
                    }))
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  {Object.entries(PRIORITY_CONFIG).map(([key, val]) => (
                    <option key={key} value={key}>
                      {val.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Assign To */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Assign To</label>
              <select
                value={formData.assignTo}
                onChange={(e) => setFormData((prev) => ({ ...prev, assignTo: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="">
                  {users.length === 0 ? 'Loading…' : 'Select (optional)'}
                </option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-4 pt-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-100"
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : isEdit ? 'Update' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
