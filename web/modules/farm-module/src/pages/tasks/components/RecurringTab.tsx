import React, { useState } from 'react';
import {
  RecurringTemplate,
  CATEGORY_CONFIG,
  PRIORITY_CONFIG,
  FREQUENCY_CONFIG,
} from '../types/task.types';
import { DataTable, type DataTableColumn, Button } from '@aquaculture/shared-ui';
import { Search } from 'lucide-react';

interface RecurringTabProps {
  templates: RecurringTemplate[];
  onToggleActive: (templateId: string) => void;
}

export const RecurringTab: React.FC<RecurringTabProps> = ({ templates, onToggleActive }) => {
  const [search, setSearch] = useState('');

  const filtered = templates.filter(
    (t) => !search || t.title.toLowerCase().includes(search.toLowerCase()),
  );

  type TmplRow = (typeof filtered)[number];
  const tmplRowColumns: DataTableColumn<TmplRow>[] = [
    {
      key: 'ablon',
      header: 'Şablon',
      render: (_value, tmpl) => (
        <div>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{tmpl.title}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {tmpl.description
              ? tmpl.description.length > 60
                ? `${tmpl.description.substring(0, 60)}...`
                : tmpl.description
              : ''}
          </p>
          {tmpl.checklistItems.length > 0 && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
              {tmpl.checklistItems.length} kontrol maddesi
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'kategori',
      header: 'Kategori',
      render: (_value, tmpl) => {
        const cat = CATEGORY_CONFIG[tmpl.category];
        return (
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cat.bg} ${cat.color}`}
          >
            {cat.label}
          </span>
        );
      },
    },
    {
      key: 'sKlK',
      header: 'Sıklık',
      render: (_value, tmpl) => {
        const freq = FREQUENCY_CONFIG[tmpl.frequency];
        return (
          <div>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${freq.bg} ${freq.color}`}
            >
              {freq.label}
            </span>
            {tmpl.frequencyDetail && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {tmpl.frequencyDetail}
              </p>
            )}
          </div>
        );
      },
    },
    {
      key: 'ncelik',
      header: 'Öncelik',
      render: (_value, tmpl) => {
        const pri = PRIORITY_CONFIG[tmpl.priority];
        return (
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${pri.bg} ${pri.color}`}
          >
            {pri.label}
          </span>
        );
      },
    },
    {
      key: 'atanan',
      header: 'Atanan',
      render: (_value, tmpl) => tmpl.assignedToName,
    },
    {
      key: 'sonOluTurma',
      header: 'Son Oluşturma',
      render: (_value, tmpl) => (
        <>
          {tmpl.lastGenerated
            ? new Date(tmpl.lastGenerated).toLocaleDateString('tr-TR', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })
            : '-'}
        </>
      ),
    },
    {
      key: 'sonraki',
      header: 'Sonraki',
      render: (_value, tmpl) => (
        <>
          {tmpl.nextGeneration
            ? new Date(tmpl.nextGeneration).toLocaleDateString('tr-TR', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })
            : '-'}
        </>
      ),
    },
    {
      key: 'durum',
      header: 'Durum',
      render: (_value, tmpl) => (
        <>
          <button
            onClick={() => onToggleActive(tmpl.id)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              tmpl.isActive ? 'bg-success-500' : 'bg-gray-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white dark:bg-gray-900 transition-transform ${
                tmpl.isActive ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Şablon ara..."
            className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500"
          />
          <Search
            className="absolute left-3 top-2.5 w-5 h-5 text-gray-400 dark:text-gray-500"
            aria-hidden="true"
          />
        </div>
        <Button variant="primary">+ Yeni Şablon</Button>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        <DataTable<TmplRow>
          data={filtered}
          columns={tmplRowColumns}
          keyExtractor={(tmpl) => tmpl.id}
          emptyMessage="Tekrarlayan şablon bulunamadı."
          searchable={false}
          sortable={false}
          stickyHeader={false}
        />
      </div>
    </div>
  );
};
