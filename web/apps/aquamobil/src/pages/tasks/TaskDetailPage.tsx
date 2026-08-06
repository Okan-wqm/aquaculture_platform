import { clsx } from 'clsx';
import { CheckCircle, Play, Clock, MapPin, Tag, AlertCircle, Send, WifiOff } from 'lucide-react';
import type { JSX } from 'react';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { QueuedStatusBadge } from '@/components/QueuedStatusBadge';
import { Button, Card, EmptyState, IconButton, Skeleton } from '@/components/ui';
import { GET_TASK_DETAIL } from '@/graphql/operations';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useTaskActions } from '@/hooks/useTaskActions';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { Task, ChecklistItem, TaskNote } from '@/types';


/**
 * Priority → badge tone. URGENT and HIGH share the alarm token and MEDIUM takes
 * the watch token — the same mapping the Today screen uses, so one task does not
 * change colour between the list it is read in and the page it is opened on. The
 * badge always renders the priority WORD, so the tiers stay distinguishable.
 */
const PRIORITY_LABELS: Record<string, { label: string; color: string }> = {
  URGENT: { label: 'Urgent', color: 'bg-crit-dim text-crit' },
  HIGH: { label: 'High', color: 'bg-crit-dim text-crit' },
  MEDIUM: { label: 'Medium', color: 'bg-warn-dim text-warn' },
  LOW: { label: 'Low', color: 'bg-surface-2 text-ink-2' },
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

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  PENDING: { label: 'Pending', color: 'bg-surface-2 text-ink-2' },
  IN_PROGRESS: { label: 'In Progress', color: 'bg-warn-dim text-warn' },
  COMPLETED: { label: 'Completed', color: 'bg-surface-2 text-ok' },
  OVERDUE: { label: 'Overdue', color: 'bg-crit-dim text-crit' },
  CANCELLED: { label: 'Cancelled', color: 'bg-surface-2 text-ink-3' },
};

