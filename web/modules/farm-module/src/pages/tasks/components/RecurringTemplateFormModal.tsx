import React, { useState, useEffect } from 'react';
import { Modal, Button, Input, Select, Textarea } from '@aquaculture/shared-ui';
import {
  RecurringTemplate,
  TaskCategory,
  TaskPriority,
  RecurrenceFrequency,
  CATEGORY_CONFIG,
  PRIORITY_CONFIG,
  FREQUENCY_CONFIG,
  ChecklistItem,
} from '../types/task.types';

interface RecurringTemplateFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: RecurringTemplateFormData) => void;
  initialData?: RecurringTemplate;
  loading?: boolean;
  users?: { id: string; name: string }[];
}

export interface RecurringTemplateFormData {
  title: string;
  description: string;
  category: TaskCategory;
  priority: TaskPriority;
  frequency: RecurrenceFrequency;
  frequencyDetail: string;
  assignedTo: string;
  assignedToName: string;
  location: string;
  estimatedMinutes: number;
  checklistItems: ChecklistItem[];
  tags: string[];
}

export const RecurringTemplateFormModal: React.FC<RecurringTemplateFormModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  initialData,
  loading = false,
  users = [],
}) => {
  const isEdit = !!initialData;

  const [formData, setFormData] = useState<RecurringTemplateFormData>({
    title: initialData?.title || '',
    description: initialData?.description || '',
    category: initialData?.category || 'GENERAL',
    priority: initialData?.priority || 'MEDIUM',
    frequency: initialData?.frequency || 'DAILY',
    frequencyDetail: initialData?.frequencyDetail || '',
    assignedTo: initialData?.assignedTo || '',
    assignedToName: initialData?.assignedToName || '',
    location: initialData?.location || '',
    estimatedMinutes: initialData?.estimatedMinutes || 30,
    checklistItems: initialData?.checklistItems || [],
    tags: initialData?.tags || [],
  });

  useEffect(() => {
    setFormData({
      title: initialData?.title || '',
      description: initialData?.description || '',
      category: initialData?.category || 'GENERAL',
      priority: initialData?.priority || 'MEDIUM',
      frequency: initialData?.frequency || 'DAILY',
      frequencyDetail: initialData?.frequencyDetail || '',
      assignedTo: initialData?.assignedTo || '',
      assignedToName: initialData?.assignedToName || '',
      location: initialData?.location || '',
      estimatedMinutes: initialData?.estimatedMinutes || 30,
      checklistItems: initialData?.checklistItems || [],
      tags: initialData?.tags || [],
    });
  }, [initialData]);

  const [newChecklistItem, setNewChecklistItem] = useState('');
  const [newTag, setNewTag] = useState('');

  const handleAssigneeChange = (userId: string) => {
    const assignee = users.find((a) => a.id === userId);
    setFormData((prev) => ({
      ...prev,
      assignedTo: userId,
      assignedToName: assignee?.name || '',
    }));
  };

  const addChecklistItem = () => {
    if (newChecklistItem.trim()) {
      setFormData((prev) => ({
        ...prev,
        checklistItems: [
          ...prev.checklistItems,
          { id: `new-${Date.now()}`, text: newChecklistItem.trim(), isCompleted: false },
        ],
      }));
      setNewChecklistItem('');
    }
  };

  const removeChecklistItem = (id: string) => {
    setFormData((prev) => ({
      ...prev,
      checklistItems: prev.checklistItems.filter((c) => c.id !== id),
    }));
  };

  const addTag = () => {
    if (newTag.trim() && !formData.tags.includes(newTag.trim())) {
      setFormData((prev) => ({ ...prev, tags: [...prev.tags, newTag.trim()] }));
      setNewTag('');
    }
  };

  const removeTag = (tag: string) => {
    setFormData((prev) => ({ ...prev, tags: prev.tags.filter((t) => t !== tag) }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title.trim() || !formData.assignedTo) return;
    onSubmit(formData);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? 'Şablonu Düzenle' : 'Yeni Tekrarlayan Şablon'}
      size="lg"
    >
      <form onSubmit={handleSubmit}>
        <div className="space-y-4">
          {/* Title */}
          <Input
            label="Şablon Adı"
            fullWidth
            type="text"
            value={formData.title}
            onChange={(e) => setFormData((prev) => ({ ...prev, title: e.target.value }))}
            required
          />

          {/* Description */}
          <Textarea
            label="Açıklama"
            fullWidth
            value={formData.description}
            onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
            rows={3}
          />

          {/* Category + Priority */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Kategori"
              required
              value={formData.category}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, category: e.target.value as TaskCategory }))
              }
              options={Object.entries(CATEGORY_CONFIG).map(([key, val]) => ({
                value: key,
                label: val.label,
              }))}
            />
            <Select
              label="Öncelik"
              required
              value={formData.priority}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, priority: e.target.value as TaskPriority }))
              }
              options={Object.entries(PRIORITY_CONFIG).map(([key, val]) => ({
                value: key,
                label: val.label,
              }))}
            />
          </div>

          {/* Frequency + Frequency Detail */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Sıklık"
              required
              value={formData.frequency}
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  frequency: e.target.value as RecurrenceFrequency,
                }))
              }
              options={Object.entries(FREQUENCY_CONFIG).map(([key, val]) => ({
                value: key,
                label: val.label,
              }))}
            />
            {formData.frequency === 'CUSTOM' && (
              <Input
                label="Saat cinsinden interval"
                fullWidth
                type="text"
                value={formData.frequencyDetail}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, frequencyDetail: e.target.value }))
                }
                placeholder="Örn: 8 (8 saatte bir)"
              />
            )}
          </div>

          {/* Assignee */}
          <Select
            label="Atanan Kişi"
            required
            placeholder={users.length === 0 ? 'Yükleniyor...' : 'Seçin...'}
            value={formData.assignedTo}
            onChange={(e) => handleAssigneeChange(e.target.value)}
            options={users.map((a) => ({ value: a.id, label: a.name }))}
          />

          {/* Location + Estimated Minutes */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Konum"
              fullWidth
              type="text"
              value={formData.location}
              onChange={(e) => setFormData((prev) => ({ ...prev, location: e.target.value }))}
              placeholder="Kafes 1, Tank 2..."
            />
            <Input
              label="Tahmini Süre (dk)"
              fullWidth
              type="number"
              value={formData.estimatedMinutes}
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  estimatedMinutes: parseInt(e.target.value) || 0,
                }))
              }
              min={0}
            />
          </div>

          {/* Checklist */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Kontrol Listesi
            </label>
            {formData.checklistItems.map((item) => (
              <div key={item.id} className="flex items-center gap-2 mb-1">
                <span className="flex-1 text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-3 py-1.5 rounded">
                  {item.text}
                </span>
                <Button variant="ghost" type="button" onClick={() => removeChecklistItem(item.id)}>
                  Sil
                </Button>
              </div>
            ))}
            <div className="flex gap-2 mt-1">
              <Input
                type="text"
                value={newChecklistItem}
                onChange={(e) => setNewChecklistItem(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addChecklistItem())}
                placeholder="Yeni madde ekle..."
              />
              <button
                type="button"
                onClick={addChecklistItem}
                className="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
              >
                Ekle
              </button>
            </div>
          </div>

          {/* Tags */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Etiketler
            </label>
            <div className="flex flex-wrap gap-1 mb-2">
              {formData.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                >
                  {tag}
                  <Button variant="ghost" type="button" onClick={() => removeTag(tag)}>
                    &times;
                  </Button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                type="text"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())}
                placeholder="Etiket ekle..."
              />
              <button
                type="button"
                onClick={addTag}
                className="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
              >
                Ekle
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
          <Button variant="secondary" type="button" onClick={onClose}>
            İptal
          </Button>
          <Button variant="primary" type="submit" disabled={loading}>
            {loading ? 'Kaydediliyor...' : isEdit ? 'Güncelle' : 'Oluştur'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
