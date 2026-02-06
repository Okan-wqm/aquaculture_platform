/**
 * Task Management Page
 * 6-tab page for farm task management: today, all tasks, recurring, auto rules, calendar, completed
 */
import React, { useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { mockTasks, mockRecurringTemplates, mockAutoRules, mockTaskStats } from './mock';
import { Task, RecurringTemplate, AutoRule, TaskStats, ChecklistItem, TaskNote } from './types/task.types';
import { TaskFormData } from './components/TaskFormModal';

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

  // State - mock data with local mutations
  const [tasks, setTasks] = useState<Task[]>(mockTasks);
  const [templates, setTemplates] = useState<RecurringTemplate[]>(mockRecurringTemplates);
  const [autoRules, setAutoRules] = useState<AutoRule[]>(mockAutoRules);
  const [stats] = useState<TaskStats>(mockTaskStats);

  const handleTabChange = (tabId: TabId) => {
    setSearchParams({ tab: tabId });
  };

  // Task actions
  const handleToggleComplete = useCallback((taskId: string) => {
    setTasks(prev => prev.map(t => {
      if (t.id !== taskId) return t;
      const isNowComplete = t.status !== 'COMPLETED';
      return {
        ...t,
        status: isNowComplete ? 'COMPLETED' as const : 'PENDING' as const,
        completedAt: isNowComplete ? new Date().toISOString().split('T')[0] : undefined,
        completedBy: isNowComplete ? 'Mevcut Kullanıcı' : undefined,
      };
    }));
  }, []);

  const handleToggleChecklist = useCallback((taskId: string, checklistId: string) => {
    setTasks(prev => prev.map(t => {
      if (t.id !== taskId) return t;
      return {
        ...t,
        checklistItems: t.checklistItems.map(c =>
          c.id === checklistId
            ? { ...c, isCompleted: !c.isCompleted, completedAt: !c.isCompleted ? new Date().toISOString().split('T')[0] : undefined }
            : c
        ),
      };
    }));
  }, []);

  const handleAddNote = useCallback((taskId: string, noteText: string) => {
    const newNote: TaskNote = {
      id: `note-${Date.now()}`,
      text: noteText,
      createdBy: 'Mevcut Kullanıcı',
      createdAt: new Date().toISOString().split('T')[0],
    };
    setTasks(prev => prev.map(t =>
      t.id === taskId ? { ...t, notes: [...t.notes, newNote] } : t
    ));
  }, []);

  const handleCreateTask = useCallback((data: TaskFormData) => {
    const newTask: Task = {
      id: `t-${Date.now()}`,
      title: data.title,
      description: data.description,
      category: data.category,
      priority: data.priority,
      status: 'PENDING',
      assignedTo: data.assignedTo,
      assignedToName: data.assignedToName,
      dueDate: data.dueDate,
      dueTime: data.dueTime || undefined,
      createdAt: new Date().toISOString().split('T')[0],
      location: data.location || undefined,
      estimatedMinutes: data.estimatedMinutes || undefined,
      checklistItems: data.checklistItems,
      notes: [],
      tags: data.tags,
      isRecurring: false,
      isAutoGenerated: false,
    };
    setTasks(prev => [newTask, ...prev]);
  }, []);

  const handleDeleteTask = useCallback((taskId: string) => {
    setTasks(prev => prev.filter(t => t.id !== taskId));
  }, []);

  const handleToggleTemplateActive = useCallback((templateId: string) => {
    setTemplates(prev => prev.map(t =>
      t.id === templateId ? { ...t, isActive: !t.isActive } : t
    ));
  }, []);

  const handleToggleRuleActive = useCallback((ruleId: string) => {
    setAutoRules(prev => prev.map(r =>
      r.id === ruleId ? { ...r, isActive: !r.isActive } : r
    ));
  }, []);

  // Render active tab
  const renderTab = () => {
    switch (activeTab) {
      case 'today':
        return (
          <TodayTab
            tasks={tasks}
            stats={stats}
            onToggleComplete={handleToggleComplete}
            onToggleChecklist={handleToggleChecklist}
            onAddNote={handleAddNote}
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
    <div className="min-h-screen bg-gray-50">
      {/* Page Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="px-4 sm:px-6 py-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Görev Yönetimi</h1>
              <p className="mt-1 text-sm text-gray-500">
                Günlük operasyonlar, tekrarlayan görevler ve otomatik kurallarla çiftlik yönetimi
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="bg-white border-b border-gray-200">
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
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
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
