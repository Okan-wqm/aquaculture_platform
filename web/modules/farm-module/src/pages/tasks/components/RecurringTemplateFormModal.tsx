import React, { useState, useEffect } from 'react';
import { Modal } from '@aquaculture/shared-ui';
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
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Şablon Adı *</label>
            <input
              type="text"
              value={formData.title}
              onChange={(e) => setFormData((prev) => ({ ...prev, title: e.target.value }))}
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
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Category + Priority */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Kategori *</label>
              <select
                value={formData.category}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, category: e.target.value as TaskCategory }))
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
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
                value={formData.priority}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, priority: e.target.value as TaskPriority }))
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              >
                {Object.entries(PRIORITY_CONFIG).map(([key, val]) => (
                  <option key={key} value={key}>
                    {val.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Frequency + Frequency Detail */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Sıklık *</label>
              <select
                value={formData.frequency}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    frequency: e.target.value as RecurrenceFrequency,
                  }))
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              >
                {Object.entries(FREQUENCY_CONFIG).map(([key, val]) => (
                  <option key={key} value={key}>
                    {val.label}
                  </option>
                ))}
              </select>
            </div>
            {formData.frequency === 'CUSTOM' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Saat cinsinden interval
                </label>
                <input
                  type="text"
                  value={formData.frequencyDetail}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, frequencyDetail: e.target.value }))
                  }
                  placeholder="Örn: 8 (8 saatte bir)"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            )}
          </div>

          {/* Assignee */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Atanan Kişi *</label>
            <select
              value={formData.assignedTo}
              onChange={(e) => handleAssigneeChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              required
            >
              <option value="">{users.length === 0 ? 'Yükleniyor...' : 'Seçin...'}</option>
              {users.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          {/* Location + Estimated Minutes */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Konum</label>
              <input
                type="text"
                value={formData.location}
                onChange={(e) => setFormData((prev) => ({ ...prev, location: e.target.value }))}
                placeholder="Kafes 1, Tank 2..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tahmini Süre (dk)
              </label>
              <input
                type="number"
                value={formData.estimatedMinutes}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    estimatedMinutes: parseInt(e.target.value) || 0,
                  }))
                }
                min={0}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Checklist */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Kontrol Listesi</label>
            {formData.checklistItems.map((item) => (
              <div key={item.id} className="flex items-center gap-2 mb-1">
                <span className="flex-1 text-sm text-gray-700 bg-gray-50 px-3 py-1.5 rounded">
                  {item.text}
                </span>
                <button
                  type="button"
                  onClick={() => removeChecklistItem(item.id)}
                  className="text-red-500 hover:text-red-700 text-sm"
                >
                  Sil
                </button>
              </div>
            ))}
            <div className="flex gap-2 mt-1">
              <input
                type="text"
                value={newChecklistItem}
                onChange={(e) => setNewChecklistItem(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addChecklistItem())}
                placeholder="Yeni madde ekle..."
                className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={addChecklistItem}
                className="px-3 py-1.5 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200"
              >
                Ekle
              </button>
            </div>
          </div>

          {/* Tags */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Etiketler</label>
            <div className="flex flex-wrap gap-1 mb-2">
              {formData.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-700"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    &times;
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())}
                placeholder="Etiket ekle..."
                className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={addTag}
                className="px-3 py-1.5 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200"
              >
                Ekle
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-4 pt-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-100"
          >
            İptal
          </button>
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Kaydediliyor...' : isEdit ? 'Güncelle' : 'Oluştur'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
