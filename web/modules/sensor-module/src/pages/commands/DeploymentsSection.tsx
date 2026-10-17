/**
 * Program deployments — automation programs pushed to edge devices.
 *
 * Reads `deploymentHistory` with no device (every device of the tenant, newest
 * first), a page at a time through the whole record, and names its ids from
 * the lists that already hold them: `automationPrograms`
 * (useAutomationPrograms) and `edgeDevices` (useEdgeDevices). A program or
 * device that no longer lists — deleted or beyond the first page — is shown by
 * its id rather than dropped. The deployer is the e-mail recorded at deploy
 * time, else the deployer's id on older rows. A FAILED or ROLLED_BACK
 * deployment carries the amber flag bar and the edge's error.
 */
import React, { useMemo, useState } from 'react';
import { DataTable, type DataTableColumn, useI18n } from '@aquaculture/shared-ui';

import type { DeploymentStatus } from '@platform/shared-ui/generated/graphql-types';
import { useAutomationPrograms } from '../../hooks/useAutomationPrograms';
import {
  useDeploymentHistory,
  type DeploymentHistoryEntry,
} from '../../hooks/useDeploymentHistory';
import { useEdgeDevices } from '../../hooks/useEdgeDevices';
import { CommandSection } from './CommandSection';
import { DEPLOYMENT_STATUS_KEYS } from './commandLabels';
import { formatCommandTime } from './commandFormat';
import { FAILED_ROW, FlaggedOutcome } from './ReplyCells';
import { SectionBody } from './SectionBody';

/** Deployments per page. */
export const DEPLOYMENTS_PAGE_SIZE = 25;
const EDGE_DEVICE_PAGE = { page: 1, limit: 100 } as const;
const UNSUCCESSFUL: ReadonlySet<DeploymentStatus> = new Set(['FAILED', 'ROLLED_BACK']);

interface Named {
  name: string;
  code: string;
}

function NameCell({ named, id }: { named: Named | undefined; id: string }): React.JSX.Element {
  if (named === undefined) return <span className="font-mono text-xs">{id}</span>;
  return (
    <span className="flex flex-col">
      <span className="font-semibold">{named.name}</span>
      <span className="font-mono text-xs text-gray-600 dark:text-gray-400">{named.code}</span>
    </span>
  );
}

export function DeploymentsSection(): React.JSX.Element {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(1);
  const history = useDeploymentHistory({ page, limit: DEPLOYMENTS_PAGE_SIZE });
  const programs = useAutomationPrograms();
  const edgeDevices = useEdgeDevices(EDGE_DEVICE_PAGE);

  const programNames = useMemo(
    (): ReadonlyMap<string, Named> =>
      new Map(
        (programs.data?.automationPrograms ?? []).map((program) => [
          program.id,
          { name: program.programName, code: program.programCode },
        ]),
      ),
    [programs.data],
  );
  const deviceNames = useMemo(
    (): ReadonlyMap<string, Named> =>
      new Map(
        (edgeDevices.data?.items ?? []).map((device) => [
          device.id,
          { name: device.deviceName, code: device.deviceCode },
        ]),
      ),
    [edgeDevices.data],
  );

  const columns: DataTableColumn<DeploymentHistoryEntry>[] = [
    {
      key: 'deployedAt',
      header: t('sensorCommands.col.time'),
      width: '150px',
      render: (_value, row) => (
        <time dateTime={row.deployedAt} className="whitespace-nowrap tabular-nums">
          {formatCommandTime(row.deployedAt, locale)}
        </time>
      ),
    },
    {
      key: 'programId',
      header: t('sensorCommands.col.program'),
      render: (_value, row) => (
        <NameCell named={programNames.get(row.programId)} id={row.programId} />
      ),
    },
    {
      key: 'version',
      header: t('sensorCommands.col.version'),
      align: 'right',
      render: (_value, row) => <span className="tabular-nums">{row.version}</span>,
    },
    {
      key: 'deviceId',
      header: t('sensorCommands.col.device'),
      render: (_value, row) => <NameCell named={deviceNames.get(row.deviceId)} id={row.deviceId} />,
    },
    {
      key: 'status',
      header: t('sensorCommands.col.status'),
      render: (_value, row) => {
        // The outcome is always written out; a deployment that did not land is flagged too.
        const label = t(DEPLOYMENT_STATUS_KEYS[row.status]);
        return UNSUCCESSFUL.has(row.status) ? (
          <FlaggedOutcome label={label} detail={row.errorMessage ?? null} />
        ) : (
          label
        );
      },
    },
    {
      key: 'deployedBy',
      header: t('sensorCommands.col.deployedBy'),
      render: (_value, row) => row.deployedByEmail ?? row.deployedBy ?? '—',
    },
    {
      key: 'edgeAckAt',
      header: t('sensorCommands.col.edgeAck'),
      render: (_value, row) =>
        row.edgeAckAt === null || row.edgeAckAt === undefined ? (
          '—'
        ) : (
          <time dateTime={row.edgeAckAt} className="whitespace-nowrap tabular-nums">
            {formatCommandTime(row.edgeAckAt, locale)}
          </time>
        ),
    },
  ];

  const deployments = history.data?.items ?? [];

  return (
    <CommandSection
      title={t('sensorCommands.deploy.title')}
      description={t('sensorCommands.deploy.description')}
    >
      <SectionBody
        isLoading={history.isLoading}
        isError={history.isError}
        errorTitle={t('sensorCommands.deploy.error')}
        onRetry={() => void history.refetch()}
        // Empty means no deployment at all: a page past the end keeps its pager.
        isEmpty={(history.data?.total ?? 0) === 0}
        emptyTitle={t('sensorCommands.deploy.empty')}
      >
        <DataTable
          data={deployments}
          columns={columns}
          keyExtractor={(row) => row.id}
          searchable={false}
          sortable={false}
          striped={false}
          stickyHeader={false}
          flush
          rowClassName={(row) => (UNSUCCESSFUL.has(row.status) ? FAILED_ROW : '')}
          pagination={history.data}
          onPageChange={setPage}
        />
      </SectionBody>
    </CommandSection>
  );
}
