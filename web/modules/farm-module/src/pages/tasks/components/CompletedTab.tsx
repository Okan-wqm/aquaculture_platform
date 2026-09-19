import React, { useState } from 'react';
import {
  Task,
  CATEGORY_CONFIG,
} from '../types/task.types';
import { TaskDetailModal } from './TaskDetailModal';
import { DataTable, type DataTableColumn } from '@aquaculture/shared-ui';

interface CompletedTabProps {
  tasks: Task[];
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

  type TaskRow = (typeof completedTasks)[number];
  const taskRowColumns: DataTableColumn<TaskRow>[] = [
    {
      key: 'gRev',
      header: 'Görev',
      render: (_value, task) => (
        <>
          <button
            onClick={() => setSelectedTask(task)}
            className="text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-blue-600 text-left"
          >
            {task.title}
          </button>
          {task.location && <p className="text-xs text-gray-500 dark:text-gray-400">{task.location}</p>}
        </>
      ),
    },
    {
      key: 'kategori',
      header: 'Kategori',
      render: (_value, task) => {
        const cat = CATEGORY_CONFIG[task.category];
        return (
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cat.bg} ${cat.color}`}>
            {cat.label}
          </span>
        );
      },
    },
    {
      key: 'tamamlanma',
      header: 'Tamamlanma',
      render: (_value, task) => task.completedAt || '-',
    },
    {
      key: 'tamamlayan',
      header: 'Tamamlayan',
      render: (_value, task) => task.completedBy || '-',
    },
    {
      key: 'sRe',
      header: 'Süre',
      render: (_value, task) => (
        <>
          {task.estimatedMinutes ? `${task.estimatedMinutes} dk` : '-'}
        </>
      ),
    }
  ];

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {statsCards.map(card => (
          <div key={card.label} className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">{card.label}</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-1">
              {card.value} <span className="text-sm font-normal text-gray-400 dark:text-gray-500">{card.suffix}</span>
            </p>
          </div>
        ))}
      </div>

      {/* Date Filter */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-gray-600 dark:text-gray-400">Tarih Aralığı:</label>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
        />
        <span className="text-gray-400 dark:text-gray-500">-</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
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
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        <DataTable<TaskRow>
          data={completedTasks}
          columns={taskRowColumns}
          keyExtractor={(task) => task.id}
          emptyMessage="Tamamlanan görev bulunamadı."
          searchable={false}
          sortable={false}
          stickyHeader={false}
        />
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
