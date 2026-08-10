import { ClipboardList } from 'lucide-react';
import type { JSX } from 'react';
import { useState, useCallback } from 'react';

import { AppHeader } from '@/components/AppHeader';
import { TaskCard } from '@/components/cards/TaskCard';
import { EmptyState, SegmentedControl, Skeleton } from '@/components/ui';
import { useMyTasks } from '@/hooks/useMyTasks';

type Segment = 'today' | 'upcoming' | 'overdue';

const SEGMENTS: { value: Segment; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'overdue', label: 'Overdue' },
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
    <div className="pb-32">
      <AppHeader title="My Tasks" showAvatar={false} />

      {/* Segment control */}
      <div className="px-4">
        <SegmentedControl
          label="Task period"
          options={SEGMENTS}
          value={segment}
          onChange={setSegment}
        />
      </div>

      {/* Pull to refresh button */}
      <div className="px-4 pt-3 flex justify-end">
        <button
          type="button"
          onClick={() => {
            void handleRefresh();
          }}
          disabled={isRefreshing}
          className="text-meta text-acc font-medium min-h-touch px-2 touch-feedback disabled:opacity-50"
        >
          {isRefreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Task list */}
      <div className="px-4 pt-1 space-y-3">
        {loading ? (
          <Skeleton variant="tile" count={3} />
        ) : tasks.length === 0 ? (
          <EmptyState
            icon={<ClipboardList size={22} />}
            title={
              segment === 'today'
                ? 'No tasks today'
                : segment === 'upcoming'
                  ? 'No upcoming tasks'
                  : 'No overdue tasks'
            }
          />
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} />)
        )}
      </div>
    </div>
  );
}
