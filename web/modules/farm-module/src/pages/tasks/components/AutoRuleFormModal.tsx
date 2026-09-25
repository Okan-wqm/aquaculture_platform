import React, { useState } from 'react';
import { Modal, Button, Input, Select, Textarea } from '@aquaculture/shared-ui';
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
          <Input
            label="Kural Adı"
            fullWidth
            type="text"
            value={formData.name}
            onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="Stok azaldığında sipariş görevi oluştur"
            required
          />

          {/* Description */}
          <Textarea
            label="Açıklama"
            fullWidth
            value={formData.description}
            onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
            rows={2}
            placeholder="Kuralın ne yaptığını kısaca açıklayın..."
          />

          {/* Trigger Section */}
          <div className="bg-info-50 dark:bg-info-900/20 rounded-lg p-4 space-y-3">
            <h4 className="text-sm font-semibold text-info-900 dark:text-info-100">Tetikleyici</h4>

            {/* Trigger Type */}
            <Select
              label="Tetikleyici Tipi"
              required
              value={formData.trigger}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, trigger: e.target.value as AutoRuleTrigger }))
              }
              options={Object.entries(TRIGGER_CONFIG).map(([key, val]) => ({
                value: key,
                label: val.label,
              }))}
            />

            {/* Trigger Condition */}
            <Input
              label="Tetikleyici Koşul"
              fullWidth
              type="text"
              value={formData.triggerCondition}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, triggerCondition: e.target.value }))
              }
              placeholder={TRIGGER_PLACEHOLDERS[formData.trigger]}
              required
            />
          </div>

          {/* Task Section */}
          <div className="bg-success-50 dark:bg-success-900/20 rounded-lg p-4 space-y-3">
            <h4 className="text-sm font-semibold text-success-900 dark:text-success-100">
              Oluşturulacak Görev
            </h4>

            {/* Task Title */}
            <Input
              label="Görev Başlığı"
              fullWidth
              type="text"
              value={formData.taskTitle}
              onChange={(e) => setFormData((prev) => ({ ...prev, taskTitle: e.target.value }))}
              placeholder="Yem siparişi ver"
              required
            />

            {/* Task Description */}
            <Textarea
              label="Görev Açıklaması"
              fullWidth
              value={formData.taskDescription}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, taskDescription: e.target.value }))
              }
              rows={2}
              placeholder="Görev detayları..."
            />

            {/* Category + Priority */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Select
                label="Kategori"
                required
                value={formData.taskCategory}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    taskCategory: e.target.value as TaskCategory,
                  }))
                }
                options={Object.entries(CATEGORY_CONFIG).map(([key, val]) => ({
                  value: key,
                  label: val.label,
                }))}
              />
              <Select
                label="Öncelik"
                required
                value={formData.taskPriority}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    taskPriority: e.target.value as TaskPriority,
                  }))
                }
                options={Object.entries(PRIORITY_CONFIG).map(([key, val]) => ({
                  value: key,
                  label: val.label,
                }))}
              />
            </div>

            {/* Assign To */}
            <Select
              label="Atanacak Kişi"
              value={formData.assignTo}
              onChange={(e) => setFormData((prev) => ({ ...prev, assignTo: e.target.value }))}
              options={[
                {
                  value: '',
                  label: users.length === 0 ? 'Yükleniyor...' : 'Seçin (opsiyonel)',
                },
                ...users.map((u) => ({ value: u.id, label: u.name })),
              ]}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
          <Button variant="secondary" type="button" onClick={onClose} disabled={saving}>
            İptal
          </Button>
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? 'Kaydediliyor...' : isEdit ? 'Güncelle' : 'Oluştur'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
