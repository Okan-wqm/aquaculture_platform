import React, { useState } from 'react';
import {
  Task,
  CATEGORY_CONFIG,
} from '../types/task.types';
import { TaskDetailModal } from './TaskDetailModal';

interface CompletedTabProps {
  tasks: readonly Task[];
  onToggleChecklist: (taskId: string, checklistId: string, isCompleted: boolean) => void;
  onAddNote: (taskId: string, note: string) => void;
}

export const CompletedTab: React.FC<CompletedTabProps> = ({
  tasks,
  onToggleChecklist,
  onAddNote,
}) => {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  const completedTasks = tasks
    .filter(t => t.status === 'COMPLETED')
    .filter(t => {
      if (!t.completedAt) return true;
      const completedDate = t.completedAt.split('T')[0];
      if (dateFrom && completedDate < dateFrom) return false;
      if (dateTo && completedDate > dateTo) return false;
      return true;
    })
    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));

  // Stats
  const now = new Date();
  const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);
  const monthAgo = new Date(now); monthAgo.setMonth(now.getMonth() - 1);
  const weekAgoStr = weekAgo.toISOString().split('T')[0];
  const monthAgoStr = monthAgo.toISOString().split('T')[0];

  const allCompleted = tasks.filter(t => t.status === 'COMPLETED');
  const thisWeek = allCompleted.filter(t => t.completedAt && t.completedAt >= weekAgoStr).length;
  const thisMonth = allCompleted.filter(t => t.completedAt && t.completedAt >= monthAgoStr).length;

  const avgMinutes = allCompleted.length > 0
    ? Math.round(allCompleted.reduce((sum, t) => sum + (t.estimatedMinutes || 0), 0) / allCompleted.length)
    : 0;

  const statsCards = [
    { label: 'Bu Hafta', value: thisWeek, suffix: 'görev' },
    { label: 'Bu Ay', value: thisMonth, suffix: 'görev' },
    { label: 'Toplam', value: allCompleted.length, suffix: 'görev' },
    { label: 'Ort. Süre', value: avgMinutes, suffix: 'dk' },
  ];

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {statsCards.map(card => (
          <div key={card.label} className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <p className="text-sm text-gray-500">{card.label}</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">
              {card.value} <span className="text-sm font-normal text-gray-400">{card.suffix}</span>
            </p>
          </div>
        ))}
      </div>

      {/* Date Filter */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-gray-600">Tarih Aralığı:</label>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
        />
        <span className="text-gray-400">-</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
        />
        {(dateFrom || dateTo) && (
          <button
            onClick={() => { setDateFrom(''); setDateTo(''); }}
            className="text-sm text-blue-600 hover:text-blue-800"
          >
            Temizle
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Görev</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Kategori</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tamamlanma</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tamamlayan</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Süre</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {completedTasks.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-gray-500">
                    Tamamlanan görev bulunamadı.
                  </td>
                </tr>
              ) : (
                completedTasks.map(task => {
                  const cat = CATEGORY_CONFIG[task.category];
                  return (
                    <tr key={task.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setSelectedTask(task)}
                          className="text-sm font-medium text-gray-900 hover:text-blue-600 text-left"
                        >
                          {task.title}
                        </button>
                        {task.location && <p className="text-xs text-gray-500">{task.location}</p>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cat.bg} ${cat.color}`}>
                          {cat.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700">{task.completedAt || '-'}</td>
                      <td className="px-4 py-3 text-sm text-gray-700">{task.completedBy || '-'}</td>
                      <td className="px-4 py-3 text-sm text-gray-700">
                        {task.estimatedMinutes ? `${task.estimatedMinutes} dk` : '-'}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail Modal */}
      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onToggleChecklist={onToggleChecklist}
          onAddNote={onAddNote}
          onComplete={() => {}}
        />
      )}
    </div>
  );
};
