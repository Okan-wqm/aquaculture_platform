// Case intake: what arrived, when, and whether the receipt still adds up.
//
// WHY: everything else in this module reads what the adapter derived. This tab
// shows the one thing that comes before derivation — the moment each document
// entered the archive. A lawyer asked "can you show this file reached you
// unchanged?" is answered here: the receipt records the bytes' hash at arrival,
// the adapter hashes the same file again independently, and the receipt chain
// makes a later edit to the record itself detectable rather than invisible.
// WHAT: the custody band, the chain verdict, the receipt table, and — only when
// the server reports actionsEnabled — the upload control and the inventory run.
import { useCallback, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import type { LegalIntakeRecord, LegalIntakeResponse } from '../../../../shared/legal-contract.ts';
import { getLegalIntake, runLegalInventory, uploadLegalDocument } from '../../api/legal-client.ts';
import { useRequest } from '../../api/use-request.ts';
import { useHealth } from '../../app/HealthProvider.tsx';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { CopyButton } from '../../design/CopyButton.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { EmptyState } from '../../design/EmptyState.tsx';
import { Icon } from '../../design/Icon.tsx';
import { KeyValueList } from '../../design/KeyValueList.tsx';
import { MonoPanel } from '../../design/MonoPanel.tsx';
import { SectionHeading } from '../../design/SectionHeading.tsx';
import { Stat } from '../../design/Stat.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { Toolbar } from '../../design/Toolbar.tsx';
import { EMPTY, formatBytes, formatNumber, shortHash } from '../../design/format.ts';
import { useCaseContext } from './CaseDetailPage.tsx';
import './legal.css';

const COLUMNS: ReadonlyArray<ColumnDef<LegalIntakeRecord>> = [
  {
    id: 'received',
    header: 'Received',
    render: (row) => <Timestamp value={row.receivedAt} />,
    sortValue: (row) => row.receivedAt,
    nowrap: true,
    headerTitle: 'receivedAt — when the console took delivery of these bytes',
  },
  {
    id: 'path',
    header: 'Stored as',
    render: (row) => row.relativePath,
    sortValue: (row) => row.relativePath,
    mono: true,
    filterValue: (row) => row.relativePath,
    headerTitle: 'Path inside archive/, exactly as the adapter will read it',
  },
  {
    id: 'bytes',
    header: 'Size',
    render: (row) => formatBytes(row.bytes),
    sortValue: (row) => row.bytes,
    align: 'end',
    nowrap: true,
  },
  {
    id: 'sha256',
    header: 'sha256 at arrival',
    render: (row) => (
      <span className="nowrap">
        {shortHash(row.sha256)} <CopyButton value={row.sha256} label="Copy the full digest" />
      </span>
    ),
    mono: true,
    filterValue: (row) => row.sha256,
    headerTitle: 'The digest measured while the bytes streamed in; the adapter recomputes it independently',
  },
  {
    id: 'by',
    header: 'Taken by',
    render: (row) => row.receivedBy,
    sortValue: (row) => row.receivedBy,
    headerTitle: 'The console identity that uploaded it',
  },
  {
    id: 'source',
    header: 'Source note',
    render: (row) => (row.sourceNote === null ? <span className="muted">{EMPTY}</span> : row.sourceNote),
    filterValue: (row) => row.sourceNote ?? '',
    headerTitle: 'Where the document came from, as the operator stated it',
  },
];

interface UploadReport {
  readonly fileName: string;
  readonly outcome: 'stored' | 'already-held' | 'refused';
  readonly detail: string;
}

export function IntakeTab(): ReactNode {
  const { caseId, detail } = useCaseContext();
  const health = useHealth();
  const { state, reload } = useRequest((signal) => getLegalIntake(caseId, signal), [caseId]);
  const [reports, setReports] = useState<ReadonlyArray<UploadReport>>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [inventory, setInventory] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const send = useCallback(
    async (files: ReadonlyArray<File>): Promise<void> => {
      if (files.length === 0) return;
      setBusy(true);
      const collected: UploadReport[] = [];
      for (const file of files) {
        try {
          const result = await uploadLegalDocument(caseId, file);
          collected.push({
            fileName: file.name,
            outcome: result.duplicate ? 'already-held' : 'stored',
            // The digest is the receipt: showing it here lets an operator compare
            // against whatever the sender told them without leaving the page.
            detail: `sha256 ${shortHash(result.record.sha256)} · ${formatBytes(result.record.bytes)}`,
          });
        } catch (error) {
          collected.push({ fileName: file.name, outcome: 'refused', detail: error instanceof Error ? error.message : String(error) });
        }
      }
      setReports(collected);
      setBusy(false);
      reload();
    },
    [caseId, reload],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      setDragging(false);
      void send([...event.dataTransfer.files]);
    },
    [send],
  );

  const onPick = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      void send([...(event.target.files ?? [])]);
      event.target.value = '';
    },
    [send],
  );

  const startInventory = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const job = await runLegalInventory(caseId, detail.case.title);
      setInventory(`Inventory job ${job.jobId} started: ${job.command.join(' ')}`);
    } catch (error) {
      setInventory(error instanceof Error ? error.message : String(error));
    }
    setBusy(false);
  }, [caseId, detail.case.title]);

  return (
    <div className="stack">
      <Callout tone="neutral" title="What this tab proves, and what it does not">
        Each row records that these exact bytes arrived at this time. It is not a statement about the document&apos;s truth or its legal
        effect. The inventory run below re-reads the archive and hashes every file again; a digest that disagrees with its receipt is a
        finding, not a silent correction.
      </Callout>

      {health.actionsEnabled ? (
        <Card title="Add documents" subtitle="Files are stored under this case's archive/ and never modified">
          <div
            className={`intake-drop${dragging ? ' intake-drop--active' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <p>Drop documents here, or</p>
            <button type="button" className="button" disabled={busy} onClick={() => fileInput.current?.click()}>
              <Icon name="arrow-right" />
              Choose files
            </button>
            <input ref={fileInput} type="file" multiple hidden onChange={onPick} aria-label="Documents to add to this case" />
            <p className="muted">
              PDF, Word, Excel, PowerPoint, e-mail and plain text are read for their content. A scanned or encrypted PDF is still stored
              and hashed; its coverage row states why no text could be read.
            </p>
          </div>
          {reports.length > 0 ? (
            <div className="stack">
              <SectionHeading title="Last upload" level={3} plain />
              <ul className="legal-list">
                {reports.map((report) => (
                  <li key={report.fileName}>
                    <Badge tone={report.outcome === 'refused' ? 'danger' : report.outcome === 'already-held' ? 'warning' : 'success'}>{report.outcome}</Badge>{' '}
                    <span className="mono">{report.fileName}</span> — {report.detail}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <Toolbar>
            <button type="button" className="button" disabled={busy} onClick={() => void startInventory()}>
              <Icon name="refresh" />
              Run inventory
            </button>
            <span className="muted">Re-reads the archive through the kernel and rewrites this case&apos;s records.</span>
          </Toolbar>
          {inventory === null ? null : <MonoPanel label="Inventory run" text={inventory} />}
        </Card>
      ) : (
        <Callout tone="warning" title="This console is read-only">
          Uploading documents and running an inventory change state, so they stay hidden until the server reports{' '}
          <code>actionsEnabled</code>. The instance manifest can also withhold it independently of the environment.
        </Callout>
      )}

      <AsyncState state={state} onRetry={reload} skeleton="table" errorTitle="Could not read the intake receipt">
        {(data) => <IntakeReceipt data={data} />}
      </AsyncState>
    </div>
  );
}

/**
 * The receipt itself, separated from the fetching shell so the guarantees below
 * can be asserted directly: the chain verdict, the missing-custody state and the
 * per-row digest are what a custody claim rests on.
 */
export function IntakeReceipt({ data }: { readonly data: LegalIntakeResponse }): ReactNode {
  return (
          <div className="stack">
            <div className="stat-grid">
              <Stat label="Documents received" value={formatNumber(data.intake.length)} />
              <Stat
                label="Receipt chain"
                value={data.chain.valid ? 'intact' : 'broken'}
                tone={data.chain.valid ? 'default' : 'danger'}
                hint={data.chain.valid ? 'Every row hashes to its recorded value' : `Row ${formatNumber((data.chain.brokenAt ?? 0) + 1)}: ${data.chain.reason ?? 'unknown'}`}
              />
              <Stat label="Bytes taken in" value={formatBytes(data.intake.reduce((sum, row) => sum + row.bytes, 0))} />
            </div>

            {data.chain.valid ? null : (
              <Callout tone="danger" title="The intake receipt does not verify" role="alert">
                Row {formatNumber((data.chain.brokenAt ?? 0) + 1)} failed with <code>{data.chain.reason ?? 'unknown'}</code>. The receipt
                was changed after it was written, so it can no longer stand as a record of what arrived. Preserve the file and treat the
                custody claim for this case as unproven until it is explained.
              </Callout>
            )}

            {data.caseMeta === null ? (
              <EmptyState
                title="No custody record for this case"
                message="This case's documents were placed in the archive without going through intake, so nothing recorded when they arrived or who took delivery."
              />
            ) : (
              <Card title="Custody">
                <KeyValueList
                  data={{
                    caseId: data.caseMeta.caseId,
                    title: data.caseMeta.title,
                    custodian: data.caseMeta.custodian,
                    jurisdiction: data.caseMeta.jurisdiction,
                    courtReference: data.caseMeta.courtReference,
                    createdAt: data.caseMeta.createdAt,
                    createdBy: data.caseMeta.createdBy,
                  }}
                />
              </Card>
            )}

            <Card title="Arrivals" subtitle="Append-only; each row names its predecessor by hash" flush>
              <DataTable
                columns={COLUMNS}
                rows={data.intake}
                rowKey={(row) => row.rowHash}
                caption="Intake receipt"
                countNoun="documents"
                emptyTitle="Nothing has been taken in yet"
                emptyMessage="Documents added through this tab appear here with the time they arrived and the digest measured as they streamed in."
                filterRow
                initialSort={{ columnId: 'received', direction: 'desc' }}
                maxHeight="55vh"
              />
            </Card>
          </div>
  );
}
