import { clsx } from 'clsx';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import type { Task } from '@/types';

interface TaskCardProps {
  task: Task;
  onPress?: (task: Task) => void;
}

const PRIORITY_COLORS: Record<string, string> = {
  URGENT: 'bg-red-500',
  HIGH: 'bg-orange-500',
  MEDIUM: 'bg-blue-500',
  LOW: 'bg-gray-400',
};

const CATEGORY_LABELS: Record<string, string> = {
  FEEDING: 'Feeding',
  WATER_QUALITY: 'Water Quality',
  HEALTH_CHECK: 'Health',
  EQUIPMENT_MAINTENANCE: 'Equipment',
  STOCK_MANAGEMENT: 'Stock',
  CLEANING: 'Cleaning',
  REGULATORY: 'Regulatory',
  HARVEST: 'Harvest',
  ENVIRONMENTAL: 'Environment',
  SAFETY: 'Safety',
  GENERAL: 'General',
};

export function TaskCard({ task, onPress }: TaskCardProps): ReactElement {
  const navigate = useNavigate();

  // FARM-HIGH-301: checklistItems is a typed object list on the wire.
  const checklistItems = task.checklistItems;
  const completedItems = checklistItems.filter((item) => item.isCompleted);
  const totalItems = checklistItems.length;
  const progress = totalItems > 0 ? (completedItems.length / totalItems) * 100 : 0;

  const handlePress = (): void => {
    if (onPress) {
      onPress(task);
    } else {
      navigate(`/tasks/${task.id}`);
    }
  };

  const priorityColor = PRIORITY_COLORS[task.priority] || 'bg-gray-400';
  const categoryLabel = CATEGORY_LABELS[task.category] || task.category;

  return (
    <button
      onClick={handlePress}
      className="w-full bg-white dark:bg-gray-900 rounded-2xl shadow-card overflow-hidden border border-gray-100 dark:border-gray-800 text-left touch-feedback transition-all active:scale-[0.98]"
    >
      <div className="flex">
        {/* Priority color strip */}
        <div className={clsx('w-1.5 flex-shrink-0 rounded-l-2xl', priorityColor)} />

        <div className="flex-1 p-4">
          {/* Top row: title + due time */}
          <div className="flex items-start justify-between gap-2 mb-2">
            <h3 className="font-semibold text-gray-900 dark:text-white text-[15px] leading-tight line-clamp-2">
              {task.title}
            </h3>
            {task.dueTime && (
              <span className="text-xs text-gray-400 font-medium whitespace-nowrap mt-0.5">
                {task.dueTime}
              </span>
            )}
          </div>

          {/* Category badge */}
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11px] font-semibold text-ocean-600 bg-ocean-50 dark:bg-ocean-900/30 px-2 py-0.5 rounded-md">
              {categoryLabel}
            </span>
            {task.status === 'IN_PROGRESS' && (
              <span className="text-[11px] font-semibold text-amber-600 bg-amber-50 dark:bg-amber-900/30 px-2 py-0.5 rounded-md">
                In Progress
              </span>
            )}
          </div>

          {/* Checklist progress bar */}
          {totalItems > 0 && (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 rounded-full transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className="text-[11px] text-gray-400 font-medium">
                {completedItems.length}/{totalItems}
              </span>
            </div>
          )}
        </div>
      </div>
    </button>
  );
}
