import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { FindingView, FindingsResponse } from '../../../../shared/api-contract.ts';
import { getFindings } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { Toolbar } from '../../design/Toolbar.tsx';
import { EMPTY, formatNumber, textOrEmpty } from '../../design/format.ts';
import { ByCountStats } from './ByCountStats.tsx';
import { EvidenceRefs } from './EvidenceRefs.tsx';
import { rowClassForSeverity, toneForSeverity, toneForStatus } from './tones.ts';

/** Kernel severities, ordered worst first — this order is also the table's default sort. */
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'] as const;

const LIMITS = [100, 200, 500, 1000] as const;

const COLUMNS: ReadonlyArray<ColumnDef<FindingView>> = [
  {
    id: 'severity',
    header: 'Severity',
    headerTitle: 'severity — as the reporting tool classified the finding',
    render: (row) => <Badge tone={toneForSeverity(row.severity)}>{row.severity ?? 'unknown'}</Badge>,
    sortValue: (row) => {
      const index = (SEVERITIES as ReadonlyArray<string>).indexOf((row.severity ?? '').toUpperCase());
      return index === -1 ? SEVERITIES.length : index;
    },
    nowrap: true,
    width: '14ch',
  },
  {
    id: 'rule',
    header: 'Rule',
    headerTitle: 'rule — the rule identifier the tool fired',
    render: (row) => textOrEmpty(row.rule),
    sortValue: (row) => row.rule,
    mono: true,
    nowrap: true,
  },
  {
    id: 'location',
    header: 'Location',
    headerTitle: 'path:line — where the tool found it',
    render: (row) => (
      <span title={row.path ?? undefined}>{row.path === null ? EMPTY : `${row.path}${row.line === null ? '' : `:${row.line}`}`}</span>
    ),
    sortValue: (row) => row.path,
    mono: true,
  },
  { id: 'message', header: 'Message', render: (row) => textOrEmpty(row.message) },
  {
    id: 'tool',
    header: 'Tool',
    headerTitle: 'tool_id — the tool that reported the finding',
    render: (row) => textOrEmpty(row.toolId),
    sortValue: (row) => row.toolId,
    mono: true,
    nowrap: true,
  },
  {
    id: 'cycle',
    header: 'Cycle',
    headerTitle: 'cycle_id — the cycle the finding was reported in',
    render: (row) =>
      row.cycleId === null ? (
        <span className="muted">{EMPTY}</span>
      ) : (
        <Link className="mono" to={ROUTES.cycle(row.cycleId)}>
          {row.cycleId}
        </Link>
      ),
    nowrap: true,
  },
  { id: 'evidence', header: 'Evidence', headerTitle: 'evidence_refs — pointers that make the finding checkable', render: (row) => <EvidenceRefs refs={row.evidenceRefs} /> },
  {
    id: 'feedback',
    header: 'Feedback',
    headerTitle: 'feedback — the operator verdict recorded against the finding',
    render: (row) => (row.feedback === null ? <span className="muted">{EMPTY}</span> : <Badge tone={toneForStatus(row.feedback)}>{row.feedback}</Badge>),
    sortValue: (row) => row.feedback,
    nowrap: true,
  },
  {
    id: 'at',
    header: 'Time',
    headerTitle: 'at — when the finding was recorded',
    render: (row) => <Timestamp value={row.at} />,
    sortValue: (row) => row.at,
    nowrap: true,
    width: '16ch',
  },
];

export interface FindingsTableProps {
  readonly data: FindingsResponse;
  /** True when a server-side severity or tool filter is narrowing the response. */
  readonly filtered: boolean;
}

/**
 * The findings answer: severity distribution first, then the rows.
 *
 * WHY: an operator opens this page to learn how bad it is before learning what
 * exactly is wrong, so the distribution leads and the table follows. Exported
 * separately from the page so the rendering can be tested without a network.
 */
export function FindingsTable({ data, filtered }: FindingsTableProps): ReactNode {
  return (
    <>
      <Card title="Severity" subtitle="Counted across every finding the server matched, not only the rows shown below.">
        <ByCountStats
          counts={data.bySeverity}
          kind="severity"
          emptyTitle="No severities to count"
          emptyMessage="Each severity the reporting tools emitted would be counted here; no finding matched this filter."
        />
      </Card>
      <Card flush>
        <DataTable
          columns={COLUMNS}
          rows={data.findings}
          rowKey={(row) => row.id}
          caption="Findings"
          emptyTitle={filtered ? 'No findings match this filter' : 'No findings yet'}
          emptyMessage={
            filtered
              ? 'Findings matching the selected severity and tool would be listed here; the server matched none. Widen the filter to see the rest.'
              : 'Every defect a tool reported during a cycle is listed here; the kernel has not recorded one yet.'
          }
          filter={{
            placeholder: 'Search rule, path, message or tool…',
            predicate: (row, query) => `${row.rule ?? ''} ${row.path ?? ''} ${row.message ?? ''} ${row.toolId ?? ''}`.toLowerCase().includes(query),
          }}
          rowClassName={(row) => rowClassForSeverity(row.severity)}
          initialSort={{ columnId: 'severity', direction: 'asc' }}
          maxHeight="62vh"
          countNoun="findings"
        />
      </Card>
    </>
  );
}

export function FindingsPage(): ReactNode {
  const [severity, setSeverity] = useState('');
  const [tool, setTool] = useState('');
  const [limit, setLimit] = useState<number>(200);
  const { state, reload } = useRequest(
    (signal) => getFindings({ severity: severity === '' ? undefined : severity, tool: tool === '' ? undefined : tool, limit }, signal),
    [severity, tool, limit],
  );
  const filtered = severity !== '' || tool !== '';

  return (
    <>
      <PageHeader
        title="Findings"
        subtitle={
          state.status === 'success' ? (
            <span className="tnum">
              {formatNumber(state.data.total)} total · {formatNumber(state.data.findings.length)} shown
            </span>
          ) : (
            <span className="mono">raw-findings.jsonl + findings.jsonl</span>
          )
        }
        actions={
          <button type="button" className="button" onClick={reload}>
            Refresh
          </button>
        }
      />
      <div className="stack">
        <Toolbar align="end">
          <label className="field" htmlFor="findings-severity">
            <span>Severity</span>
            <select id="findings-severity" value={severity} onChange={(event) => setSeverity(event.target.value)}>
              <option value="">All</option>
              {SEVERITIES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor="findings-tool">
            <span>Tool</span>
            <input id="findings-tool" type="text" value={tool} onChange={(event) => setTool(event.target.value)} placeholder="Exact tool_id" autoComplete="off" />
          </label>
          <label className="field" htmlFor="findings-limit">
            <span>Limit</span>
            <select id="findings-limit" value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
              {LIMITS.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        </Toolbar>
        <AsyncState state={state} onRetry={reload} skeleton="table" errorTitle="Could not load findings">
          {(data) => <FindingsTable data={data} filtered={filtered} />}
        </AsyncState>
      </div>
    </>
  );
}
