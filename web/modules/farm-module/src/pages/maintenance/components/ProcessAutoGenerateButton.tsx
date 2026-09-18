/**
 * ProcessAutoGenerateButton — Tier 3 #7 (Scope C PR-7)
 *
 * Admin-only "sweep + generate" affordance on `MaintenanceSchedulesPage`.
 * One click triggers the backend's batch generator
 * (`processAutoGenerateWorkOrders`) which scans every ACTIVE schedule
 * with `autoGenerateWorkOrder=true`, finds the ones inside the
 * `generateDaysBefore` window without an existing WO, and produces
 * fresh work orders for each. The output can be empty (nothing due)
 * or fan out into dozens of new rows.
 *
 * Why typed-confirmation
 * ----------------------
 * The blast radius of a single click is non-trivial: each generated
 * WO triggers assignments, alerts, and downstream notifications. A
 * one-click confirm is too easy to fat-finger from the schedule list.
 * `ConfirmModal`'s `requireTypedConfirmation` (Scope C PR-0a) gates
 * the confirm button until the operator literally types the confirmation phrase —
 * the same UX pattern enterprise admin tools use for tenant-level
 * destructive actions.
 *
 * Why hidden (not disabled) for non-admins
 * ----------------------------------------
 * Operators who can never trigger this sweep don't benefit from
 * seeing a greyed-out button. The backend `@Roles(TENANT_ADMIN)` is
 * the authoritative gate; the `useCanMutate` check is the UX
 * complement, not the security boundary.
 */
import React, { useState } from 'react';
import {
  ConfirmModal,
  formatErrorForToast,
  useCanMutate,
  useToast,
} from '@aquaculture/shared-ui';

import { useProcessAutoGenerateWorkOrders } from '../../../hooks/useMaintenance';

const TYPED_CONFIRM_PHRASE = 'CREATE';

const ProcessAutoGenerateButton: React.FC = () => {
  const canRun = useCanMutate('processAutoGenerateWorkOrders');
  const { toast } = useToast();
  const [showConfirm, setShowConfirm] = useState(false);
  const processMutation = useProcessAutoGenerateWorkOrders();

  if (!canRun) {
    return null;
  }

  const handleConfirm = async () => {
    try {
      const created = await processMutation.mutateAsync();
      if (created.length === 0) {
        toast({
          title: 'No new work orders to generate',
          description:
            'All active schedules in the window already have open work orders.',
          variant: 'info',
        });
      } else {
        toast({
          title: 'Auto work orders generated',
          description: `${created.length} new work order(s) queued.`,
          variant: 'success',
        });
      }
      setShowConfirm(false);
    } catch (err) {
      toast({
        title: 'Auto-generation failed',
        description: formatErrorForToast(err),
        variant: 'error',
      });
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setShowConfirm(true)}
        disabled={processMutation.isPending}
        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white rounded-md font-medium"
        title="Auto-generate work orders from active schedules (admin)"
      >
        Auto-generate Work Orders
      </button>

      <ConfirmModal
        className="sd-f2"
        isOpen={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleConfirm}
        title="Auto-generate work orders?"
        message={
          <span>
            This action scans{' '}
            <span className="font-semibold">
              active schedules marked "auto-generate"
            </span>{' '}
            within the window and opens new work orders for the missing ones.
            A single click can result in dozens of work orders; each one
            triggers its own assignment and notification. To continue,{' '}
            <span className="font-mono font-semibold text-purple-700">
              {TYPED_CONFIRM_PHRASE}
            </span>{' '}
            below.
          </span>
        }
        confirmText="Generate"
        cancelText="Cancel"
        variant="warning"
        isLoading={processMutation.isPending}
        requireTypedConfirmation={TYPED_CONFIRM_PHRASE}
      />
    </>
  );
};

export default ProcessAutoGenerateButton;
