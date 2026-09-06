import { clsx } from 'clsx';
import { ArrowLeft, CheckCircle, Play, Clock, MapPin, Tag, AlertCircle, Send, WifiOff } from 'lucide-react';
import type { JSX } from 'react';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { QueuedStatusBadge } from '@/components/QueuedStatusBadge';
import { GET_TASK_DETAIL } from '@/graphql/operations';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useTaskActions } from '@/hooks/useTaskActions';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { Task, ChecklistItem, TaskNote } from '@/types';


const PRIORITY_LABELS: Record<string, { label: string; color: string }> = {
  URGENT: { label: 'Urgent', color: 'bg-red-100 text-red-700' },
  HIGH: { label: 'High', color: 'bg-orange-100 text-orange-700' },
  MEDIUM: { label: 'Medium', color: 'bg-blue-100 text-blue-700' },
  LOW: { label: 'Low', color: 'bg-gray-100 text-gray-600' },
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
  PENDING: { label: 'Pending', color: 'bg-gray-100 text-gray-600' },
  IN_PROGRESS: { label: 'In Progress', color: 'bg-amber-100 text-amber-700' },
  COMPLETED: { label: 'Completed', color: 'bg-green-100 text-green-700' },
  OVERDUE: { label: 'Overdue', color: 'bg-red-100 text-red-700' },
  CANCELLED: { label: 'Cancelled', color: 'bg-gray-100 text-gray-500' },
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
      const result = await graphqlRequest(
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
  // server confirmed the operation. This prevents overstating completion.
  if (showSuccess) {
    if (wasQueued) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-amber-50 dark:bg-amber-900/10">
          <QueuedStatusBadge operationId={queuedOperationId} />
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-green-50 dark:bg-green-900/10">
        <div className="w-20 h-20 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-4">
          <CheckCircle size={48} className="text-green-600" />
        </div>
        <h2 className="text-xl font-bold text-green-700 dark:text-green-300">{successMessage}</h2>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
        <div className="bg-gradient-to-r from-ocean-600 to-ocean-500 text-white">
          <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
            <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
              <ArrowLeft size={22} />
            </button>
            <h1 className="text-lg font-bold">Task Details</h1>
          </div>
        </div>
        <div className="flex items-center justify-center min-h-[50vh]">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ocean-500" />
        </div>
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
        <div className="bg-gradient-to-r from-ocean-600 to-ocean-500 text-white">
          <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
            <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
              <ArrowLeft size={22} />
            </button>
            <h1 className="text-lg font-bold">Task Details</h1>
          </div>
        </div>
        <div className="px-4 mt-4">
          <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-4 flex items-center gap-3 border border-red-200 dark:border-red-800">
            <AlertCircle size={20} className="text-red-500 flex-shrink-0" />
            <span className="text-red-600 dark:text-red-300 text-sm">{error || 'Task not found'}</span>
          </div>
        </div>
      </div>
    );
  }

  const priorityInfo = PRIORITY_LABELS[task.priority] || PRIORITY_LABELS.MEDIUM;
  const statusInfo = STATUS_LABELS[task.status] || STATUS_LABELS.PENDING;
  const categoryLabel = CATEGORY_LABELS[task.category] || task.category;

  // FARM-HIGH-320: the checklist and notes are typed object lists on the wire,
  // normalised by the server — no client-side repair of a JSON blob any more.
  const checklistItems: ChecklistItem[] = task.checklistItems;
  const notes: TaskNote[] = task.notes;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-r from-ocean-600 to-ocean-500 text-white">
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
            <ArrowLeft size={22} />
          </button>
          <h1 className="text-lg font-bold">Task Details</h1>
        </div>
      </div>

      {/* Task info */}
      <div className="px-4 mt-4">
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card p-5 border border-gray-100 dark:border-gray-800">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-3">{task.title}</h2>

          {/* Badges row */}
          <div className="flex flex-wrap gap-2 mb-4">
            <span className={clsx('px-2.5 py-1 rounded-full text-xs font-semibold', priorityInfo.color)}>
              {priorityInfo.label}
            </span>
            <span className={clsx('px-2.5 py-1 rounded-full text-xs font-semibold', statusInfo.color)}>
              {statusInfo.label}
            </span>
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-ocean-50 text-ocean-700 dark:bg-ocean-900/30">
              {categoryLabel}
            </span>
          </div>

          {task.description && (
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">{task.description}</p>
          )}

          {/* Meta info */}
          <div className="space-y-2">
            {task.dueDate && (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Clock size={14} />
                <span>
                  {new Date(task.dueDate).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })}
                  {task.dueTime && ` - ${task.dueTime}`}
                </span>
              </div>
            )}
            {task.location && (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <MapPin size={14} />
                <span>{task.location}</span>
              </div>
            )}
            {task.estimatedMinutes && (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Clock size={14} />
                <span>Estimated: {task.estimatedMinutes} minutes</span>
              </div>
            )}
            {task.tags && task.tags.length > 0 && (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Tag size={14} />
                <div className="flex flex-wrap gap-1">
                  {task.tags.map((tag, i) => (
                    <span key={i} className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-2 py-0.5 rounded">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Checklist */}
      {checklistItems.length > 0 && (
        <div className="px-4 mt-4">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Checklist ({checklistItems.filter((c) => c.isCompleted).length}/{checklistItems.length})
          </h3>
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 overflow-hidden">
            {checklistItems.map((item, index) => (
              <button
                key={item.id || index}
                onClick={() => { void handleToggleChecklist(item.id, item.isCompleted); }}
                className={clsx(
                  'w-full flex items-center gap-3 p-4 text-left touch-feedback transition-all',
                  index < checklistItems.length - 1 && 'border-b border-gray-50 dark:border-gray-800',
                )}
              >
                <div
                  className={clsx(
                    'w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all',
                    item.isCompleted
                      ? 'bg-green-500 border-green-500'
                      : 'border-gray-300 dark:border-gray-600',
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
                    'text-sm',
                    item.isCompleted
                      ? 'text-gray-400 line-through'
                      : 'text-gray-900 dark:text-white',
                  )}
                >
                  {item.text}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      <div className="px-4 mt-4">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Notes</h3>
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 p-4">
          {notes.length > 0 && (
            <div className="space-y-3 mb-4">
              {notes.map((note, index) => (
                <div key={note.id || index} className="border-b border-gray-50 dark:border-gray-800 pb-3 last:border-0 last:pb-0">
                  <p className="text-sm text-gray-900 dark:text-white">{note.text}</p>
                  <p className="text-xs text-gray-400 mt-1">
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
                'flex-1 border rounded-xl px-3 py-2 text-sm bg-transparent text-gray-900 dark:text-white placeholder-gray-400',
                isOnline
                  ? 'border-gray-200 dark:border-gray-700'
                  : 'border-amber-300 dark:border-amber-700 opacity-60',
              )}
            />
            <button
              onClick={() => { void handleAddNote(); }}
              disabled={!noteText.trim() || !isOnline}
              className="p-2.5 bg-ocean-500 text-white rounded-xl touch-feedback disabled:opacity-50 transition-all"
            >
              <Send size={16} />
            </button>
          </div>
          {/* WHY: Explicit offline indicator for note input so users understand
           * why the field is disabled instead of silently swallowing input. */}
          {!isOnline && (
            <div className="flex items-center gap-1.5 mt-2 text-amber-600 dark:text-amber-400">
              <WifiOff size={12} />
              <span className="text-xs">Notes require network connectivity</span>
            </div>
          )}
        </div>
      </div>

      {/* Action buttons */}
      {task.status !== 'COMPLETED' && task.status !== 'CANCELLED' && (
        <div className="px-4 mt-5 pb-28">
          {task.status === 'PENDING' || task.status === 'OVERDUE' ? (
            <div className="space-y-3">
              <button
                onClick={() => { void handleStartTask(); }}
                disabled={isSubmitting}
                className="w-full py-4 bg-gradient-to-r from-ocean-600 to-ocean-500 text-white font-bold rounded-2xl shadow-lg shadow-ocean-500/25 disabled:opacity-50 touch-feedback transition-all flex items-center justify-center gap-2"
              >
                {isSubmitting ? (
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                ) : (
                  <>
                    <Play size={20} />
                    Start
                  </>
                )}
              </button>
              <button
                onClick={() => { void handleCompleteTask(); }}
                disabled={isSubmitting}
                className="w-full py-4 bg-gradient-to-r from-green-600 to-green-500 text-white font-bold rounded-2xl shadow-lg shadow-green-500/25 disabled:opacity-50 touch-feedback transition-all flex items-center justify-center gap-2"
              >
                {isSubmitting ? (
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                ) : (
                  <>
                    <CheckCircle size={20} />
                    Complete
                  </>
                )}
              </button>
            </div>
          ) : task.status === 'IN_PROGRESS' ? (
            <button
              onClick={() => { void handleCompleteTask(); }}
              disabled={isSubmitting}
              className="w-full py-4 bg-gradient-to-r from-green-600 to-green-500 text-white font-bold rounded-2xl shadow-lg shadow-green-500/25 disabled:opacity-50 touch-feedback transition-all flex items-center justify-center gap-2"
            >
              {isSubmitting ? (
                <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
              ) : (
                <>
                  <CheckCircle size={20} />
                  Complete
                </>
              )}
            </button>
          ) : null}
        </div>
      )}

      {/* Bottom spacer if no actions */}
      {(task.status === 'COMPLETED' || task.status === 'CANCELLED') && <div className="h-24" />}
    </div>
  );
}
