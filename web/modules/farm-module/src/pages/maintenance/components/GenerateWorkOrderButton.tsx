/**
 * GenerateWorkOrderButton
 *
 * Per-row button on MaintenanceSchedulesPage that produces a one-off
 * `WorkOrder` from an active maintenance schedule.
 *
 * Rendering rules:
 *   - Hidden entirely when the user lacks `generateWorkOrderFromSchedule`
 *     permission (MODULE_MANAGER / TENANT_ADMIN per the frontend matrix).
 *     Hiding (vs. disabling) keeps the row UI uncluttered for operators
 *     who could never invoke it; the backend still 403s as a defense-
 *     in-depth check.
 *   - Disabled (with explanatory title) when `schedule.status !== 'ACTIVE'`,
 *     mirroring the backend service's BadRequestException
 *     (apps/farm-service/src/maintenance/services/maintenance-schedule.service.ts:596).
 *
 * Confirm flow uses the shared `ConfirmModal` so the user can cancel
 * before triggering a non-trivial side-effect (a new work order is
 * persisted and feeds into the work-order queue / dashboards).
 *
 * Errors map through `parseGraphQLError` → toast — the service's Turkish
 * messages flow through the `message` fallback path.
 */
import React, { useState } from 'react';
import {
  Button,
  ConfirmModal,
  formatErrorForToast,
  useCanMutate,
  useToast,
} from '@aquaculture/shared-ui';

import {
  MaintenanceSchedule,
  useGenerateWorkOrderFromSchedule,
} from '../../../hooks/useMaintenance';

interface GenerateWorkOrderButtonProps {
  schedule: MaintenanceSchedule;
}

const GenerateWorkOrderButton: React.FC<GenerateWorkOrderButtonProps> = ({
  schedule,
}) => {
  const canGenerate = useCanMutate('generateWorkOrderFromSchedule');
  const { toast } = useToast();
  const [showConfirm, setShowConfirm] = useState(false);
  const generateMutation = useGenerateWorkOrderFromSchedule();

  if (!canGenerate) {
    return null;
  }

  const isActive = schedule.status === 'ACTIVE';
  const blockedReason = !isActive
    ? 'Sadece aktif planlardan iş emri üretilebilir.'
    : undefined;

  const handleConfirm = async () => {
    try {
      const workOrder = await generateMutation.mutateAsync(schedule.id);
      toast({
        title: 'İş emri oluşturuldu',
        description: `${workOrder.workOrderCode} kodu ile iş emri kuyruğa alındı.`,
        variant: 'success',
      });
      setShowConfirm(false);
    } catch (err) {
      toast({
        title: 'İş emri oluşturulamadı',
        description: formatErrorForToast(err),
        variant: 'error',
      });
    }
  };

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setShowConfirm(true)}
        disabled={!isActive || generateMutation.isPending}
        title={blockedReason}
        className="text-blue-600 hover:text-blue-900"
      >
        İş Emri Oluştur
      </Button>

      <ConfirmModal
        isOpen={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleConfirm}
        title="İş emri üretilsin mi?"
        message={
          <span>
            <strong className="font-semibold">{schedule.scheduleCode}</strong>{' '}
            (<span className="font-medium">{schedule.name}</span>) planından
            yeni bir iş emri üretilecek. İş emri{' '}
            <span className="font-semibold">APPROVED</span> durumunda
            açılır ve görevli ekibe atanmaya hazır olur. Mevcut açık iş
            emirleri etkilenmez.
          </span>
        }
        confirmText="İş Emri Oluştur"
        cancelText="İptal"
        variant="info"
        isLoading={generateMutation.isPending}
      />
    </>
  );
};

export default GenerateWorkOrderButton;
