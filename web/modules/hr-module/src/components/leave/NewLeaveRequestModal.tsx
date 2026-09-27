/**
 * New leave request (FE-MEDIUM-092) — the action behind the leave page's
 * "New Request" control, which rendered with no handler. Employee, leave type
 * and dates are chosen here; the day count comes from the same server
 * calculation the balances use, and the request is created through the
 * existing mutation hook, whose toast reports the outcome.
 */

import React, { useState } from 'react';
import { Button, FormField, Input, Modal, Select, Textarea } from '@aquaculture/shared-ui';

import {
  useCalculateLeaveDays,
  useCreateLeaveRequest,
  useEmployees,
  useLeaveTypes,
} from '../../hooks';
import type { Employee } from '../../types';

const employeeLabel = (employee: Employee): string =>
  `${employee.firstName} ${employee.lastName} (${employee.employeeNumber})`;

const EMPTY = { employeeId: '', leaveTypeId: '', startDate: '', endDate: '', reason: '' };

export interface NewLeaveRequestModalProps {
  open: boolean;
  onClose: () => void;
}

export const NewLeaveRequestModal: React.FC<NewLeaveRequestModalProps> = ({ open, onClose }) => {
  const { data: employees } = useEmployees({}, { limit: 1000 });
  const { data: leaveTypes } = useLeaveTypes({ isActive: true });
  const create = useCreateLeaveRequest();
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const datesValid = Boolean(form.startDate && form.endDate && form.endDate >= form.startDate);
  const days = useCalculateLeaveDays(
    form.leaveTypeId,
    datesValid ? form.startDate : '',
    datesValid ? form.endDate : '',
  );

  const close = (): void => {
    setForm(EMPTY);
    setErrors({});
    onClose();
  };

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!form.employeeId) next.employeeId = 'Choose an employee';
    if (!form.leaveTypeId) next.leaveTypeId = 'Choose a leave type';
    if (!form.startDate) next.startDate = 'Enter the first day';
    if (!form.endDate) next.endDate = 'Enter the last day';
    if (form.startDate && form.endDate && form.endDate < form.startDate)
      next.endDate = 'The last day is before the first day';
    setErrors(next);
    if (Object.keys(next).length > 0 || !days.data) return;
    create.mutate(
      {
        employeeId: form.employeeId,
        leaveTypeId: form.leaveTypeId,
        startDate: form.startDate,
        endDate: form.endDate,
        totalDays: days.data.totalDays,
        reason: form.reason.trim() || undefined,
      },
      { onSuccess: close },
    );
  };

  return (
    <Modal
      isOpen={open}
      onClose={close}
      title="New Leave Request"
      size="md"
      bodyClassName="p-6"
      closeOnEscape={!create.isPending}
      closeOnOverlayClick={!create.isPending}
      footer={
        <>
          <Button variant="ghost" type="button" onClick={close} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="new-leave-request-form"
            loading={create.isPending}
            disabled={datesValid && Boolean(form.leaveTypeId) && (days.isFetching || !days.data)}
          >
            Submit Request
          </Button>
        </>
      }
    >
      <form id="new-leave-request-form" onSubmit={handleSubmit} className="space-y-4">
        <FormField
          label="Employee"
          htmlFor="leave-employee"
          required
          error={form.employeeId ? undefined : errors.employeeId}
          className="mb-0"
        >
          <Select
            id="leave-employee"
            value={form.employeeId}
            onChange={(e) => setForm({ ...form, employeeId: e.target.value })}
            options={[
              { value: '', label: 'Select an employee' },
              ...(employees?.items ?? []).map((employee) => ({
                value: employee.id,
                label: employeeLabel(employee),
              })),
            ]}
          />
        </FormField>
        <FormField
          label="Leave type"
          htmlFor="leave-type"
          required
          error={form.leaveTypeId ? undefined : errors.leaveTypeId}
          className="mb-0"
        >
          <Select
            id="leave-type"
            value={form.leaveTypeId}
            onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value })}
            options={[
              { value: '', label: 'Select a leave type' },
              ...(leaveTypes ?? []).map((type) => ({ value: type.id, label: type.name })),
            ]}
          />
        </FormField>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            label="First day"
            htmlFor="leave-start"
            required
            error={form.startDate ? undefined : errors.startDate}
            className="mb-0"
          >
            <Input
              id="leave-start"
              type="date"
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
            />
          </FormField>
          <FormField
            label="Last day"
            htmlFor="leave-end"
            required
            error={errors.endDate}
            className="mb-0"
          >
            <Input
              id="leave-end"
              type="date"
              value={form.endDate}
              min={form.startDate || undefined}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })}
            />
          </FormField>
        </div>
        {datesValid && form.leaveTypeId && (
          <p className="text-sm text-gray-600 dark:text-gray-400" aria-live="polite">
            {days.data
              ? `${days.data.totalDays} leave day(s) — ${days.data.workingDays} working, ${days.data.weekends} weekend, ${days.data.holidays} holiday`
              : 'Counting the days…'}
          </p>
        )}
        <FormField label="Reason" htmlFor="leave-reason" className="mb-0">
          <Textarea
            id="leave-reason"
            rows={3}
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
          />
        </FormField>
      </form>
    </Modal>
  );
};
