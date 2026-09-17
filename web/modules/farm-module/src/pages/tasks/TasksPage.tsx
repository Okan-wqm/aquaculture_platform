/**
 * Task Management Page
 * 6-tab page for farm task management: today, all tasks, recurring, auto rules, calendar, completed
 */
import React, { useCallback, useState } from 'react';
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

// ============================================================================
// TYPES
// ============================================================================

type TabId = 'today' | 'all-tasks' | 'recurring' | 'auto-rules' | 'calendar' | 'completed';

interface Tab {
  id: TabId;
  name: string;
  icon: React.ReactNode;
}

import { RecurringTemplateFormModal, type RecurringTemplateFormData } from './components/RecurringTemplateFormModal';
import { AutoRuleFormModal, type AutoRuleFormData } from './components/AutoRuleFormModal';

// ============================================================================
// TABS CONFIG
// ============================================================================

const tabs: Tab[] = [
  {
    id: 'today',
    name: 'Today',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: 'all-tasks',
    name: 'All Tasks',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    ),
  },
  {
    id: 'recurring',
    name: 'Recurring',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
    ),
  },
  {
    id: 'auto-rules',
    name: 'Auto Rules',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
  },
  {
    id: 'calendar',
    name: 'Calendar',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    id: 'completed',
    name: 'Completed',
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

/**
 * DATA SOURCES (all real backend — no mocked data): useTasks / useTenantUsers
 * / useRecurringTemplates / useAutoRules hit farm-service GraphQL; every
 * mutation (create/complete/start/update/delete/checklist/note/toggle) is real.
 * `defaultStats` below is only the loading-zero fallback, not mock data.
 *
 * UI LANGUAGE: English (platform directive). Strings are hardcoded English —
 * a deliberate trade-off vs the feedingV2 i18n-key pattern (FE-HIGH-020);
 * key migration is a separate task if Turkish is ever re-enabled.
 *
 * WIRED THIS PASS: the previously-dead '+ New Template' / '+ New Rule'
 * buttons now open their (create-only) modals against real mutations.
 * UNWIRED (no entry point yet): template/rule EDIT + DELETE — the update
 * mutations exist but no row affordance renders them.
 */
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
    createTemplate,
  } = useRecurringTemplates(activeTab === 'recurring');

  const {
    autoRules,
    toggleActive: toggleRuleActive,
    createRule,
  } = useAutoRules(activeTab === 'auto-rules');

  // Create-only modal state (edit path deliberately unwired — see docblock)
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [ruleModalOpen, setRuleModalOpen] = useState(false);

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

  const handleCreateTemplate = useCallback(async (data: RecurringTemplateFormData) => {
    await createTemplate({
      title: data.title,
      description: data.description || undefined,
      category: data.category,
      priority: data.priority,
      frequency: data.frequency,
      frequencyDetail: data.frequencyDetail || undefined,
      assignedTo: data.assignedTo || undefined,
      assignedToName: data.assignedToName || undefined,
      location: data.location || undefined,
      estimatedMinutes: data.estimatedMinutes || undefined,
      // Modal items carry local ids; the create input accepts {text,isCompleted} only
      checklistItems: data.checklistItems.map(c => ({ text: c.text, isCompleted: c.isCompleted })),
      tags: data.tags,
    });
    setTemplateModalOpen(false);
  }, [createTemplate]);

  const handleCreateRule = useCallback(async (data: AutoRuleFormData) => {
    await createRule({
      name: data.name,
      description: data.description || undefined,
      trigger: data.trigger,
      triggerCondition: data.triggerCondition,
      taskTitle: data.taskTitle,
      taskDescription: data.taskDescription || undefined,
      taskCategory: data.taskCategory,
      taskPriority: data.taskPriority,
      assignTo: data.assignTo || undefined,
    });
    setRuleModalOpen(false);
  }, [createRule]);

  // Render active tab
  const renderTab = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
            <p className="text-sm text-gray-500">Loading tasks…</p>
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
            onCreateTemplate={() => setTemplateModalOpen(true)}
          />
        );
      case 'auto-rules':
        return (
          <AutoRulesTab
            rules={autoRules}
            onToggleActive={handleToggleRuleActive}
            onCreateRule={() => setRuleModalOpen(true)}
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
    <div className="sd-page sd-f2">
      {/* Page header (mockup pattern: eyebrow + serif title + subtitle) */}
      <div className="sd-pagehead">
        <span className="sd-eyebrow">Environment</span>
        <h1 className="sd-page-title">Task Management</h1>
        <span className="sd-page-sub">Daily operations, recurring tasks and automation rules</span>
      </div>

      {/* Tab Navigation — SUDERRA underline tabs */}
      <nav className="sd-tabs" aria-label="Tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={`sd-tab${activeTab === tab.id ? ' sd-tab--active' : ''}`}
            aria-current={activeTab === tab.id ? 'page' : undefined}
          >
            {tab.icon}
            {tab.name}
          </button>
        ))}
      </nav>

      {/* Tab Content */}
      <div>
        {renderTab()}
      </div>

      {/* Create-only modals (edit path unwired — see docblock) */}
      {templateModalOpen && (
        <RecurringTemplateFormModal
          isOpen={templateModalOpen}
          onClose={() => setTemplateModalOpen(false)}
          onSubmit={handleCreateTemplate}
          users={tenantUsers}
        />
      )}
      {ruleModalOpen && (
        <AutoRuleFormModal
          rule={null}
          onClose={() => setRuleModalOpen(false)}
          onSave={handleCreateRule}
          users={tenantUsers}
        />
      )}
    </div>
  );
};

export default TasksPage;
