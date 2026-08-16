import React, { useState } from 'react';
import {
  Task,
  TaskStats,
  CATEGORY_CONFIG,
  PRIORITY_CONFIG,
} from '../types/task.types';
import { TaskDetailModal } from './TaskDetailModal';

interface TodayTabProps {
  tasks: readonly Task[];
  stats: TaskStats;
  onToggleComplete: (taskId: string) => void;
  onToggleChecklist: (taskId: string, checklistId: string, isCompleted: boolean) => void;
  onAddNote: (taskId: string, note: string) => void;
  users?: { id: string; name: string }[];
}

export const TodayTab: React.FC<TodayTabProps> = ({
  tasks,
  stats,
  onToggleComplete,
  onToggleChecklist,
  onAddNote,
  users = [],
}) => {
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterAssignee, setFilterAssignee] = useState<string>('all');
  const [filterPriority, setFilterPriority] = useState<string>('all');

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const todayTasks = tasks.filter(t => t.dueDate === todayStr || t.status === 'OVERDUE');

  const filteredTasks = todayTasks.filter(t => {
    if (filterCategory !== 'all' && t.category !== filterCategory) return false;
    if (filterAssignee !== 'all' && t.assignedTo !== filterAssignee) return false;
    if (filterPriority !== 'all' && t.priority !== filterPriority) return false;
    return true;
  });

  // Sort: OVERDUE first, then by priority
  const priorityOrder = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const sortedTasks = [...filteredTasks].sort((a, b) => {
    if (a.status === 'OVERDUE' && b.status !== 'OVERDUE') return -1;
    if (b.status === 'OVERDUE' && a.status !== 'OVERDUE') return 1;
    if (a.status === 'COMPLETED' && b.status !== 'COMPLETED') return 1;
    if (b.status === 'COMPLETED' && a.status !== 'COMPLETED') return -1;
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });

  const assignees = users.length > 0
    ? users
    : [...new Set(todayTasks.map(t => JSON.stringify({ id: t.assignedTo, name: t.assignedToName })))].map(s => JSON.parse(s));

  const statCards = [
    // Tailwind v4 removed `bg-opacity-*`; bake the 10% alpha into the color token via slash syntax.
    { label: 'Bugün Toplam', value: stats.totalToday, color: 'bg-blue-500/10', icon: '📋' },
    { label: 'Tamamlanan', value: stats.completedToday, color: 'bg-green-500/10', icon: '✅' },
    { label: 'Gecikmiş', value: stats.overdueCount, color: 'bg-red-500/10', icon: '⚠️' },
    { label: 'Yaklaşan', value: stats.upcomingCount, color: 'bg-yellow-500/10', icon: '⏰' },
  ];

  return (
    <div className="space-y-6">
      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {statCards.map(card => (
          <div key={card.label} className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">{card.label}</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{card.value}</p>
              </div>
              <div className={`w-12 h-12 ${card.color} rounded-lg flex items-center justify-center text-xl`}>
                {card.icon}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Quick Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">Tüm Kategoriler</option>
          {Object.entries(CATEGORY_CONFIG).map(([key, val]) => (
            <option key={key} value={key}>{val.label}</option>
          ))}
        </select>
        <select
          value={filterAssignee}
          onChange={(e) => setFilterAssignee(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">Tüm Kişiler</option>
          {assignees.map((a: { id: string; name: string }) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <select
          value={filterPriority}
          onChange={(e) => setFilterPriority(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">Tüm Öncelikler</option>
          {Object.entries(PRIORITY_CONFIG).map(([key, val]) => (
            <option key={key} value={key}>{val.label}</option>
          ))}
        </select>
      </div>

      {/* Task List */}
      <div className="space-y-2">
        {sortedTasks.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
            <p className="text-gray-500">Bugün için görev bulunmuyor.</p>
          </div>
        ) : (
          sortedTasks.map(task => {
            const cat = CATEGORY_CONFIG[task.category];
            const pri = PRIORITY_CONFIG[task.priority];
            const isCompleted = task.status === 'COMPLETED';
            const isOverdue = task.status === 'OVERDUE';

            return (
              <div
                key={task.id}
                className={`bg-white rounded-lg border ${isOverdue ? 'border-red-300 bg-red-50' : 'border-gray-200'} p-4 hover:shadow-sm transition-shadow`}
              >
                <div className="flex items-start gap-3">
                  {/* Checkbox */}
                  <input
                    type="checkbox"
                    checked={isCompleted}
                    onChange={() => onToggleComplete(task.id)}
                    className="w-5 h-5 mt-0.5 text-green-600 border-gray-300 rounded focus:ring-green-500 cursor-pointer"
                  />

                  {/* Task Info */}
                  <div
                    className="flex-1 cursor-pointer"
                    onClick={() => setSelectedTask(task)}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-medium ${isCompleted ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                        {task.title}
                      </span>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cat.bg} ${cat.color}`}>
                        {cat.label}
                      </span>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${pri.bg} ${pri.color}`}>
                        {pri.label}
                      </span>
                      {isOverdue && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                          Gecikmiş
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 mt-1 text-sm text-gray-500">
                      <span>{task.assignedToName}</span>
                      {task.dueTime && <span>{task.dueTime}</span>}
                      {task.location && <span>{task.location}</span>}
                      {task.checklistItems.length > 0 && (
                        <span>
                          {task.checklistItems.filter(c => c.isCompleted).length}/{task.checklistItems.length} madde
                        </span>
                      )}
                      {task.notes.length > 0 && (
                        <span>{task.notes.length} not</span>
                      )}
                    </div>
                  </div>

                  {/* Time badge */}
                  {task.dueTime && (
                    <span className="text-sm font-medium text-gray-600 bg-gray-100 px-2 py-1 rounded">
                      {task.dueTime}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Detail Modal */}
      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onToggleChecklist={onToggleChecklist}
          onAddNote={onAddNote}
          onComplete={(id) => { onToggleComplete(id); setSelectedTask(null); }}
        />
      )}
    </div>
  );
};
