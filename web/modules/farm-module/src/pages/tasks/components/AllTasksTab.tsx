import React, { useState } from 'react';
import { useConfirm, DataTable, type DataTableColumn } from '@aquaculture/shared-ui';
import {
  Task,
  TaskCategory,
  TaskPriority,
  TaskStatus,
  CATEGORY_CONFIG,
  PRIORITY_CONFIG,
  STATUS_CONFIG,
} from '../types/task.types';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskFormModal, TaskFormData } from './TaskFormModal';

interface AllTasksTabProps {
  tasks: Task[];
  onToggleComplete: (taskId: string) => void;
  onToggleChecklist: (taskId: string, checklistId: string, isCompleted: boolean) => void;
  onAddNote: (taskId: string, note: string) => void;
  onCreateTask: (data: TaskFormData) => void;
  onDeleteTask: (taskId: string) => void;
  users?: { id: string; name: string }[];
}

export const AllTasksTab: React.FC<AllTasksTabProps> = ({
  tasks,
  onToggleComplete,
  onToggleChecklist,
  onAddNote,
  onCreateTask,
  onDeleteTask,
  users = [],
}) => {
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterPriority, setFilterPriority] = useState<string>('all');
  const [filterAssignee, setFilterAssignee] = useState<string>('all');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const activeTasks = tasks.filter(t => t.status !== 'COMPLETED' && t.status !== 'CANCELLED');

  const filtered = activeTasks.filter(t => {
    if (search && !t.title.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterCategory !== 'all' && t.category !== filterCategory) return false;
    if (filterStatus !== 'all' && t.status !== filterStatus) return false;
    if (filterPriority !== 'all' && t.priority !== filterPriority) return false;
    if (filterAssignee !== 'all' && t.assignedTo !== filterAssignee) return false;
    return true;
  });

  const assignees = users.length > 0
    ? users
    : [...new Set(activeTasks.map(t => JSON.stringify({ id: t.assignedTo, name: t.assignedToName })))].map(s => JSON.parse(s));

  const confirm = useConfirm();
  const handleBulkComplete = async () => {
    if (!(await confirm({ title: `${selectedIds.size} görevi tamamla?`, confirmText: 'Tamamla', cancelText: 'Vazgeç', variant: 'info' }))) return;
    for (const id of selectedIds) {
      await onToggleComplete(id);
    }
    setSelectedIds(new Set());
  };

  const handleBulkDelete = async () => {
    if (!(await confirm({ title: `${selectedIds.size} görevi sil?`, message: 'Bu işlem geri alınamaz.', confirmText: 'Sil', cancelText: 'Vazgeç', variant: 'danger' }))) return;
    for (const id of selectedIds) {
      await onDeleteTask(id);
    }
    setSelectedIds(new Set());
  };

  type TaskRow = (typeof filtered)[number];
  const taskRowColumns: DataTableColumn<TaskRow>[] = [
    {
      key: 'gRev',
      header: 'Görev',
      render: (_value, task) => (
        <>
          <button
            onClick={() => setSelectedTask(task)}
            className="text-sm font-medium text-gray-900 hover:text-blue-600 text-left"
          >
            {task.title}
          </button>
          {task.location && <p className="text-xs text-gray-500">{task.location}</p>}
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
      key: 'ncelik',
      header: 'Öncelik',
      render: (_value, task) => {
        const pri = PRIORITY_CONFIG[task.priority];
        return (
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${pri.bg} ${pri.color}`}>
            {pri.label}
          </span>
        );
      },
    },
    {
      key: 'atanan',
      header: 'Atanan',
      render: (_value, task) => task.assignedToName,
    },
    {
      key: 'biti',
      header: 'Bitiş',
      render: (_value, task) => (
        <>
          {task.dueDate}
          {task.dueTime && <span className="text-gray-400 ml-1">{task.dueTime}</span>}
        </>
      ),
    },
    {
      key: 'durum',
      header: 'Durum',
      render: (_value, task) => {
        const sts = STATUS_CONFIG[task.status];
        return (
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${sts.bg} ${sts.color}`}>
            {sts.label}
          </span>
        );
      },
    },
    {
      key: 'lem',
      header: 'İşlem',
      render: (_value, task) => (
        <div className="flex items-center gap-2">
          <button
            onClick={() => onToggleComplete(task.id)}
            className="text-green-600 hover:text-green-800 text-sm"
            title="Tamamla"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </button>
          <button
            onClick={() => onDeleteTask(task.id)}
            className="text-red-600 hover:text-red-800 text-sm"
            title="Sil"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      ),
    }
  ];

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex flex-1 gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Görev ara..."
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
            <svg className="absolute left-3 top-2.5 w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
            <option value="all">Tüm Kategoriler</option>
            {Object.entries(CATEGORY_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
            <option value="all">Tüm Durumlar</option>
            {Object.entries(STATUS_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
            <option value="all">Tüm Öncelikler</option>
            {Object.entries(PRIORITY_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
            <option value="all">Tüm Kişiler</option>
            {assignees.map((a: { id: string; name: string }) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium whitespace-nowrap"
        >
          + Yeni Görev
        </button>
      </div>

      {/* Bulk Actions */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2">
          <span className="text-sm text-blue-700 font-medium">{selectedIds.size} görev seçili</span>
          <button onClick={handleBulkComplete} className="px-3 py-1 bg-green-600 text-white text-sm rounded hover:bg-green-700">
            Tamamla
          </button>
          <button onClick={handleBulkDelete} className="px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700">
            Sil
          </button>
          <button onClick={() => setSelectedIds(new Set())} className="px-3 py-1 text-sm text-gray-600 hover:text-gray-800">
            İptal
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <DataTable<TaskRow>
          data={filtered}
          columns={taskRowColumns}
          keyExtractor={(task) => task.id}
          emptyMessage="Görev bulunamadı."
          searchable={false}
          sortable={false}
          stickyHeader={false}
          selectable
          selectedRows={Array.from(selectedIds)}
          onSelectionChange={(ids) => setSelectedIds(new Set(ids))}
        />
      </div>

      {/* Modals */}
      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onToggleChecklist={onToggleChecklist}
          onAddNote={onAddNote}
          onComplete={(id) => { onToggleComplete(id); setSelectedTask(null); }}
        />
      )}
      {showCreateModal && (
        <TaskFormModal
          onClose={() => setShowCreateModal(false)}
          onSave={async (data) => { await onCreateTask(data); setShowCreateModal(false); }}
          users={users}
        />
      )}
    </div>
  );
};
