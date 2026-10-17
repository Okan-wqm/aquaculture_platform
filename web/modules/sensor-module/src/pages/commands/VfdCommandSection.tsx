/**
 * Drive commands — one drive's immutable runtime command trail.
 *
 * Reads: `vfdDevices` (the picker; the first drive until the operator picks
 * one) and `vfdCommandAuditLog(drive, 100)`. The query takes a limit and no
 * offset, so the section says it shows the drive's latest 100. Each row is
 * who asked (the recorded e-mail, else the actor id or system origin token),
 * what and with which value, from where, and what the drive replied: accepted
 * with its round-trip latency, or failed with the drive's error. A failed
 * command carries the amber flag bar; success is not coloured.
 */
import React, { useState } from 'react';
import { DataTable, type DataTableColumn, Select, useI18n } from '@aquaculture/shared-ui';

import {
  useVfdCommandAuditLog,
  VFD_COMMAND_LOG_LIMIT,
  type VfdCommandAuditEntry,
} from '../../hooks/useVfdCommandAuditLog';
import { useVfdDevices } from '../../hooks/useVfdRegistration';
import type { VfdDevice } from '../../types/vfd.types';
import { CommandSection } from './CommandSection';
import { COMMAND_SOURCE_KEYS, VFD_COMMAND_KEYS, VFD_VALUE_KEYS } from './commandLabels';
import { formatCommandNumber, formatCommandTime } from './commandFormat';
import { FAILED_ROW, ReplyFailed } from './ReplyCells';
import { SectionBody } from './SectionBody';

/** The drive picker lists up to this many drives (vfdDevices pagination). */
const DRIVE_PAGE = { page: 1, limit: 100 } as const;

function driveLabel(device: Pick<VfdDevice, 'name' | 'model'>): string {
  return device.model ? `${device.name} · ${device.model}` : device.name;
}

export function VfdCommandSection(): React.JSX.Element {
  const { t, locale } = useI18n();
  const devices = useVfdDevices(undefined, DRIVE_PAGE);
  const drives = devices.data?.items ?? [];
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  // The first drive until one is picked; a picked drive that left the list falls back the same way.
  const driveId = drives.some((drive) => drive.id === chosen) ? chosen : drives[0]?.id;
  const log = useVfdCommandAuditLog(driveId);

  const columns: DataTableColumn<VfdCommandAuditEntry>[] = [
    {
      key: 'timestamp',
      header: t('sensorCommands.col.time'),
      width: '150px',
      render: (_value, row) => (
        <time dateTime={row.timestamp} className="whitespace-nowrap tabular-nums">
          {formatCommandTime(row.timestamp, locale)}
        </time>
      ),
    },
    {
      key: 'command',
      header: t('sensorCommands.col.command'),
      render: (_value, row) => (
        <span className="font-semibold">{t(VFD_COMMAND_KEYS[row.command])}</span>
      ),
    },
    {
      key: 'value',
      header: t('sensorCommands.col.value'),
      align: 'right',
      render: (_value, row) => {
        if (row.value === null || row.value === undefined) return '—';
        const unitKey = VFD_VALUE_KEYS[row.command];
        const value = formatCommandNumber(row.value, locale);
        return (
          <span className="whitespace-nowrap tabular-nums">
            {unitKey === undefined ? value : t(unitKey, { value })}
          </span>
        );
      },
    },
    {
      key: 'performedBy',
      header: t('sensorCommands.col.requestedBy'),
      render: (_value, row) => row.performedByEmail ?? row.performedBy,
    },
    {
      key: 'source',
      header: t('sensorCommands.col.source'),
      render: (_value, row) => {
        const sourceKey = COMMAND_SOURCE_KEYS[row.source];
        return sourceKey === undefined ? row.source : t(sourceKey);
      },
    },
    {
      key: 'reply',
      header: t('sensorCommands.col.reply'),
      minWidth: '200px',
      render: (_value, row) => {
        if (!row.success) return <ReplyFailed error={row.error ?? null} />;
        return row.latencyMs === null || row.latencyMs === undefined
          ? t('sensorCommands.reply.accepted')
          : t('sensorCommands.reply.acceptedIn', { ms: row.latencyMs });
      },
    },
  ];

  const picker =
    drives.length > 0 ? (
      <Select
        label={t('sensorCommands.vfd.drive')}
        size="sm"
        value={driveId}
        options={drives.map((drive) => ({ value: drive.id, label: driveLabel(drive) }))}
        onChange={(event) => setChosen(event.target.value)}
      />
    ) : undefined;

  return (
    <CommandSection
      title={t('sensorCommands.vfd.title')}
      description={t('sensorCommands.vfd.description', { limit: VFD_COMMAND_LOG_LIMIT })}
      actions={picker}
    >
      <SectionBody
        isLoading={devices.isLoading}
        isError={devices.isError}
        errorTitle={t('sensorCommands.vfd.devicesError')}
        onRetry={() => void devices.refetch()}
        isEmpty={drives.length === 0}
        emptyTitle={t('sensorCommands.vfd.noDrives')}
      >
        <SectionBody
          isLoading={log.isLoading}
          isError={log.isError}
          errorTitle={t('sensorCommands.vfd.error')}
          onRetry={() => void log.refetch()}
          isEmpty={(log.data ?? []).length === 0}
          emptyTitle={t('sensorCommands.vfd.empty')}
        >
          <DataTable
            data={log.data ?? []}
            columns={columns}
            keyExtractor={(row) => row.id}
            searchable={false}
            sortable={false}
            striped={false}
            stickyHeader={false}
            flush
            rowClassName={(row) => (row.success ? '' : FAILED_ROW)}
          />
        </SectionBody>
      </SectionBody>
    </CommandSection>
  );
}