export function TaskDetailPage(): JSX.Element {
  const navigate = useNavigate();
  const { taskId } = useParams<{ taskId: string }>();
  const { completeTask, startTask, setChecklistItem, addNote } = useTaskActions();

  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { isOnline } = useOfflineQueue();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  // WHY: Track queued operation ID separately so we can show honest sync status
  // via QueuedStatusBadge instead of false "Task completed!" when offline.
  const [queuedOperationId, setQueuedOperationId] = useState<string>('');
  const [wasQueued, setWasQueued] = useState(false);

  const fetchTask = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    setError(null);

    try {
      const result = await graphqlRequest<{ task: Task }>(
        GET_TASK_DETAIL,
        { id: taskId },
      );

      setTask(result.task ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load task');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void fetchTask();
  }, [fetchTask]);

  const handleStartTask = async (): Promise<void> => {
    if (!taskId) return;
    setIsSubmitting(true);
    try {
      const result = await startTask(taskId);
      if (result.wasQueued) {
        // WHY: The action was queued offline — show honest "Queued" status
        // instead of definitive "Task started!" which overstates completion.
        setWasQueued(true);
        setQueuedOperationId(result.operationId ?? '');
        setSuccessMessage('Start task queued');
      } else {
        setWasQueued(false);
        setQueuedOperationId('');
        setSuccessMessage('Task started!');
      }
      setShowSuccess(true);
      setTimeout(() => {
        setShowSuccess(false);
        void fetchTask();
      }, result.wasQueued ? 2000 : 1000);
    } catch {
      setError('Failed to start task');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCompleteTask = async (): Promise<void> => {
    if (!taskId) return;
    setIsSubmitting(true);
    try {
      const result = await completeTask(taskId);
      if (result.wasQueued) {
        // WHY: The action was queued offline — show honest "Queued" status
        // instead of definitive "Task completed!" which overstates completion.
        setWasQueued(true);
        setQueuedOperationId(result.operationId ?? '');
        setSuccessMessage('Complete task queued');
      } else {
        setWasQueued(false);
        setQueuedOperationId('');
        setSuccessMessage('Task completed!');
      }
      setShowSuccess(true);
      setTimeout(() => {
        setShowSuccess(false);
        void fetchTask();
      }, result.wasQueued ? 2000 : 1000);
    } catch {
      setError('Failed to complete task');
    } finally {
      setIsSubmitting(false);
    }
  };

  // FARM-HIGH-057: resolve the ABSOLUTE target here — the page knows the item's
  // current state, so a tap on a checked item targets `false` and vice versa. The
  // backend SETs this value (no server-side flip), so the operation is idempotent
  // and safe to queue offline.
  const handleToggleChecklist = async (itemId: string, currentIsCompleted: boolean): Promise<void> => {
    if (!taskId) return;
    try {
      await setChecklistItem(taskId, itemId, !currentIsCompleted);
      await fetchTask();
    } catch {
      // WHY: surface an explicit error instead of silently failing, so users know
      // their action was not recorded.
      setError('Failed to update checklist item');
    }
  };

  const handleAddNote = async (): Promise<void> => {
    if (!taskId || !noteText.trim()) return;
    try {
      await addNote(taskId, noteText.trim());
      setNoteText('');
      await fetchTask();
    } catch {
      // WHY: Notes require network — show explicit error instead of silently failing.
      setError('Adding notes requires network connectivity');
    }
  };

  // WHY: Two-phase success UX — show honest sync status via QueuedStatusBadge
  // when the action was queued offline, and definitive success only when the
  // server confirmed the operation. This prevents overstating completion. The
  // queued screen keeps the WATCH tone; the confirmed one keeps the CONFIRM
  // tone, so the two never look alike.
  if (showSuccess) {
    if (wasQueued) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-warn-dim">
          <QueuedStatusBadge operationId={queuedOperationId} />
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <div className="w-20 h-20 bg-surface-2 rounded-full flex items-center justify-center mb-4">
          <CheckCircle size={48} className="text-ok" />
        </div>
        <h2 className="text-head font-bold text-ok">{successMessage}</h2>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="pb-32">
        <AppHeader title="Task Details" onBack={() => navigate(-1)} showAvatar={false} />
        <div className="px-4">
          <Skeleton variant="tile" count={3} />
        </div>
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="pb-32">
        <AppHeader title="Task Details" onBack={() => navigate(-1)} showAvatar={false} />
        <EmptyState tone="error" icon={<AlertCircle size={22} />} title={error || 'Task not found'} />
      </div>
    );
  }

  const priorityInfo = PRIORITY_LABELS[task.priority] || PRIORITY_LABELS.MEDIUM;
  const statusInfo = STATUS_LABELS[task.status] || STATUS_LABELS.PENDING;
  const categoryLabel = CATEGORY_LABELS[task.category] || task.category;

  const checklistItems: ChecklistItem[] = Array.isArray(task.checklistItems)
    ? task.checklistItems.map((item) =>
        typeof item === 'object' && item !== null
          ? (item)
          : { id: String(item), text: String(item), isCompleted: false },
      )
    : [];

  const notes: TaskNote[] = Array.isArray(task.notes)
    ? task.notes.map((note) =>
        typeof note === 'object' && note !== null
          ? (note)
          : { id: String(note), text: String(note), createdBy: '', createdAt: '' },
      )
    : [];

  return (
    <div className="pb-32">
      <AppHeader title="Task Details" onBack={() => navigate(-1)} showAvatar={false} />

      <div className="px-4 flex flex-col gap-4">
        {/* Task info */}
        <Card className="p-5">
          <h2 className="text-head font-bold text-ink-1 mb-3">{task.title}</h2>

          {/* Badges row */}
          <div className="flex flex-wrap gap-2 mb-4">
            <span
              className={clsx(
                'px-2.5 py-1 rounded-full text-meta font-semibold',
                priorityInfo.color,
              )}
            >
              {priorityInfo.label}
            </span>
            <span
              className={clsx('px-2.5 py-1 rounded-full text-meta font-semibold', statusInfo.color)}
            >
              {statusInfo.label}
            </span>
            <span className="px-2.5 py-1 rounded-full text-meta font-semibold bg-acc-dim text-acc">
              {categoryLabel}
            </span>
          </div>

          {task.description && <p className="text-body text-ink-2 mb-4">{task.description}</p>}

          {/* Meta info */}
          <div className="space-y-2">
            {task.dueDate && (
              <div className="flex items-center gap-2 text-body text-ink-3">
                <Clock size={14} />
                <span>
                  {new Date(task.dueDate).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })}
                  {task.dueTime && ` - ${task.dueTime}`}
                </span>
              </div>
            )}
            {task.location && (
              <div className="flex items-center gap-2 text-body text-ink-3">
                <MapPin size={14} />
                <span>{task.location}</span>
              </div>
            )}
            {task.estimatedMinutes && (
              <div className="flex items-center gap-2 text-body text-ink-3">
                <Clock size={14} />
                <span>Estimated: {task.estimatedMinutes} minutes</span>
              </div>
            )}
            {task.tags && task.tags.length > 0 && (
              <div className="flex items-center gap-2 text-body text-ink-3">
                <Tag size={14} />
                <div className="flex flex-wrap gap-1">
                  {task.tags.map((tag, i) => (
                    <span
                      key={i}
                      className="text-meta bg-surface-2 text-ink-2 px-2 py-0.5 rounded"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* Checklist */}
        {checklistItems.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-body font-semibold text-ink-3 px-1">
              Checklist ({checklistItems.filter((c) => c.isCompleted).length}/{checklistItems.length})
            </h3>
            <Card className="overflow-hidden">
              {checklistItems.map((item, index) => (
                <button
                  key={item.id || index}
                  type="button"
                  onClick={() => {
                    void handleToggleChecklist(item.id, item.isCompleted);
                  }}
                  aria-pressed={item.isCompleted}
                  className={clsx(
                    'w-full min-h-touch flex items-center gap-3 p-4 text-left touch-feedback',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
                    index < checklistItems.length - 1 && 'border-b border-line',
                  )}
                >
                  <div
                    className={clsx(
                      'w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all',
                      item.isCompleted ? 'bg-ok border-ok' : 'border-line-strong',
                    )}
                  >
                    {item.isCompleted && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </div>
                  <span
                    className={clsx(
                      'text-body',
                      item.isCompleted ? 'text-ink-3 line-through' : 'text-ink-1',
                    )}
                  >
                    {item.text}
                  </span>
                </button>
              ))}
            </Card>
          </section>
        )}

        {/* Notes */}
        <section className="flex flex-col gap-2">
          <h3 className="text-body font-semibold text-ink-3 px-1">Notes</h3>
          <Card className="p-4">
            {notes.length > 0 && (
              <div className="space-y-3 mb-4">
                {notes.map((note, index) => (
                  <div
                    key={note.id || index}
                    className="border-b border-line pb-3 last:border-0 last:pb-0"
                  >
                    <p className="text-body text-ink-1">{note.text}</p>
                    <p className="text-meta text-ink-3 mt-1">
                      {note.createdBy && `${note.createdBy} - `}
                      {note.createdAt && new Date(note.createdAt).toLocaleString('en-US')}
                    </p>
                  </div>
                ))}
              </div>
            )}
            {/* Add note form */}
            <div className="flex gap-2">
              <input
                type="text"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder={isOnline ? 'Add a note...' : 'Notes require network...'}
                disabled={!isOnline}
                className={clsx(
                  'flex-1 min-h-touch border rounded-xl px-3 py-2 text-body bg-transparent text-ink-1 placeholder:text-ink-3',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
                  isOnline ? 'border-line' : 'border-warn opacity-60',
                )}
              />
              <IconButton
                aria-label="Add note"
                onClick={() => {
                  void handleAddNote();
                }}
                disabled={!noteText.trim() || !isOnline}
                className="bg-acc text-acc-on rounded-xl"
              >
                <Send size={16} />
              </IconButton>
            </div>
            {/* WHY: Explicit offline indicator for note input so users understand
             * why the field is disabled instead of silently swallowing input. */}
            {!isOnline && (
              <div className="flex items-center gap-1.5 mt-2 text-warn">
                <WifiOff size={12} />
                <span className="text-meta">Notes require network connectivity</span>
              </div>
            )}
          </Card>
        </section>

        {/* Action buttons */}
        {task.status !== 'COMPLETED' && task.status !== 'CANCELLED' && (
          <>
            {task.status === 'PENDING' || task.status === 'OVERDUE' ? (
              // Complete carries the accent and Start does not: v4 spends the
              // teal on ONE action per screen, and finishing the task is the one
              // the worker is here to reach.
              <div className="flex flex-col gap-3">
                <Button
                  variant="secondary"
                  size="save"
                  block
                  onClick={() => {
                    void handleStartTask();
                  }}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <span className="animate-spin rounded-full h-5 w-5 border-2 border-current border-t-transparent" />
                  ) : (
                    <>
                      <Play size={20} />
                      Start
                    </>
                  )}
                </Button>
                <Button
                  variant="primary"
                  size="save"
                  block
                  onClick={() => {
                    void handleCompleteTask();
                  }}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <span className="animate-spin rounded-full h-5 w-5 border-2 border-current border-t-transparent" />
                  ) : (
                    <>
                      <CheckCircle size={20} />
                      Complete
                    </>
                  )}
                </Button>
              </div>
            ) : task.status === 'IN_PROGRESS' ? (
              <Button
                variant="primary"
                size="save"
                block
                onClick={() => {
                  void handleCompleteTask();
                }}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-current border-t-transparent" />
                ) : (
                  <>
                    <CheckCircle size={20} />
                    Complete
                  </>
                )}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
