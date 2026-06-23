import { clsx } from 'clsx';
import { CheckSquare, ClipboardList } from 'lucide-react';
import type { JSX } from 'react';
import { useState, useCallback } from 'react';

import { TaskCard } from '@/components/cards/TaskCard';
import { useMyTasks } from '@/hooks/useMyTasks';


type Segment = 'today' | 'upcoming' | 'overdue';

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'overdue', label: 'Overdue' },
];

export function MyTasksPage(): JSX.Element {
  const [segment, setSegment] = useState<Segment>('today');
  const { tasks, loading, refetch } = useMyTasks(segment);

  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refetch();
    setIsRefreshing(false);
  }, [refetch]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-br from-ocean-700 via-ocean-600 to-ocean-500 text-white">
        <div className="px-5 pt-safe-top">
          <div className="flex items-center gap-3 py-4">
            <div className="w-10 h-10 bg-white/15 backdrop-blur-sm rounded-xl flex items-center justify-center">
              <CheckSquare size={22} className="text-white" />
            </div>
            <h1 className="text-lg font-bold tracking-tight">My Tasks</h1>
          </div>
        </div>
        <div className="relative">
          <svg viewBox="0 0 400 20" fill="none" className="w-full block" preserveAspectRatio="none">
            <path d="M0 20V0c100 15 200 15 400 0v20z" className="fill-gray-50 dark:fill-gray-950" />
          </svg>
        </div>
      </div>

      {/* Segment control */}
      <div className="px-5 pt-4">
        <div className="flex bg-white dark:bg-gray-900 rounded-xl p-1 shadow-card border border-gray-100 dark:border-gray-800">
          {SEGMENTS.map((seg) => (
            <button
              key={seg.key}
              onClick={() => setSegment(seg.key)}
              className={clsx(
                'flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all touch-feedback',
                segment === seg.key
                  ? 'bg-ocean-500 text-white shadow-sm'
                  : 'text-gray-500 dark:text-gray-400',
              )}
            >
              {seg.label}
            </button>
          ))}
        </div>
      </div>

      {/* Pull to refresh button */}
      <div className="px-5 pt-3 flex justify-end">
        <button
          onClick={() => { void handleRefresh(); }}
          disabled={isRefreshing}
          className="text-xs text-ocean-500 font-medium touch-feedback"
        >
          {isRefreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Task list */}
      <div className="px-5 pt-3 space-y-3">
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 rounded-2xl skeleton" />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <ClipboardList size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">
              {segment === 'today' && 'No tasks today'}
              {segment === 'upcoming' && 'No upcoming tasks'}
              {segment === 'overdue' && 'No overdue tasks'}
            </p>
          </div>
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} />)
        )}
      </div>

      {/* Bottom spacer for tab bar */}
      <div className="h-24" />
    </div>
  );
}
