/**
 * The sources of every active parameter at one measurement point — one row per
 * parameter, the calculation's inputs first (a system point resolves the
 * DOSING set, a tank the TOXICITY set) — with each source as a tile: the
 * primary channel, its backup, the manual entry line.
 *
 * Writers (TENANT_ADMIN, MODULE_MANAGER) bind, add a backup, replace and
 * unbind; everyone else reads. Unbinding a primary promotes its backup, and
 * the table says which channel took over.
 */
import {
  bindingRefusal,
  Button,
  DataTable,
  type DataTableColumn,
  errorText,
  ParameterSourceTile,
  sourceKindOf,
  useCanMutate,
  useConfirm,
  useI18n,
  type InputSetResult,
  type ParameterSourceAtPoint,
  type ParameterSourceRow,
  type PointRef,
  type ProblemFix,
  type SourceProblemCode,
} from '@aquaculture/shared-ui';
import type {
  ChannelSourcePriority,
  MeasurementPosition,
} from '@platform/shared-ui/generated/graphql-types';
import React, { useMemo, useState } from 'react';

import type { ParameterConfig } from '../../../../hooks/useParameterConfigs';
import { useUnbindParameterChannel } from '../../../../hooks/useParameterSources';

import { BindChannelDialog } from './BindChannelDialog';

export interface PointSourcesTableProps {
  point: PointRef;
  position: MeasurementPosition;
  parameters: readonly ParameterConfig[];
  sources: readonly ParameterSourceAtPoint[];
  /** The point's resolved calculation inputs (null: the point resolves none, or not yet). */
  inputSet: InputSetResult | null;
  siteId: string | null;
  now: number;
  onFix: (code: SourceProblemCode, fix: ProblemFix, source: ParameterSourceRow | null) => void;
}

/** One parameter's row: its sources at the point, by kind, and its calculation-input problems. */
interface SourceRow {
  parameter: ParameterConfig;
  engineInput: string | null;
  primary: ParameterSourceAtPoint | null;
  backup: ParameterSourceAtPoint | null;
  manual: ParameterSourceAtPoint[];
  inputProblems: readonly SourceProblemCode[];
}

type DialogState = null | {
  parameter: ParameterConfig;
  mode:
    | { kind: 'bind'; priority: ChannelSourcePriority }
    | { kind: 'replace'; sourceId: string; priority: ChannelSourcePriority };
};

/** The order a point's rows are listed in: the calculation's inputs first, then display order. */
function orderParameters(
  parameters: readonly ParameterConfig[],
  inputSet: InputSetResult | null,
): Array<{ parameter: ParameterConfig; engineInput: string | null }> {
  const inputs = inputSet === null ? [] : inputSet.inputs;
  const inputOf = new Map<string, string>();
  for (const input of inputs) {
    if (input.parameterConfigId !== null) inputOf.set(input.parameterConfigId, input.engineInput);
  }
  const rank = (parameter: ParameterConfig): number => {
    const index = inputs.findIndex((input) => input.parameterConfigId === parameter.id);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...parameters]
    .sort((a, b) => rank(a) - rank(b) || a.displayOrder - b.displayOrder)
    .map((parameter) => ({ parameter, engineInput: inputOf.get(parameter.id) ?? null }));
}

function channelDetail(entry: ParameterSourceAtPoint): string | null {
  const { source } = entry;
  if (source.channelKey === null) return 'In the manual entry plan';
  return `${source.channelKey} · ${source.position.toLowerCase()}`;
}

