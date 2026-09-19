/**
 * Task Management Page
 * 6-tab page for farm task management: today, all tasks, recurring, auto rules, calendar, completed
 */
import React, { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TaskStats } from './types/task.types';
import { TaskFormData } from './components/TaskFormModal';
import { useTenantUsers } from '../../hooks/useTenantUsers';
import { useTasks, useRecurringTemplates, useAutoRules } from '../../hooks';

// Default stats used while loading
const defaultStats: TaskStats = {
  totalToday: 0,
  completedToday: 0,
  overdueCount: 0,
  upcomingCount: 0,
  completionRate: 0,
  avgCompletionMinutes: 0,
};

// Tab Components
import { TodayTab } from './components/TodayTab';
import { AllTasksTab } from './components/AllTasksTab';
import { RecurringTab } from './components/RecurringTab';
import { AutoRulesTab } from './components/AutoRulesTab';
import { CalendarTab } from './components/CalendarTab';
import { CompletedTab } from './components/CompletedTab';
import { Spinner, PageHeader } from '@aquaculture/shared-ui';

// ============================================================================
// TYPES
// ============================================================================

type TabId = 'today' | 'all-tasks' | 'recurring' | 'auto-rules' | 'calendar' | 'completed';

interface Tab {
  id: TabId;
  name: string;
  icon: React.ReactNode;
}

// ============================================================================
// TABS CONFIG
// ============================================================================

const tabs: Tab[] = [
  {
    id: 'today',
    name: 'Bugün',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: 'all-tasks',
    name: 'Tüm Görevler',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    ),
  },
  {
    id: 'recurring',
    name: 'Tekrarlayan',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
    ),
  },
  {
    id: 'auto-rules',
    name: 'Oto. Kurallar',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
  },
  {
    id: 'calendar',
    name: 'Takvim',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    id: 'completed',
    name: 'Tamamlanan',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
];

// ============================================================================
// COMPONENT
// ============================================================================

const TasksPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get('tab') as TabId) || 'today';

  const { users: tenantUsers } = useTenantUsers();

  // Real GraphQL hooks
  const {
    tasks,
    stats,
    loading,
    createTask,
    updateTask,
    completeTask: completeTaskMutation,
    startTask,
    deleteTask: deleteTaskMutation,
    toggleChecklistItem: toggleChecklistMutation,
    addTaskNote: addNoteMutation,
    refetch,
  } = useTasks();

  const {
    templates,
    toggleActive: toggleTemplateActive,
  } = useRecurringTemplates(activeTab === 'recurring');

  const {
    autoRules,
    toggleActive: toggleRuleActive,
  } = useAutoRules(activeTab === 'auto-rules');

  const handleTabChange = (tabId: TabId) => {
    setSearchParams({ tab: tabId });
  };

  // Task actions
  const handleToggleComplete = useCallback(async (taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    if (task.status !== 'COMPLETED') {
      await completeTaskMutation(taskId);
    } else {
      await updateTask({ id: taskId, status: 'PENDING' });
    }
  }, [tasks, completeTaskMutation, updateTask]);

  // `isCompleted` is the absolute target state the user is moving the checkbox TO
  // (computed at the checkbox source in TaskDetailModal as `!item.isCompleted`).
  // The farm subgraph's setChecklistItem mutation takes this absolute target, so the
  // desktop click-to-flip UX is preserved without a server-side read-then-flip.
  const handleToggleChecklist = useCallback(async (taskId: string, checklistId: string, isCompleted: boolean) => {
    await toggleChecklistMutation({ taskId, itemId: checklistId, isCompleted });
  }, [toggleChecklistMutation]);

  const handleAddNote = useCallback(async (taskId: string, noteText: string) => {
    await addNoteMutation({ taskId, text: noteText });
  }, [addNoteMutation]);

  const handleCreateTask = useCallback(async (data: TaskFormData) => {
    await createTask({
      title: data.title,
      description: data.description || undefined,
      category: data.category,
      priority: data.priority,
      assignedTo: data.assignedTo || undefined,
      assignedToName: data.assignedToName || undefined,
      dueDate: data.dueDate,
      dueTime: data.dueTime || undefined,
      location: data.location || undefined,
      estimatedMinutes: data.estimatedMinutes || undefined,
      checklistItems: data.checklistItems.map(c => ({
        text: c.text,
        isCompleted: c.isCompleted,
      })),
      tags: data.tags,
    });
  }, [createTask]);

  const handleDeleteTask = useCallback(async (taskId: string) => {
    await deleteTaskMutation(taskId);
  }, [deleteTaskMutation]);

  const handleToggleTemplateActive = useCallback(async (templateId: string) => {
    await toggleTemplateActive(templateId);
  }, [toggleTemplateActive]);

  const handleToggleRuleActive = useCallback((ruleId: string) => {
    toggleRuleActive(ruleId);
  }, [toggleRuleActive]);

  // Render active tab
  const renderTab = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <Spinner size="lg" />
            <p className="text-sm text-gray-500 dark:text-gray-400">Görevler yükleniyor...</p>
          </div>
        </div>
      );
    }

    switch (activeTab) {
      case 'today':
        return (
          <TodayTab
            tasks={tasks}
            stats={stats ?? defaultStats}
            onToggleComplete={handleToggleComplete}
            onToggleChecklist={handleToggleChecklist}
            onAddNote={handleAddNote}
            users={tenantUsers}
          />
        );
      case 'all-tasks':
        return (
          <AllTasksTab
            tasks={tasks}
            onToggleComplete={handleToggleComplete}
            onToggleChecklist={handleToggleChecklist}
            onAddNote={handleAddNote}
            onCreateTask={handleCreateTask}
            onDeleteTask={handleDeleteTask}
            users={tenantUsers}
          />
        );
      case 'recurring':
        return (
          <RecurringTab
            templates={templates}
            onToggleActive={handleToggleTemplateActive}
          />
        );
      case 'auto-rules':
        return (
          <AutoRulesTab
            rules={autoRules}
            onToggleActive={handleToggleRuleActive}
          />
        );
      case 'calendar':
        return (
          <CalendarTab
            tasks={tasks}
            onToggleChecklist={handleToggleChecklist}
            onAddNote={handleAddNote}
            onToggleComplete={handleToggleComplete}
          />
        );
      case 'completed':
        return (
          <CompletedTab
            tasks={tasks}
            onToggleChecklist={handleToggleChecklist}
            onAddNote={handleAddNote}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-800">
      {/* Page Header */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
        <PageHeader
          title="Görev Yönetimi"
          description="Günlük operasyonlar, tekrarlayan görevler ve otomatik kurallarla çiftlik yönetimi"
          leading={
            <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
            </div>
          }
          className="px-4 sm:px-6 py-6"
        />
      </div>

      {/* Tab Navigation */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
        <div className="px-4 sm:px-6">
          <nav className="-mb-px flex space-x-1 overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={`
                  flex items-center gap-2 px-4 py-3 border-b-2 text-sm font-medium whitespace-nowrap transition-colors
                  ${activeTab === tab.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 hover:border-gray-300 dark:hover:border-gray-500'
                  }
                `}
              >
                {tab.icon}
                {tab.name}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      <div className="px-4 sm:px-6 py-6">
        {renderTab()}
      </div>
    </div>
  );
};

export default TasksPage;
