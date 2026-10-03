import { clsx } from 'clsx';
import { CalendarOff, AlertCircle } from 'lucide-react';
import { useState, useEffect, useCallback, ChangeEvent, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { LeaveTypeSwatch } from '@/components/LeaveTypeSwatch';
import { QueuedStatusBadge } from '@/components/QueuedStatusBadge';
import {
  Button,
  Card,
  DataState,
  EmptyState,
  Input,
  Spinner,
  Switch,
  Textarea,
} from '@/components/ui';
import { useLeaveTypes, useMyLeaveBalances } from '@/hooks/useLeave';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import type { LeaveType, QueuedPayload } from '@/types';
import { toLoadable } from '@/utils/loadable';

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
  //
  // The leave types are read as a Loadable rather than `data ?? []`: a failed
  // fetch used to render an empty type grid, i.e. "your employer offers no
  // leave", which is the claim src/utils/loadable.ts exists to stop this app
  // making. `data` is now unreachable without the error arm being handled.
  const leaveTypesQuery = useLeaveTypes();
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
      const payload: QueuedPayload<'createLeaveRequest'> = {
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
  // instead of premature "Request Submitted!" green checkmark. The watch tone
  // (amber before v4, `warn` now) says queued-not-confirmed.
  if (showSuccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-warn-dim">
        <QueuedStatusBadge operationId={queuedOperationId} />
      </div>
    );
  }

  return (
    <div>
      <AppHeader title="New Leave Request" onBack={() => navigate(-1)} showAvatar={false} />

      {/* Error Banner */}
      {errors.general && (
        <div className="mx-4 mb-3">
          <Card className="bg-crit-dim border-crit p-3 flex items-center gap-2">
            <AlertCircle size={18} className="text-crit flex-shrink-0" />
            <span className="text-crit text-body">{errors.general}</span>
          </Card>
        </div>
      )}

      {/* Leave Type Selector */}
      <div className="px-4">
        <h3 id="leave-type-heading" className="text-body font-semibold text-ink-3 mb-2 px-1">
          Leave Type
        </h3>
        {/* "Could not load the leave types" and "this tenant offers none" are
            different facts, and an employee about to book time off must not be
            shown the second when the first happened. */}
        <DataState
          value={toLoadable(leaveTypesQuery)}
          label="leave types"
          skeleton="tile"
          skeletonCount={2}
          empty={
            <EmptyState
              icon={<CalendarOff size={22} />}
              title="No leave types"
              description="No leave types are configured for this tenant yet. Ask an administrator to add one."
            />
          }
        >
          {(types) => (
            <div
              role="group"
              aria-labelledby="leave-type-heading"
              className="grid grid-cols-2 gap-2"
            >
              {types.map((type: LeaveType) => (
                <button
                  key={type.id}
                  type="button"
                  aria-pressed={selectedTypeId === type.id}
                  onClick={() => {
                    setSelectedTypeId(type.id);
                    setErrors((prev) => ({ ...prev, leaveType: undefined }));
                  }}
                  className={clsx(
                    'flex flex-col p-3 rounded-2xl border min-h-touch touch-feedback',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
                    selectedTypeId === type.id
                      ? 'border-acc bg-acc-dim'
                      : 'border-line bg-surface-1',
                  )}
                >
                  <div className="flex items-center gap-2">
                    {/* The dot is the TENANT's own colour for this leave type, set in
                        admin — data, not a design token (LeaveTypeSwatch). */}
                    <LeaveTypeSwatch color={type.color} />
                    <span className="text-body font-semibold text-ink-1">{type.name}</span>
                  </div>
                  {type.isPaid && <span className="text-meta text-ok font-medium mt-1">Paid</span>}
                </button>
              ))}
            </div>
          )}
        </DataState>
        {errors.leaveType && <p className="text-crit text-body mt-2">{errors.leaveType}</p>}
      </div>

      {/* Balance Info */}
      {selectedBalance && (
        <div className="mx-4 mt-3">
          <Card className="bg-acc-dim border-acc p-3">
            <p className="text-body text-acc">
              Available:{' '}
              <span className="font-bold font-mono">{selectedBalance.remainingDays}</span> days
              (Used: {selectedBalance.usedDays} / Total: {selectedBalance.totalEntitlement})
            </p>
          </Card>
        </div>
      )}

      {/* Dates — on the Input primitive, which binds each label to its date
          control and renders the per-field validation message under it. */}
      <div className="px-4 mt-4">
        <h3 className="text-body font-semibold text-ink-3 mb-2 px-1">Dates</h3>
        <Input
          type="date"
          label="Start Date"
          value={startDate}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            setStartDate(e.target.value);
            setErrors((prev) => ({ ...prev, startDate: undefined }));
          }}
          error={errors.startDate}
        />
        <Input
          className="mt-4"
          type="date"
          label="End Date"
          value={endDate}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            setEndDate(e.target.value);
            setErrors((prev) => ({ ...prev, endDate: undefined }));
          }}
          error={errors.endDate}
        />
      </div>

      {/* Half Day Toggle — the Switch primitive (role="switch", 44px floor). */}
      <div className="px-4 mt-4">
        <Switch
          label="Half Day"
          checked={isHalfDay}
          onChange={setIsHalfDay}
          className="rounded-2xl border border-line bg-surface-1 p-3"
        />
      </div>

      {/* Total Days */}
      {totalDays > 0 && (
        <div className="mx-4 mt-3">
          <Card className="bg-acc-dim border-acc p-3 text-center">
            <span className="text-display font-mono font-bold text-acc tabular-nums">
              {totalDays}
            </span>
            <span className="text-body text-acc ml-1">day{totalDays !== 1 ? 's' : ''}</span>
          </Card>
        </div>
      )}

      {/* Reason — the Textarea's own label names the control. */}
      <div className="px-4 mt-4">
        <Textarea
          label="Reason (Optional)"
          placeholder="Why are you taking leave?"
          value={reason}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)}
          textareaClassName="h-24 resize-none"
        />
      </div>

      {/* Submit Button — same story as the Half Day toggle: the gap above it
          was Konsta's list margin, so it is now explicit. */}
      <div className="px-4 mt-5">
        <Button
          variant="primary"
          size="save"
          block
          onClick={() => {
            void handleSubmit();
          }}
          disabled={!selectedTypeId || !startDate || !endDate || isSubmitting}
        >
          {isSubmitting ? (
            <>
              <Spinner size="md" color="inherit" />
              Submitting...
            </>
          ) : (
            <>
              <CalendarOff size={20} />
              Submit Leave Request
            </>
          )}
        </Button>
        {!isOnline && (
          <p className="text-center text-warn text-body mt-3 font-medium">
            Offline - will sync when connected
          </p>
        )}
      </div>
    </div>
  );
}