export const PointSourcesTable: React.FC<PointSourcesTableProps> = ({
  point,
  position,
  parameters,
  sources,
  inputSet,
  siteId,
  now,
  onFix,
}) => {
  const { t } = useI18n();
  const confirm = useConfirm();
  const canBind = useCanMutate('bindParameterChannel');
  const canUnbind = useCanMutate('unbindParameterChannel');
  const canReplace = useCanMutate('replaceParameterChannel');
  const unbind = useUnbindParameterChannel();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const rows = useMemo(() => orderParameters(parameters, inputSet), [parameters, inputSet]);

  const handleUnbind = async (entry: ParameterSourceAtPoint, channelKey: string): Promise<void> => {
    const { source } = entry;
    const confirmed = await confirm({
      title: t('wqSource.ui.unbind'),
      message: `Stop reading ${source.parameterConfig.name} from ${channelKey}? A backup at the same place takes over.`,
      confirmText: t('wqSource.ui.unbind'),
      variant: 'warning',
    });
    if (!confirmed) return;
    setNotice(null);
    try {
      const { promoted } = await unbind.mutateAsync(source.id);
      setNotice(
        promoted === null || promoted.channelKey === null
          ? `${source.parameterConfig.name}: ${channelKey} unbound.`
          : `${source.parameterConfig.name}: ${channelKey} unbound; the backup ${promoted.channelKey} is now the primary.`,
      );
    } catch {
      // Shown from unbind.error below, by its stable code when it has one.
    }
  };
  const unbindRefusal = unbind.error === null ? null : bindingRefusal(unbind.error);

  const tileOf = (entry: ParameterSourceAtPoint): React.ReactElement => {
    const { source, channel, problems } = entry;
    return (
      <ParameterSourceTile
        name={source.parameterConfig.name}
        value={channel === null ? null : channel.latestValue}
        unit={channel === null ? source.parameterConfig.unit : channel.unit}
        precision={source.parameterConfig.precision}
        observedAt={channel === null ? null : channel.latestAt}
        now={now}
        windowSeconds={null}
        quality={channel === null ? null : channel.latestQuality}
        kind={sourceKindOf(source)}
        inheritedFrom={null}
        detail={channelDetail(entry)}
        trend={null}
        color={source.parameterConfig.chartColor}
        problems={problems}
        onFix={(code, fix) => onFix(code, fix, source)}
      />
    );
  };

  const sourceRows: SourceRow[] = rows.map(({ parameter, engineInput }) => {
    const own = sources.filter((entry) => entry.source.parameterConfigId === parameter.id);
    const here = own.filter((entry) => entry.source.position === position);
    return {
      parameter,
      engineInput,
      primary: here.find((entry) => sourceKindOf(entry.source) === 'CHANNEL_PRIMARY') ?? null,
      backup: here.find((entry) => sourceKindOf(entry.source) === 'CHANNEL_BACKUP') ?? null,
      manual: own.filter((entry) => entry.source.channelKey === null),
      inputProblems:
        inputSet === null
          ? []
          : (inputSet.inputs.find((candidate) => candidate.parameterConfigId === parameter.id)
              ?.problems ?? []),
    };
  });

  const channelActions = (
    parameter: ParameterConfig,
    entry: ParameterSourceAtPoint,
  ): React.ReactElement | null => {
    const channelKey = entry.source.channelKey;
    if (channelKey === null) return null;
    return (
      <div className="mt-1 flex gap-2">
        {canReplace && (
          <Button
            variant="ghost"
            size="xs"
            type="button"
            onClick={() =>
              setDialog({
                parameter,
                mode: {
                  kind: 'replace',
                  sourceId: entry.source.id,
                  priority: sourceKindOf(entry.source) === 'CHANNEL_BACKUP' ? 'BACKUP' : 'PRIMARY',
                },
              })
            }
          >
            {t('wqSource.ui.replace')}
          </Button>
        )}
        {canUnbind && (
          <Button
            variant="ghost"
            size="xs"
            type="button"
            disabled={unbind.isPending}
            onClick={() => void handleUnbind(entry, channelKey)}
          >
            {t('wqSource.ui.unbind')}
          </Button>
        )}
      </div>
    );
  };

  const empty = (text: string): React.ReactElement => (
    <span className="text-xs text-gray-400 dark:text-gray-500">{text}</span>
  );

  const boundCell = (row: SourceRow, entry: ParameterSourceAtPoint): React.ReactElement => (
    <>
      {tileOf(entry)}
      {channelActions(row.parameter, entry)}
    </>
  );

  const bindButton = (row: SourceRow, priority: ChannelSourcePriority): React.ReactElement => (
    <Button
      variant="secondary"
      size="xs"
      type="button"
      onClick={() => setDialog({ parameter: row.parameter, mode: { kind: 'bind', priority } })}
    >
      {priority === 'PRIMARY' ? t('wqSource.ui.bind') : t('wqSource.ui.addBackup')}
    </Button>
  );

  const primaryCell = (row: SourceRow): React.ReactElement => {
    if (row.primary !== null) return boundCell(row, row.primary);
    return canBind ? bindButton(row, 'PRIMARY') : empty(t('wqSource.ui.noChannel'));
  };

  const backupCell = (row: SourceRow): React.ReactElement => {
    if (row.backup !== null) return boundCell(row, row.backup);
    return row.primary !== null && canBind ? bindButton(row, 'BACKUP') : empty('—');
  };

  const columns: DataTableColumn<SourceRow>[] = [
    {
      key: 'parameter',
      header: t('wqSource.ui.parameter'),
      render: (_value, row) => (
        <div data-parameter={row.parameter.code}>
          <div className="font-medium text-gray-900 dark:text-gray-100">{row.parameter.name}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {row.parameter.code} · {row.parameter.unit}
          </div>
          {row.engineInput !== null && (
            <span className="mt-1 inline-block rounded bg-info-100 px-1.5 py-0.5 text-[11px] text-info-800 dark:bg-info-900/40 dark:text-info-200">
              {row.engineInput}
            </span>
          )}
          {row.inputProblems.length > 0 && (
            <ul className="mt-1 text-[11px] text-warning-700 dark:text-warning-300">
              {row.inputProblems.map((code) => (
                <li key={code}>{t(`wqSource.problem.${code}`)}</li>
              ))}
            </ul>
          )}
        </div>
      ),
    },
    {
      key: 'primary',
      header: t('wqSource.ui.primary'),
      width: '16rem',
      render: (_value, row) => primaryCell(row),
    },
    {
      key: 'backup',
      header: t('wqSource.ui.backup'),
      width: '16rem',
      render: (_value, row) => backupCell(row),
    },
    {
      key: 'manual',
      header: t('wqSource.ui.manual'),
      width: '14rem',
      render: (_value, row) =>
        row.manual.length === 0
          ? empty('—')
          : row.manual.map((entry) => <div key={entry.source.id}>{tileOf(entry)}</div>),
    },
  ];

  return (
    <div className="space-y-3">
      {notice !== null && (
        <div
          role="status"
          className="rounded-lg border border-info-200 bg-info-50 p-3 text-sm text-info-800 dark:border-info-800 dark:bg-info-900/20 dark:text-info-200"
        >
          {notice}
        </div>
      )}
      {unbind.error !== null && (
        <p role="alert" className="text-sm text-error-700 dark:text-error-300">
          {unbindRefusal === null ? unbind.error.message : errorText(t, unbindRefusal.code)}
        </p>
      )}
      <DataTable<SourceRow>
        data={sourceRows}
        columns={columns}
        keyExtractor={(row) => row.parameter.id}
        searchable={false}
        sortable={false}
        stickyHeader={false}
      />

      {dialog !== null && (
        <BindChannelDialog
          parameter={{
            id: dialog.parameter.id,
            name: dialog.parameter.name,
            unit: dialog.parameter.unit,
            quantity: dialog.parameter.quantity,
          }}
          point={point}
          position={position}
          mode={dialog.mode}
          siteId={siteId}
          onClose={() => setDialog(null)}
          onDone={() => setDialog(null)}
        />
      )}
    </div>
  );
};
