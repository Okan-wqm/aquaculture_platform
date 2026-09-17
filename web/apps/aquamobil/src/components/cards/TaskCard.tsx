import { clsx } from 'clsx';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { Card } from '@/components/ui';
import type { Task } from '@/types';

interface TaskCardProps {
  task: Task;
  onPress?: (task: Task) => void;
}

/**
 * WHY NOT <ListRow/>: this card carries three things ListRow has no slot for —
 * a two-line clamped title, the category/status badge pair, and the checklist
 * progress bar. ListRow truncates its title to one line and wraps its subtitle
 * in `truncate`, so adopting it here would silently drop the progress a worker
 * uses to decide whether a task is worth reopening. Today's screen renders its
 * five tasks AS ListRows (HomePage) precisely because it shows none of that;
 * this is the full-list card, and it keeps its own shape.
 */

/**
 * Priority → the tone of the left edge strip. Mirrors HomePage's `taskTone` so
 * one priority means one colour everywhere: URGENT/HIGH alarm, MEDIUM watches,
 * LOW is neutral ink rather than a colour of its own.
 */
const PRIORITY_TONE: Record<string, string> = {
  URGENT: 'bg-crit',
  HIGH: 'bg-crit',
  MEDIUM: 'bg-warn',
  LOW: 'bg-ink-3',
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

  const checklistItems = Array.isArray(task.checklistItems) ? task.checklistItems : [];
  const completedItems = checklistItems.filter((item) =>
    typeof item === 'object' && item !== null
      ? (item as { isCompleted?: boolean }).isCompleted
      : false,
  );
  const totalItems = checklistItems.length;
  const progress = totalItems > 0 ? (completedItems.length / totalItems) * 100 : 0;

  const handlePress = (): void => {
    if (onPress) {
      onPress(task);
    } else {
      navigate(`/tasks/${task.id}`);
    }
  };

  const priorityTone = PRIORITY_TONE[task.priority] || 'bg-ink-3';
  const categoryLabel = CATEGORY_LABELS[task.category] || task.category;

  return (
    <button
      type="button"
      onClick={handlePress}
      className="w-full min-h-touch text-left rounded-2xl touch-feedback transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc"
    >
      <Card className="overflow-hidden">
        <div className="flex">
          {/* Priority color strip */}
          <div className={clsx('w-1.5 flex-shrink-0 rounded-l-2xl', priorityTone)} />

          <div className="flex-1 min-w-0 p-4">
            {/* Top row: title + due time */}
            <div className="flex items-start justify-between gap-2 mb-2">
              <h3 className="text-title font-semibold text-ink-1 leading-tight line-clamp-2">
                {task.title}
              </h3>
              {task.dueTime && (
                <span className="text-meta font-mono text-ink-3 whitespace-nowrap mt-0.5 tabular-nums">
                  {task.dueTime}
                </span>
              )}
            </div>

            {/* Category badge */}
            <div className="flex items-center gap-2 mb-2">
              <span className="text-meta font-semibold text-acc bg-acc-dim px-2 py-0.5 rounded-md">
                {categoryLabel}
              </span>
              {task.status === 'IN_PROGRESS' && (
                <span className="text-meta font-semibold text-warn bg-warn-dim px-2 py-0.5 rounded-md">
                  In Progress
                </span>
              )}
            </div>

            {/* Checklist progress bar */}
            {totalItems > 0 && (
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-surface-2 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-ok rounded-full transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <span className="text-meta font-mono text-ink-3 tabular-nums">
                  {completedItems.length}/{totalItems}
                </span>
              </div>
            )}
          </div>
        </div>
      </Card>
    </button>
  );
}
