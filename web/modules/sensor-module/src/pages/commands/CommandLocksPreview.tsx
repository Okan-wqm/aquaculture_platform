/**
 * Command locks — the checks that reject a command before it is sent
 * (Architecture §11): equipment with an open work order, a setpoint beyond the
 * livestock-safety limit, an edge device offline (the command queues, then
 * expires). Every rejection is logged and raises a command alarm.
 *
 * No lock is stored or listed yet (SENSOR-MEDIUM-185), so the list renders
 * inside MockPreview, whose notice names the finding. It shows only what §11
 * defines — each lock, what it blocks, what happens to a command it stops —
 * and no state, onset or count: those wait for design or the backend.
 */
import React from 'react';
import { DataTable, type DataTableColumn, MockPreview, useI18n } from '@aquaculture/shared-ui';

import { CommandSection } from './CommandSection';
import { COMMAND_LOCKS_PREVIEW } from './commandLog.preview';
import { LOCK_BLOCKS_KEYS, LOCK_KEYS, LOCK_OUTCOME_KEYS, type CommandLockRow } from './previewRows';

export function CommandLocksPreview(): React.JSX.Element {
  const { t } = useI18n();

  const columns: DataTableColumn<CommandLockRow>[] = [
    {
      key: 'kind',
      header: t('sensorCommands.col.lock'),
      render: (_value, row) => <span className="font-semibold">{t(LOCK_KEYS[row.kind])}</span>,
    },
    {
      key: 'blocks',
      header: t('sensorCommands.col.blocks'),
      render: (_value, row) => t(LOCK_BLOCKS_KEYS[row.kind]),
    },
    {
      key: 'outcome',
      header: t('sensorCommands.col.outcome'),
      render: (_value, row) => t(LOCK_OUTCOME_KEYS[row.kind]),
    },
  ];

  return (
    <CommandSection
      title={t('sensorCommands.locks.title')}
      description={t('sensorCommands.locks.description')}
    >
      <MockPreview data={COMMAND_LOCKS_PREVIEW} variant="block">
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
          />
        )}
      </MockPreview>
    </CommandSection>
  );
}
