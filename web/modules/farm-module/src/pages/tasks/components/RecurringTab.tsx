import React, { useState } from 'react';
import {
  RecurringTemplate,
  CATEGORY_CONFIG,
  PRIORITY_CONFIG,
  FREQUENCY_CONFIG,
} from '../types/task.types';

interface RecurringTabProps {
  templates: RecurringTemplate[];
  onToggleActive: (templateId: string) => void;
}

export const RecurringTab: React.FC<RecurringTabProps> = ({ templates, onToggleActive }) => {
  const [search, setSearch] = useState('');

  const filtered = templates.filter(t =>
    !search || t.title.toLowerCase().includes(search.toLowerCase())
  );

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
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          />
          <svg className="absolute left-3 top-2.5 w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium whitespace-nowrap">
          + Yeni Şablon
        </button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Şablon</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Kategori</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Sıklık</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Öncelik</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Atanan</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Son Oluşturma</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Sonraki</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Durum</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-500">
                    Tekrarlayan şablon bulunamadı.
                  </td>
                </tr>
              ) : (
                filtered.map(tmpl => {
                  const cat = CATEGORY_CONFIG[tmpl.category];
                  const pri = PRIORITY_CONFIG[tmpl.priority];
                  const freq = FREQUENCY_CONFIG[tmpl.frequency];

                  return (
                    <tr key={tmpl.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div>
                          <p className="text-sm font-medium text-gray-900">{tmpl.title}</p>
                          <p className="text-xs text-gray-500">{tmpl.description ? (tmpl.description.length > 60 ? `${tmpl.description.substring(0, 60)}...` : tmpl.description) : ''}</p>
                          {tmpl.checklistItems.length > 0 && (
                            <p className="text-xs text-gray-400 mt-0.5">{tmpl.checklistItems.length} kontrol maddesi</p>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cat.bg} ${cat.color}`}>
                          {cat.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div>
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${freq.bg} ${freq.color}`}>
                            {freq.label}
                          </span>
                          {tmpl.frequencyDetail && (
                            <p className="text-xs text-gray-500 mt-0.5">{tmpl.frequencyDetail}</p>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${pri.bg} ${pri.color}`}>
                          {pri.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700">{tmpl.assignedToName}</td>
                      <td className="px-4 py-3 text-sm text-gray-700">{tmpl.lastGenerated ? new Date(tmpl.lastGenerated).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'}</td>
                      <td className="px-4 py-3 text-sm text-gray-700">{tmpl.nextGeneration ? new Date(tmpl.nextGeneration).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'}</td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => onToggleActive(tmpl.id)}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                            tmpl.isActive ? 'bg-green-500' : 'bg-gray-300'
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                              tmpl.isActive ? 'translate-x-6' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
