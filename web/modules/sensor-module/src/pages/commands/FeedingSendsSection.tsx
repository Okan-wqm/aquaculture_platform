/**
 * Feeding program sends — feeding parameter sets sent to a PLC.
 *
 * Reads the send log (useFeedingSends): sets that left the draft state, newest
 * send first, filtered and ordered by the server and paged through the whole
 * record. sensor-service records no actor for the send itself, so the person
 * column is the set's author — the e-mail recorded when it was created, else
 * the author's id on older sets — and is labelled so. An ERROR send carries
 * the amber flag bar and the PLC's error.
 */
import React, { useState } from 'react';
import { DataTable, type DataTableColumn, useI18n } from '@aquaculture/shared-ui';

import { useFeedingSends } from '../../hooks/useFeedingSends';
import type { FeedingParameter } from '../../hooks/usePlcControl';
import { CommandSection } from './CommandSection';
import { FEEDING_STATUS_KEYS } from './commandLabels';
import { formatCommandTime } from './commandFormat';
import { FAILED_ROW, FlaggedOutcome } from './ReplyCells';
import { SectionBody } from './SectionBody';

/** Sends per page. */
export const FEEDING_SENDS_PAGE_SIZE = 25;

export function FeedingSendsSection(): React.JSX.Element {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(1);
  const sends = useFeedingSends({ page, limit: FEEDING_SENDS_PAGE_SIZE });
  const rows = sends.data?.items ?? [];

  const time = (value: string | undefined): React.ReactNode =>
    value === undefined || value === null ? (
      '—'
    ) : (
      <time dateTime={value} className="whitespace-nowrap tabular-nums">
        {formatCommandTime(value, locale)}
      </time>
    );

  const columns: DataTableColumn<FeedingParameter>[] = [
    {
      key: 'name',
      header: t('sensorCommands.col.program'),
      minWidth: '180px',
      render: (_value, row) => (
        <span className="flex flex-col">
          <span className="font-semibold">{row.name}</span>
          <span className="text-xs text-gray-600 dark:text-gray-400">
            {t('sensorCommands.feeding.version', { version: row.version })}
          </span>
        </span>
      ),
    },
    {
      key: 'connection',
      header: t('sensorCommands.col.plc'),
      render: (_value, row) => row.connection?.name ?? row.plcConnectionId,
    },
    {
      key: 'status',
      header: t('sensorCommands.col.status'),
      render: (_value, row) =>
        row.status === 'ERROR' ? (
          <FlaggedOutcome
            label={t(FEEDING_STATUS_KEYS[row.status])}
            detail={row.errorMessage ?? null}
          />
        ) : (
          t(FEEDING_STATUS_KEYS[row.status])
        ),
    },
    {
      key: 'sentAt',
      header: t('sensorCommands.col.sentAt'),
      render: (_value, row) => time(row.sentAt),
    },
    {
      key: 'acknowledgedAt',
      header: t('sensorCommands.col.acknowledgedAt'),
      render: (_value, row) => time(row.acknowledgedAt),
    },
    {
      key: 'createdBy',
      header: t('sensorCommands.col.preparedBy'),
      render: (_value, row) => row.createdByEmail ?? row.createdBy ?? '—',
    },
  ];

  return (
    <CommandSection
      title={t('sensorCommands.feeding.title')}
      description={t('sensorCommands.feeding.description')}
    >
      <SectionBody
        isLoading={sends.isLoading}
        isError={sends.isError}
        errorTitle={t('sensorCommands.feeding.error')}
        onRetry={() => void sends.refetch()}
        // Empty means no send at all: a page past the end (sets deleted meanwhile) keeps its pager.
        isEmpty={(sends.data?.total ?? 0) === 0}
        emptyTitle={t('sensorCommands.feeding.empty')}
      >
        <DataTable
          data={rows}
          columns={columns}
          keyExtractor={(row) => row.id}
          searchable={false}
          sortable={false}
          striped={false}
          stickyHeader={false}
          flush
          rowClassName={(row) => (row.status === 'ERROR' ? FAILED_ROW : '')}
          pagination={sends.data}
          onPageChange={setPage}
        />
      </SectionBody>
    </CommandSection>
  );
}
