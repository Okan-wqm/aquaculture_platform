/**
 * All commands, every device — the cross-device command record Architecture
 * §11 asks for: who asked, who approved, the target position, what and with
 * which value, its status, the device reply and the lock that stopped it.
 *
 * No backend records this yet (SENSOR-MEDIUM-185), so the table renders
 * sample rows inside MockPreview, whose notice names the finding. The section
 * heading and description are real: they say what the record will hold.
 */
import React from 'react';
import { DataTable, type DataTableColumn, MockPreview, useI18n } from '@aquaculture/shared-ui';

import { CommandSection } from './CommandSection';
import { UNIFIED_COMMAND_LOG_PREVIEW } from './commandLog.preview';
import { formatCommandTime } from './commandFormat';
import { FAILED_ROW, FlaggedOutcome } from './ReplyCells';
import {
  CHANNEL_KEYS,
  KIND_KEYS,
  LOCK_KEYS,
  NOT_APPLIED,
  STATUS_KEYS,
  type UnifiedCommandRow,
} from './previewRows';

export function UnifiedLogPreview(): React.JSX.Element {
  const { t, locale } = useI18n();

  const reply = (row: UnifiedCommandRow): React.ReactNode => {
    if (row.status === 'ACCEPTED' && row.replyMs !== null)
      return t('sensorCommands.reply.acceptedIn', { ms: row.replyMs });
    if (row.status === 'TIMEOUT') return t('sensorCommands.reply.none');
    return row.replyError ?? '—';
  };

  const columns: DataTableColumn<UnifiedCommandRow>[] = [
    {
      key: 'at',
      header: t('sensorCommands.col.time'),
      width: '150px',
      render: (_value, row) => (
        <time dateTime={row.at} className="whitespace-nowrap tabular-nums">
          {formatCommandTime(row.at, locale)}
        </time>
      ),
    },
    { key: 'requestedBy', header: t('sensorCommands.col.requestedBy') },
    {
      key: 'approvedBy',
      header: t('sensorCommands.col.approvedBy'),
      render: (_value, row) => row.approvedBy ?? '—',
    },
    {
      key: 'target',
      header: t('sensorCommands.col.target'),
      render: (_value, row) => (
        <span className="flex flex-col">
          <span className="font-mono text-sm">{row.target}</span>
          <span className="text-xs text-gray-600 dark:text-gray-400">
            {t(CHANNEL_KEYS[row.channel])}
          </span>
        </span>
      ),
    },
    {
      key: 'kind',
      header: t('sensorCommands.col.command'),
      render: (_value, row) => (
        <span className="flex flex-col">
          <span className="font-semibold">{t(KIND_KEYS[row.kind])}</span>
          <span className="tabular-nums">{row.value}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: t('sensorCommands.col.status'),
      render: (_value, row) => {
        // The outcome is always written out; a command that did not apply is flagged too.
        const label = t(STATUS_KEYS[row.status]);
        return NOT_APPLIED.has(row.status) ? <FlaggedOutcome label={label} detail={null} /> : label;
      },
    },
    { key: 'reply', header: t('sensorCommands.col.reply'), render: (_value, row) => reply(row) },
    {
      key: 'lock',
      header: t('sensorCommands.col.lock'),
      render: (_value, row) => (row.lock === null ? '—' : t(LOCK_KEYS[row.lock])),
    },
  ];

  return (
    <CommandSection
      title={t('sensorCommands.unified.title')}
      description={t('sensorCommands.unified.description')}
    >
      <MockPreview data={UNIFIED_COMMAND_LOG_PREVIEW} variant="block">
        {(rows) => (
          <DataTable
            data={rows}
            columns={columns}
            keyExtractor={(row) => row.id}
            searchable={false}
            sortable={false}
            striped={false}
            stickyHeader={false}
            flush
            rowClassName={(row) => (NOT_APPLIED.has(row.status) ? FAILED_ROW : '')}
          />
        )}
      </MockPreview>
    </CommandSection>
  );
}
