/**
 * Bind (or replace) a sensor channel as a source of a parameter at a point.
 *
 * Sensor → channel → the bind's own rule as a dry run (checkParameterChannelBinding,
 * debounced) → its problems → Bind. The channel list puts the channels that
 * measure the parameter's quantity first; the others stay visible, greyed,
 * with the reason they would be refused. The dry run is the authority — a
 * channel the list shows as fitting can still be refused (it is not at the
 * point, say) — and Bind stays disabled until it passes. A refused write
 * shows its stable code and problems; when the sensor service cannot answer
 * nothing was decided, and the dialog says so with a retry.
 */
import {
  bindingRefusal,
  Button,
  errorText,
  Modal,
  ProblemChips,
  quantityLabel,
  Select,
  useI18n,
  type BindingRefusal,
  type PointRef,
} from '@aquaculture/shared-ui';
import type {
  ChannelSourcePriority,
  MeasurementPosition,
} from '@platform/shared-ui/generated/graphql-types';
import React, { useEffect, useMemo, useState } from 'react';

import type { SensorChannelOption } from '../../../../graphql/parameterSources.operations';
import {
  useBindParameterChannel,
  useChannelBindingCheck,
  useReplaceParameterChannel,
  useSensorChannels,
  type ChannelBindingTarget,
} from '../../../../hooks/useParameterSources';
import { useSensors } from '../../../../hooks/useSensors';

/** How long the dialog waits after the last pick before asking for the dry run. */
export const DRY_RUN_DEBOUNCE_MS = 300;

export interface BindChannelDialogProps {
  parameter: { id: string; name: string; unit: string; quantity: string | null };
  point: PointRef;
  position: MeasurementPosition;
  /** A new source at this priority, or a replacement of the channel of an existing one. */
  mode:
    | { kind: 'bind'; priority: ChannelSourcePriority }
    | { kind: 'replace'; sourceId: string; priority: ChannelSourcePriority };
  /** Narrows the sensor list to the point's site when it is known. */
  siteId: string | null;
  onClose: () => void;
  onDone: () => void;
}

/** Why a channel would not fit, as far as its own description says (the dry run decides). */
function channelMismatch(
  channel: SensorChannelOption,
  quantity: string | null,
): 'CHANNEL_DISABLED' | 'CHANNEL_HAS_NO_QUANTITY' | 'QUANTITY_MISMATCH' | null {
  if (!channel.isEnabled) return 'CHANNEL_DISABLED';
  if (channel.quantity === null) return 'CHANNEL_HAS_NO_QUANTITY';
  if (quantity !== null && channel.quantity !== quantity) return 'QUANTITY_MISMATCH';
  return null;
}

