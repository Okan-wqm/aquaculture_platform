import React, { useState } from 'react';
import {
  useConfirm,
  DataTable,
  type DataTableColumn,
  Button,
  Select,
} from '@aquaculture/shared-ui';
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
import { Check, Search, Trash2 } from 'lucide-react';

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

  const activeTasks = tasks.filter((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED');

  const filtered = activeTasks.filter((t) => {
    if (search && !t.title.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterCategory !== 'all' && t.category !== filterCategory) return false;
    if (filterStatus !== 'all' && t.status !== filterStatus) return false;
    if (filterPriority !== 'all' && t.priority !== filterPriority) return false;
    if (filterAssignee !== 'all' && t.assignedTo !== filterAssignee) return false;
    return true;
  });

  const assignees =
    users.length > 0
      ? users
      : [
          ...new Set(
            activeTasks.map((t) => JSON.stringify({ id: t.assignedTo, name: t.assignedToName })),
          ),
        ].map((s) => JSON.parse(s));

  const confirm = useConfirm();
  const handleBulkComplete = async () => {
    if (
      !(await confirm({
        title: `${selectedIds.size} görevi tamamla?`,
        confirmText: 'Tamamla',
        cancelText: 'Vazgeç',
        variant: 'info',
      }))
    )
      return;
    for (const id of selectedIds) {
      await onToggleComplete(id);
    }
    setSelectedIds(new Set());
  };

  const handleBulkDelete = async () => {
    if (
      !(await confirm({
        title: `${selectedIds.size} görevi sil?`,
        message: 'Bu işlem geri alınamaz.',
        confirmText: 'Sil',
        cancelText: 'Vazgeç',
        variant: 'danger',
      }))
    )
      return;
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
          <Button variant="ghost" onClick={() => setSelectedTask(task)}>
            {task.title}
          </Button>
          {task.location && (
            <p className="text-xs text-gray-500 dark:text-gray-400">{task.location}</p>
          )}
        </>
      ),
    },
    {
      key: 'kategori',
      header: 'Kategori',
      render: (_value, task) => {
        const cat = CATEGORY_CONFIG[task.category];
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
      key: 'ncelik',
      header: 'Öncelik',
      render: (_value, task) => {
        const pri = PRIORITY_CONFIG[task.priority];
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
      render: (_value, task) => task.assignedToName,
    },
    {
      key: 'biti',
      header: 'Bitiş',
      render: (_value, task) => (
        <>
          {task.dueDate}
          {task.dueTime && (
            <span className="text-gray-400 dark:text-gray-500 ml-1">{task.dueTime}</span>
          )}
        </>
      ),
    },
    {
      key: 'durum',
      header: 'Durum',
      render: (_value, task) => {
        const sts = STATUS_CONFIG[task.status];
        return (
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${sts.bg} ${sts.color}`}
          >
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
          <Button variant="ghost" onClick={() => onToggleComplete(task.id)} title="Tamamla">
            <Check className="w-5 h-5" aria-hidden="true" />
          </Button>
          <Button variant="ghost" onClick={() => onDeleteTask(task.id)} title="Sil">
            <Trash2 className="w-5 h-5" aria-hidden="true" />
          </Button>
        </div>
      ),
    },
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
              className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500"
            />
            <Search
              className="absolute left-3 top-2.5 w-5 h-5 text-gray-400 dark:text-gray-500"
              aria-hidden="true"
            />
          </div>
          <Select
            aria-label="Kategori filtresi"
            fullWidth={false}
            size="sm"
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            options={[
              { value: 'all', label: 'Tüm Kategoriler' },
              ...Object.entries(CATEGORY_CONFIG).map(([k, v]) => ({ value: k, label: v.label })),
            ]}
          />
          <Select
            aria-label="Durum filtresi"
            fullWidth={false}
            size="sm"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            options={[
              { value: 'all', label: 'Tüm Durumlar' },
              ...Object.entries(STATUS_CONFIG).map(([k, v]) => ({ value: k, label: v.label })),
            ]}
          />
          <Select
            aria-label="Öncelik filtresi"
            fullWidth={false}
            size="sm"
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value)}
            options={[
              { value: 'all', label: 'Tüm Öncelikler' },
              ...Object.entries(PRIORITY_CONFIG).map(([k, v]) => ({ value: k, label: v.label })),
            ]}
          />
          <Select
            aria-label="Kişi filtresi"
            fullWidth={false}
            size="sm"
            value={filterAssignee}
            onChange={(e) => setFilterAssignee(e.target.value)}
            options={[
              { value: 'all', label: 'Tüm Kişiler' },
              ...assignees.map((a: { id: string; name: string }) => ({
                value: a.id,
                label: a.name,
              })),
            ]}
          />
        </div>
        <Button variant="primary" onClick={() => setShowCreateModal(true)}>
          + Yeni Görev
        </Button>
      </div>

      {/* Bulk Actions */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded-lg px-4 py-2">
          <span className="text-sm text-info-700 dark:text-info-300 font-medium">
            {selectedIds.size} görev seçili
          </span>
          <Button variant="primary" size="sm" onClick={handleBulkComplete}>
            Tamamla
          </Button>
          <Button variant="danger" size="sm" onClick={handleBulkDelete}>
            Sil
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
            İptal
          </Button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
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
          onComplete={(id) => {
            onToggleComplete(id);
            setSelectedTask(null);
          }}
        />
      )}
      {showCreateModal && (
        <TaskFormModal
          onClose={() => setShowCreateModal(false)}
          onSave={async (data) => {
            await onCreateTask(data);
            setShowCreateModal(false);
          }}
          users={users}
        />
      )}
    </div>
  );
};
