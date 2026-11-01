/**
 * The device page's move dialog: pick where the device is installed now and
 * save it through `relocateSensor`. Farm refuses a path that is not live or
 * does not hang together; the refusal is worded in the user's language by its
 * code (SENSOR_PLACEMENT_ERROR). The page mounts the dialog only while it is
 * open, so each opening starts from `current`.
 */
import { isSensorPlacementErrorCode } from '@aquaculture/shared-contracts';
import { Button, GraphQLClientError, Modal, useI18n, useToast } from '@aquaculture/shared-ui';
import React, { useState } from 'react';

import { type RelocatedSensor, useRelocateSensor } from '../../hooks/useRelocateSensor';

import { type DeviceLocation, DeviceLocationFields } from './DeviceLocationFields';

export interface RelocateSensorDialogProps {
  sensorId: string;
  current: DeviceLocation;
  isParentDevice: boolean;
  onClose: () => void;
  onMoved: (sensor: RelocatedSensor) => void;
}

export function RelocateSensorDialog({
  sensorId,
  current,
  isParentDevice,
  onClose,
  onMoved,
}: RelocateSensorDialogProps): React.ReactElement {
  const { t } = useI18n();
  const { toast } = useToast();
  const relocate = useRelocateSensor();
  const [location, setLocation] = useState<DeviceLocation>(current);
  const saving = relocate.isPending;

  const ready = Boolean(location.siteId && location.departmentId);

  const refusal = (error: unknown): string | undefined => {
    if (error instanceof GraphQLClientError && isSensorPlacementErrorCode(error.code)) {
      return t(`sensor.location.error.${error.code}`);
    }
    return error instanceof Error ? error.message : undefined;
  };

  const save = async (): Promise<void> => {
    if (!location.siteId || saving) return;
    try {
      const moved = await relocate.mutateAsync({
        sensorId,
        siteId: location.siteId,
        departmentId: location.departmentId ?? null,
        systemId: location.systemId ?? null,
        unitId: location.unitId ?? null,
      });
      toast({ title: t('sensor.location.saved'), variant: 'success' });
      onMoved(moved);
      onClose();
    } catch (error) {
      toast({
        title: t('sensor.location.saveFailed'),
        description: refusal(error),
        variant: 'error',
      });
    }
  };

  const help = isParentDevice
    ? `${t('sensor.location.dialogHelp')} ${t('sensor.location.childrenMove')}`
    : t('sensor.location.dialogHelp');

  // While the move is being saved the dialog stays open: its outcome is
  // reported here, and closing would hide it.
  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title={t('sensor.location.dialogTitle')}
      description={help}
      closeOnEscape={!saving}
      closeOnOverlayClick={!saving}
      showCloseButton={!saving}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={!ready} loading={saving}>
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <DeviceLocationFields value={location} onChange={setLocation} disabled={saving} />
    </Modal>
  );
}