/** Holds a value back until it has not changed for `delayMs`. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export const BindChannelDialog: React.FC<BindChannelDialogProps> = ({
  parameter,
  point,
  position,
  mode,
  siteId,
  onClose,
  onDone,
}) => {
  const { t } = useI18n();
  const [sensorId, setSensorId] = useState<string | null>(null);
  const [channelKey, setChannelKey] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<BindingRefusal | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  const { sensors, isLoading: sensorsLoading } = useSensors(siteId === null ? {} : { siteId });
  const channels = useSensorChannels(sensorId);
  const bind = useBindParameterChannel();
  const replace = useReplaceParameterChannel();

  // Keyed on the point's kind and id, not its object: a parent that renders a
  // new point object must not restart the dry run.
  const pointKind = point.kind;
  const pointId = point.id;
  const target = useMemo((): ChannelBindingTarget | null => {
    if (sensorId === null || channelKey === null) return null;
    return {
      parameterConfigId: parameter.id,
      point: { kind: pointKind, id: pointId },
      position,
      sensorId,
      channelKey,
      priority: mode.priority,
    };
  }, [parameter.id, pointKind, pointId, position, sensorId, channelKey, mode.priority]);
  const settledTarget = useDebounced(target, DRY_RUN_DEBOUNCE_MS);
  const check = useChannelBindingCheck(settledTarget);
  const settling = target !== settledTarget;

  const channelOptions = useMemo(() => {
    const listed = (channels.data ?? []).map((channel) => ({
      channel,
      mismatch: channelMismatch(channel, parameter.quantity),
    }));
    // The channels that measure the parameter's quantity first.
    return [
      ...listed.filter((entry) => entry.mismatch === null),
      ...listed.filter((entry) => entry.mismatch !== null),
    ].map(({ channel, mismatch }) => ({
      value: channel.channelKey,
      label:
        `${channel.displayLabel} (${channel.channelKey})` +
        (channel.quantity === null ? '' : ` — ${quantityLabel(channel.quantity)}`) +
        (mismatch === null ? '' : ` · ${t(`wqSource.problem.${mismatch}`)}`),
      disabled: mismatch !== null,
    }));
  }, [channels.data, parameter.quantity, t]);

  const checkRefusal = check.error === null ? null : bindingRefusal(check.error);
  const problems = check.data?.problems ?? [];
  const busy = bind.isPending || replace.isPending;
  const canSubmit =
    target !== null && !settling && check.isSuccess && problems.length === 0 && !busy;

  const submit = async (): Promise<void> => {
    if (target === null) return;
    setRefusal(null);
    setWriteError(null);
    try {
      if (mode.kind === 'bind') {
        await bind.mutateAsync(target);
      } else {
        await replace.mutateAsync({
          sourceId: mode.sourceId,
          sensorId: target.sensorId,
          channelKey: target.channelKey,
        });
      }
      onDone();
    } catch (error) {
      const refused = bindingRefusal(error);
      setRefusal(refused);
      setWriteError(refused === null && error instanceof Error ? error.message : null);
    }
  };

  const title =
    mode.kind === 'replace'
      ? t('wqSource.ui.replaceTitle', { name: parameter.name })
      : mode.priority === 'BACKUP'
        ? t('wqSource.ui.backupTitle', { name: parameter.name })
        : t('wqSource.ui.bindTitle', { name: parameter.name });

  return (
    <Modal isOpen onClose={onClose} title={title} size="md">
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {parameter.quantity === null
            ? t('wqSource.ui.recordsNone')
            : t('wqSource.ui.records', {
                quantity: quantityLabel(parameter.quantity),
                unit: parameter.unit,
              })}
        </p>
        <Select
          label={t('wqSource.ui.sensor')}
          value={sensorId ?? ''}
          disabled={sensorsLoading}
          onChange={(event) => {
            setSensorId(event.target.value === '' ? null : event.target.value);
            setChannelKey(null);
            setRefusal(null);
          }}
          options={[
            {
              value: '',
              label:
                sensors.length === 0
                  ? t('wqSource.ui.noSensorAtSite')
                  : t('wqSource.ui.chooseSensor'),
            },
            ...sensors.map((sensor) => ({ value: sensor.id, label: sensor.name })),
          ]}
        />
        <Select
          label={t('wqSource.ui.channel')}
          value={channelKey ?? ''}
          disabled={sensorId === null || channels.isLoading}
          onChange={(event) => {
            setChannelKey(event.target.value === '' ? null : event.target.value);
            setRefusal(null);
          }}
          options={[{ value: '', label: t('wqSource.ui.chooseChannel') }, ...channelOptions]}
        />

        <div aria-live="polite" className="min-h-[2rem] text-sm">
          {target !== null && (settling || check.isFetching) && (
            <span className="text-gray-500 dark:text-gray-400">{t('wqSource.ui.checking')}</span>
          )}
          {target !== null && !settling && check.isSuccess && problems.length === 0 && (
            <span className="text-success-700 dark:text-success-300">
              {t('wqSource.ui.channelFits')}
            </span>
          )}
          {!settling && problems.length > 0 && <ProblemChips problems={problems} />}
          {!settling && check.error !== null && (
            <div className="flex items-center gap-2 text-error-700 dark:text-error-300">
              <span>
                {checkRefusal === null ? check.error.message : errorText(t, checkRefusal.code)}
              </span>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                onClick={() => void check.refetch()}
              >
                {t('common.retry')}
              </Button>
            </div>
          )}
        </div>

        {refusal !== null && (
          <div
            role="alert"
            className="rounded-lg border border-error-200 bg-error-50 p-3 text-sm text-error-800 dark:border-error-800 dark:bg-error-900/20 dark:text-error-200"
          >
            <p>{errorText(t, refusal.code)}</p>
            {refusal.problems.length > 0 && (
              <ProblemChips problems={refusal.problems} className="mt-2" />
            )}
          </div>
        )}
        {writeError !== null && (
          <p role="alert" className="text-sm text-error-700 dark:text-error-300">
            {writeError}
          </p>
        )}

        <div className="flex justify-end gap-3 border-t pt-4">
          <Button variant="secondary" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {busy
              ? t('common.loading')
              : mode.kind === 'replace'
                ? t('wqSource.ui.replace')
                : t('wqSource.ui.bind')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
