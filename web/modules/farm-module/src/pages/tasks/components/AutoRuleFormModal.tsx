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
  STOCK_LOW: 'Örn: Yem stoğu 500 kg altına düştüğünde',
  EXPIRY_NEAR: 'Örn: İlaç son kullanma tarihi 30 gün kala',
  MAINTENANCE_DUE: 'Örn: Jeneratör 500 saat çalışma sonrası',
  SCHEDULE: 'Örn: Her Pazartesi saat 08:00',
  LICENSE_EXPIRY: 'Örn: Lisans süresi 60 gün kala',
  WATER_PARAM_ALERT: 'Örn: pH 6.5 altına düştüğünde',
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
      isOpen
      onClose={onClose}
      title={isEdit ? 'Kuralı Düzenle' : 'Yeni Otomatik Kural'}
      description="Koşul sağlandığında otomatik görev oluşturulacaktır."
      size="lg"
    >
      <form onSubmit={handleSubmit}>
        <div className="space-y-4">
          {/* Rule Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Kural Adı *</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="Stok azaldığında sipariş görevi oluştur"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              required
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Açıklama</label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
              rows={2}
              placeholder="Kuralın ne yaptığını kısaca açıklayın..."
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
                Tetikleyici Koşul *
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
            <h4 className="text-sm font-semibold text-green-900">Oluşturulacak Görev</h4>

            {/* Task Title */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Görev Başlığı *
              </label>
              <input
                type="text"
                value={formData.taskTitle}
                onChange={(e) => setFormData((prev) => ({ ...prev, taskTitle: e.target.value }))}
                placeholder="Yem siparişi ver"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                required
              />
            </div>

            {/* Task Description */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Görev Açıklaması
              </label>
              <textarea
                value={formData.taskDescription}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, taskDescription: e.target.value }))
                }
                rows={2}
                placeholder="Görev detayları..."
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
                <label className="block text-sm font-medium text-gray-700 mb-1">Öncelik *</label>
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
              <label className="block text-sm font-medium text-gray-700 mb-1">Atanacak Kişi</label>
              <select
                value={formData.assignTo}
                onChange={(e) => setFormData((prev) => ({ ...prev, assignTo: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="">
                  {users.length === 0 ? 'Yükleniyor...' : 'Seçin (opsiyonel)'}
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
            İptal
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Kaydediliyor...' : isEdit ? 'Güncelle' : 'Oluştur'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
