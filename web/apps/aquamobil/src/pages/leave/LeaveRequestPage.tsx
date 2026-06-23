import { clsx } from 'clsx';
import { List, ListInput, BlockTitle } from 'konsta/react';
import { ArrowLeft, CalendarOff, AlertCircle } from 'lucide-react';
import { useState, useEffect, useCallback, ChangeEvent, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { QueuedStatusBadge } from '@/components/QueuedStatusBadge';
import { useLeaveTypes, useMyLeaveBalances } from '@/hooks/useLeave';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import type { LeaveType, CreateLeaveRequestInput } from '@/types';


interface FormErrors {
  leaveType?: string;
  startDate?: string;
  endDate?: string;
  general?: string;
}

export function LeaveRequestPage(): JSX.Element {
  const navigate = useNavigate();
  const { addToQueue, isOnline } = useOfflineQueue();
  // WHY no imperative fetch calls: React Query auto-fetches on mount when
  // enabled conditions are met, and the data is shared/deduplicated across
  // components that use the same queryKey.
  const { data: leaveTypes = [] } = useLeaveTypes();
  const { data: balances = [] } = useMyLeaveBalances(new Date().getFullYear());

  const [selectedTypeId, setSelectedTypeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isHalfDay, setIsHalfDay] = useState(false);
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  // C7: Track the operationId for two-phase success UX
  const [queuedOperationId, setQueuedOperationId] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});

  // Set default start date to tomorrow
  useEffect(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setStartDate(tomorrow.toISOString().split('T')[0]);
    setEndDate(tomorrow.toISOString().split('T')[0]);
  }, []);

  const selectedBalance = balances.find((b) => b.leaveTypeId === selectedTypeId);

  const calculateDays = useCallback((): number => {
    if (!startDate || !endDate) return 0;
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diff = Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1;
    return isHalfDay ? 0.5 : Math.max(0, diff);
  }, [startDate, endDate, isHalfDay]);

  const totalDays = calculateDays();

  const validateForm = useCallback((): boolean => {
    const newErrors: FormErrors = {};
    if (!selectedTypeId) newErrors.leaveType = 'Please select a leave type';
    if (!startDate) newErrors.startDate = 'Start date is required';
    if (!endDate) newErrors.endDate = 'End date is required';
    if (startDate && endDate && new Date(endDate) < new Date(startDate)) {
      newErrors.endDate = 'End date must be after start date';
    }
    if (selectedBalance && totalDays > selectedBalance.remainingDays) {
      newErrors.general = `Insufficient balance. You have ${selectedBalance.remainingDays} days remaining.`;
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [selectedTypeId, startDate, endDate, selectedBalance, totalDays]);

  const handleSubmit = async (): Promise<void> => {
    if (!validateForm()) return;
    setIsSubmitting(true);
    setErrors({});

    try {
      // WHY: Build a payload that matches the backend CreateLeaveRequestInput
      // DTO exactly. The old code sent { isHalfDay } which the backend does not
      // recognize — the backend uses isHalfDayStart/isHalfDayEnd/halfDayPeriod.
      const payload: CreateLeaveRequestInput = {
        leaveTypeId: selectedTypeId,
        startDate,
        endDate,
        totalDays,
        isHalfDayStart: isHalfDay,
        isHalfDayEnd: false,
        reason: reason.trim() || undefined,
      };

      // WHY: ONE authoritative submit path. The queue is the single write path
      // for both online and offline. The sync engine in useOfflineQueue
      // transparently chains createLeaveRequest + submitLeaveRequest mutations,
      // so we do NOT call submitLeaveRequest separately here. This eliminates
      // the old broken setTimeout chain that passed the queue UUID (not the
      // domain leave-request ID) to submitLeaveRequest.
      // FE-HIGH-050: addToQueue returns a discriminated result; .id tracks the
      // queued (or, on dedup, existing) op for QueuedStatusBadge.
      const { id: queueId } = await addToQueue('createLeaveRequest', payload);

      // C7: Store operationId for QueuedStatusBadge tracking
      setQueuedOperationId(queueId);

      setShowSuccess(true);
      setTimeout(() => navigate('/leave'), 2000);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create leave request';
      setErrors({ general: message });
    } finally {
      setIsSubmitting(false);
    }
  };

  // C7: Two-phase success UX -- show honest sync status via QueuedStatusBadge
  // instead of premature "Request Submitted!" green checkmark.
  if (showSuccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-amber-50 dark:bg-amber-900/10">
        <QueuedStatusBadge operationId={queuedOperationId} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 pb-24">
      {/* Header */}
      <div className="bg-gradient-to-r from-violet-600 to-violet-500 text-white">
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
            <ArrowLeft size={22} />
          </button>
          <div className="flex items-center gap-2.5">
            <CalendarOff size={22} />
            <h1 className="text-lg font-bold">New Leave Request</h1>
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {errors.general && (
        <div className="mx-4 mt-3 bg-red-50 dark:bg-red-900/20 rounded-xl p-3 flex items-center gap-2 border border-red-200 dark:border-red-800">
          <AlertCircle size={18} className="text-red-500 flex-shrink-0" />
          <span className="text-red-600 dark:text-red-300 text-sm">{errors.general}</span>
        </div>
      )}

      {/* Leave Type Selector */}
      <div className="px-4 mt-5">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Leave Type</h3>
        <div className="grid grid-cols-2 gap-2">
          {leaveTypes.map((type: LeaveType) => (
            <button
              key={type.id}
              onClick={() => {
                setSelectedTypeId(type.id);
                setErrors((prev) => ({ ...prev, leaveType: undefined }));
              }}
              className={clsx(
                'flex flex-col p-3 rounded-2xl border-2 transition-all touch-feedback bg-white dark:bg-gray-900',
                selectedTypeId === type.id
                  ? 'border-violet-500 bg-violet-50 dark:bg-violet-900/20'
                  : 'border-gray-100 dark:border-gray-800',
              )}
            >
              <div className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: type.color || '#6366f1' }}
                />
                <span className="text-sm font-semibold text-gray-900 dark:text-white">{type.name}</span>
              </div>
              {type.isPaid && <span className="text-[10px] text-green-600 font-medium mt-1">Paid</span>}
            </button>
          ))}
        </div>
        {errors.leaveType && <p className="text-red-500 text-sm mt-2">{errors.leaveType}</p>}
      </div>

      {/* Balance Info */}
      {selectedBalance && (
        <div className="mx-4 mt-3 bg-violet-50 dark:bg-violet-900/20 rounded-xl p-3 border border-violet-200 dark:border-violet-800">
          <p className="text-sm text-violet-700 dark:text-violet-300">
            Available: <span className="font-bold">{selectedBalance.remainingDays}</span> days
            (Used: {selectedBalance.usedDays} / Total: {selectedBalance.totalEntitlement})
          </p>
        </div>
      )}

      {/* Dates */}
      <BlockTitle>Dates</BlockTitle>
      <List strongIos insetIos>
        <ListInput
          type="date"
          label="Start Date"
          value={startDate}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            setStartDate(e.target.value);
            setErrors((prev) => ({ ...prev, startDate: undefined }));
          }}
          error={errors.startDate}
        />
        <ListInput
          type="date"
          label="End Date"
          value={endDate}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            setEndDate(e.target.value);
            setErrors((prev) => ({ ...prev, endDate: undefined }));
          }}
          error={errors.endDate}
        />
      </List>

      {/* Half Day Toggle */}
      <div className="px-4">
        <label className="flex items-center gap-3 bg-white dark:bg-gray-900 rounded-xl p-3 border border-gray-100 dark:border-gray-800">
          <input
            type="checkbox"
            checked={isHalfDay}
            onChange={(e) => setIsHalfDay(e.target.checked)}
            className="w-5 h-5 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
          />
          <span className="text-sm font-medium text-gray-900 dark:text-white">Half Day</span>
        </label>
      </div>

      {/* Total Days */}
      {totalDays > 0 && (
        <div className="mx-4 mt-3 bg-ocean-50 dark:bg-ocean-900/20 rounded-xl p-3 text-center">
          <span className="text-2xl font-bold text-ocean-600">{totalDays}</span>
          <span className="text-sm text-ocean-600 ml-1">day{totalDays !== 1 ? 's' : ''}</span>
        </div>
      )}

      {/* Reason */}
      <BlockTitle>Reason (Optional)</BlockTitle>
      <List strongIos insetIos>
        <ListInput
          type="textarea"
          placeholder="Why are you taking leave?"
          value={reason}
          onInput={(e: ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)}
          inputClassName="!h-24"
        />
      </List>

      {/* Submit Button */}
      <div className="px-4 pb-28">
        <button
          onClick={() => { void handleSubmit(); }}
          disabled={!selectedTypeId || !startDate || !endDate || isSubmitting}
          className="w-full py-4 bg-gradient-to-r from-violet-600 to-violet-500 text-white font-bold rounded-2xl shadow-lg shadow-violet-500/25 disabled:opacity-50 disabled:cursor-not-allowed touch-feedback transition-all flex items-center justify-center gap-2"
        >
          {isSubmitting ? (
            <>
              <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
              Submitting...
            </>
          ) : (
            <>
              <CalendarOff size={20} />
              Submit Leave Request
            </>
          )}
        </button>
        {!isOnline && (
          <p className="text-center text-amber-500 text-sm mt-3 font-medium">
            Offline - will sync when connected
          </p>
        )}
      </div>
    </div>
  );
}
