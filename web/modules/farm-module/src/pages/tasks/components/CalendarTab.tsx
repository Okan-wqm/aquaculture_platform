import React, { useState } from 'react';
import { Modal } from '@aquaculture/shared-ui';
import { Task, CATEGORY_CONFIG, PRIORITY_CONFIG } from '../types/task.types';
import { TaskDetailModal } from './TaskDetailModal';

interface CalendarTabProps {
  tasks: Task[];
  onToggleChecklist: (taskId: string, checklistId: string, isCompleted: boolean) => void;
  onAddNote: (taskId: string, note: string) => void;
  onToggleComplete: (taskId: string) => void;
}

type ViewMode = 'week' | 'month';

export const CalendarTab: React.FC<CalendarTabProps> = ({
  tasks,
  onToggleChecklist,
  onAddNote,
  onToggleComplete,
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>('week');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedDayTasks, setSelectedDayTasks] = useState<Task[] | null>(null);

  const getWeekDays = (date: Date): Date[] => {
    const start = new Date(date);
    const day = start.getDay();
    const diff = start.getDate() - day + (day === 0 ? -6 : 1);
    start.setDate(diff);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  };

  const getMonthDays = (date: Date): (Date | null)[] => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startPad = (firstDay.getDay() + 6) % 7;

    const days: (Date | null)[] = Array(startPad).fill(null);
    for (let d = 1; d <= lastDay.getDate(); d++) {
      days.push(new Date(year, month, d));
    }
    return days;
  };

  const getTasksForDate = (date: Date): Task[] => {
    const dateStr = date.toISOString().split('T')[0];
    return tasks.filter((t) => t.dueDate === dateStr);
  };

  const formatDate = (d: Date) => d.toISOString().split('T')[0];
  const todayStr = formatDate(new Date());

  const navigateWeek = (dir: number) => {
    setCurrentDate((prev) => {
      const d = new Date(prev);
      d.setDate(d.getDate() + dir * 7);
      return d;
    });
  };

  const navigateMonth = (dir: number) => {
    setCurrentDate((prev) => {
      const d = new Date(prev);
      d.setMonth(d.getMonth() + dir);
      return d;
    });
  };

  const weekDays = getWeekDays(currentDate);
  const monthDays = getMonthDays(currentDate);
  const dayNames = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];

  const getCategoryDot = (category: string) => {
    const colors: Record<string, string> = {
      FEEDING: 'bg-orange-400',
      WATER_QUALITY: 'bg-blue-400',
      HEALTH_CHECK: 'bg-red-400',
      EQUIPMENT_MAINTENANCE: 'bg-gray-400',
      STOCK_MANAGEMENT: 'bg-purple-400',
      CLEANING: 'bg-cyan-400',
      REGULATORY: 'bg-indigo-400',
      HARVEST: 'bg-green-400',
      ENVIRONMENTAL: 'bg-emerald-400',
      SAFETY: 'bg-yellow-400',
      GENERAL: 'bg-slate-400',
    };
    return colors[category] || 'bg-gray-400';
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => (viewMode === 'week' ? navigateWeek(-1) : navigateMonth(-1))}
            className="p-2 hover:bg-gray-100 rounded-lg"
          >
            <svg
              className="w-5 h-5 text-gray-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
          <h3 className="text-lg font-semibold text-gray-900">
            {viewMode === 'week'
              ? `${weekDays[0].toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })} - ${weekDays[6].toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' })}`
              : currentDate.toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' })}
          </h3>
          <button
            onClick={() => (viewMode === 'week' ? navigateWeek(1) : navigateMonth(1))}
            className="p-2 hover:bg-gray-100 rounded-lg"
          >
            <svg
              className="w-5 h-5 text-gray-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <button
            onClick={() => setCurrentDate(new Date())}
            className="px-3 py-1 text-sm text-blue-600 hover:bg-blue-50 rounded-lg"
          >
            Bugün
          </button>
        </div>

        {/* View Toggle */}
        <div className="flex bg-gray-100 rounded-lg p-0.5">
          <button
            onClick={() => setViewMode('week')}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${viewMode === 'week' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
          >
            Hafta
          </button>
          <button
            onClick={() => setViewMode('month')}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${viewMode === 'month' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
          >
            Ay
          </button>
        </div>
      </div>

      {/* Weekly View */}
      {viewMode === 'week' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="grid grid-cols-7 border-b border-gray-200">
            {weekDays.map((day, i) => {
              const isToday = formatDate(day) === todayStr;
              const dayTasks = getTasksForDate(day);
              return (
                <div
                  key={i}
                  className={`p-3 border-r last:border-r-0 border-gray-200 min-h-[200px] cursor-pointer hover:bg-gray-50 ${isToday ? 'bg-blue-50' : ''}`}
                  onClick={() => dayTasks.length > 0 && setSelectedDayTasks(dayTasks)}
                >
                  <div className="text-center mb-2">
                    <p className="text-xs text-gray-500">{dayNames[i]}</p>
                    <p
                      className={`text-lg font-semibold ${isToday ? 'text-blue-600' : 'text-gray-900'}`}
                    >
                      {day.getDate()}
                    </p>
                    {dayTasks.length > 0 && (
                      <span className="text-xs text-gray-500">{dayTasks.length} görev</span>
                    )}
                  </div>
                  <div className="space-y-1">
                    {dayTasks.slice(0, 4).map((task) => (
                      <div
                        key={task.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedTask(task);
                        }}
                        className={`text-xs p-1.5 rounded cursor-pointer hover:opacity-80 ${
                          task.status === 'COMPLETED'
                            ? 'bg-green-50 text-green-700 line-through'
                            : task.status === 'OVERDUE'
                              ? 'bg-red-50 text-red-700'
                              : 'bg-gray-50 text-gray-700'
                        }`}
                      >
                        <div className="flex items-center gap-1">
                          <span
                            className={`w-2 h-2 rounded-full flex-shrink-0 ${getCategoryDot(task.category)}`}
                          />
                          <span className="truncate">{task.title}</span>
                        </div>
                        {task.dueTime && <span className="text-gray-400 ml-3">{task.dueTime}</span>}
                      </div>
                    ))}
                    {dayTasks.length > 4 && (
                      <p className="text-xs text-gray-400 text-center">
                        +{dayTasks.length - 4} daha
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Monthly View */}
      {viewMode === 'month' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          {/* Day names header */}
          <div className="grid grid-cols-7 border-b border-gray-200">
            {dayNames.map((name) => (
              <div
                key={name}
                className="px-2 py-2 text-center text-xs font-medium text-gray-500 uppercase"
              >
                {name}
              </div>
            ))}
          </div>
          {/* Calendar grid */}
          <div className="grid grid-cols-7">
            {monthDays.map((day, i) => {
              if (!day) {
                return (
                  <div
                    key={`empty-${i}`}
                    className="p-2 border-r border-b border-gray-100 min-h-[80px] bg-gray-50"
                  />
                );
              }
              const isToday = formatDate(day) === todayStr;
              const dayTasks = getTasksForDate(day);
              return (
                <div
                  key={i}
                  className={`p-2 border-r border-b border-gray-100 min-h-[80px] cursor-pointer hover:bg-gray-50 ${isToday ? 'bg-blue-50' : ''}`}
                  onClick={() => dayTasks.length > 0 && setSelectedDayTasks(dayTasks)}
                >
                  <p className={`text-sm ${isToday ? 'font-bold text-blue-600' : 'text-gray-700'}`}>
                    {day.getDate()}
                  </p>
                  <div className="mt-1 space-y-0.5">
                    {dayTasks.slice(0, 2).map((task) => (
                      <div key={task.id} className="flex items-center gap-1">
                        <span
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${getCategoryDot(task.category)}`}
                        />
                        <span className="text-xs text-gray-600 truncate">{task.title}</span>
                      </div>
                    ))}
                    {dayTasks.length > 2 && (
                      <p className="text-xs text-gray-400">+{dayTasks.length - 2}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Day Tasks Panel */}
      {selectedDayTasks && (
        <Modal
          isOpen
          onClose={() => setSelectedDayTasks(null)}
          title={`${selectedDayTasks[0]?.dueDate} - ${selectedDayTasks.length} Görev`}
          size="md"
        >
          <div className="space-y-2">
            {selectedDayTasks.map((task) => {
              const cat = CATEGORY_CONFIG[task.category];
              const pri = PRIORITY_CONFIG[task.priority];
              return (
                <div
                  key={task.id}
                  onClick={() => {
                    setSelectedDayTasks(null);
                    setSelectedTask(task);
                  }}
                  className="p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`w-2 h-2 rounded-full ${getCategoryDot(task.category)}`} />
                    <span className="text-sm font-medium text-gray-900">{task.title}</span>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${cat.bg} ${cat.color}`}
                    >
                      {cat.label}
                    </span>
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${pri.bg} ${pri.color}`}
                    >
                      {pri.label}
                    </span>
                    {task.dueTime && <span className="text-xs text-gray-500">{task.dueTime}</span>}
                    <span className="text-xs text-gray-500">{task.assignedToName}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Modal>
      )}

      {/* Task Detail Modal */}
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
    </div>
  );
};
