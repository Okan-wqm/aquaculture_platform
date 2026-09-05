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
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from 'react';
import type { LegalIntakeRecord, LegalIntakeResponse } from '../../../../shared/legal-contract.ts';
import type { JobResponse } from '../../../../shared/api-contract.ts';
import { getJob } from '../../api/client.ts';
import { isApiClientError, toError } from '../../api/errors.ts';
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
    headerTitle:
      'The digest measured while the bytes streamed in; the adapter recomputes it independently',
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
    render: (row) =>
      row.sourceNote === null ? <span className="muted">{EMPTY}</span> : row.sourceNote,
    filterValue: (row) => row.sourceNote ?? '',
    headerTitle: 'Where the document came from, as the operator stated it',
  },
];

interface UploadReport {
  readonly fileName: string;
  readonly outcome: 'stored' | 'already-held' | 'refused';
  readonly detail: string;
}

const INVENTORY_POLL_MS = 2000;

type InventoryRun =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'tracking'; readonly job: JobResponse; readonly pollError: Error | null }
  | { readonly kind: 'error'; readonly error: Error };

function safeInventoryError(error: Error): string {
  return isApiClientError(error)
    ? error.payload.error
    : 'The inventory service could not be reached.';
}

export function IntakeTab(): ReactNode {
  const { caseId, detail, reloadCase } = useCaseContext();
  const health = useHealth();
  // The kernel's own word on whether it will run the inventory tool; the button
  // is disabled with that word rather than failing after the click.
  const adapter = health.state.status === 'success' ? health.state.data.legal : null;
  const { state, reload } = useRequest((signal) => getLegalIntake(caseId, signal), [caseId]);
  const [reports, setReports] = useState<ReadonlyArray<UploadReport>>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [inventory, setInventory] = useState<InventoryRun>({ kind: 'idle' });
  const refreshedJobIds = useRef(new Set<string>());
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
          collected.push({
            fileName: file.name,
            outcome: 'refused',
            detail: error instanceof Error ? error.message : String(error),
          });
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

  useEffect(() => {
    if (inventory.kind !== 'tracking') return;
    if (inventory.job.state === 'succeeded') {
      if (!refreshedJobIds.current.has(inventory.job.jobId)) {
        refreshedJobIds.current.add(inventory.job.jobId);
        reloadCase();
      }
      return;
    }
    if (inventory.job.state === 'failed') return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      getJob(inventory.job.jobId, controller.signal)
        .then((job) => setInventory({ kind: 'tracking', job, pollError: null }))
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) {
            setInventory({ kind: 'tracking', job: inventory.job, pollError: toError(reason) });
          }
        });
    }, INVENTORY_POLL_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [inventory, reloadCase]);

  const startInventory = useCallback(async (): Promise<void> => {
    if (
      inventory.kind === 'submitting' ||
      (inventory.kind === 'tracking' &&
        inventory.job.state !== 'failed' &&
        inventory.job.state !== 'succeeded')
    )
      return;
    setInventory({ kind: 'submitting' });
    try {
      const job = await runLegalInventory(caseId, detail.case.title);
      setInventory({ kind: 'tracking', job, pollError: null });
    } catch (error) {
      setInventory({ kind: 'error', error: toError(error) });
    }
  }, [caseId, detail.case.title, inventory]);

  const inventoryActive =
    inventory.kind === 'submitting' ||
    (inventory.kind === 'tracking' &&
      inventory.job.state !== 'failed' &&
      inventory.job.state !== 'succeeded');

  return (
    <div className="stack">
      <Callout tone="neutral" title="What this tab proves, and what it does not">
        Each row records that these exact bytes arrived at this time. It is not a statement about
        the document&apos;s truth or its legal effect. The inventory run below re-reads the archive
        and hashes every file again; a digest that disagrees with its receipt is a finding, not a
        silent correction.
      </Callout>

      {health.can('case_intake') ? (
        <Card
          title="Add documents"
          subtitle="Files are stored under this case's archive/ and never modified"
        >
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
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="arrow-right" />
              Choose files
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={onPick}
              aria-label="Documents to add to this case"
            />
            <p className="muted">
              PDF, Word, Excel, PowerPoint, e-mail and plain text are read for their content. A
              scanned or encrypted PDF is still stored and hashed; its coverage row states why no
              text could be read.
            </p>
          </div>
          {reports.length > 0 ? (
            <div className="stack">
              <SectionHeading title="Last upload" level={3} plain />
              <ul className="legal-list">
                {reports.map((report) => (
                  <li key={report.fileName}>
                    <Badge
                      tone={
                        report.outcome === 'refused'
                          ? 'danger'
                          : report.outcome === 'already-held'
                            ? 'warning'
                            : 'success'
                      }
                    >
                      {report.outcome}
                    </Badge>{' '}
                    <span className="mono">{report.fileName}</span> — {report.detail}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ) : (
        <Callout tone="warning" title="Adding documents is not permitted for this account">
          The instance&apos;s approval policy governs <code>case_intake</code>; the server reports
          that this principal may not perform it, so the upload control stays hidden. This is a
          policy decision, not a display setting.
        </Callout>
      )}

      {health.can('corpus_inventory') ? (
        <Card
          title="Inventory"
          subtitle="Re-reads the archive through the kernel and rewrites this case's records"
        >
          {adapter === null || adapter.adapter === 'registered' ? null : (
            <Callout
              tone="danger"
              title={`The legal adapter is ${adapter.adapter.replace('_', ' ')}`}
            >
              {adapter.detail ??
                'The kernel will not run the inventory tool until this is resolved.'}
            </Callout>
          )}
          <Toolbar>
            <button
              type="button"
              className="button"
              disabled={
                busy || inventoryActive || (adapter !== null && adapter.adapter !== 'registered')
              }
              onClick={() => void startInventory()}
            >
              <Icon name="refresh" />
              Run inventory
            </button>
            <span className="muted">
              The receipt records when bytes arrived. Event and party knowledge stays tied to what
              the inventory reads from those bytes and its evidence locators.
            </span>
          </Toolbar>
          {inventory.kind === 'submitting' ? (
            <p className="muted" role="status">
              Submitting inventory…
            </p>
          ) : null}
          {inventory.kind === 'tracking' ? (
            <div className="row" role="status">
              <Badge
                tone={
                  inventory.job.state === 'succeeded'
                    ? 'success'
                    : inventory.job.state === 'failed'
                      ? 'danger'
                      : 'neutral'
                }
              >
                {inventory.job.state}
              </Badge>
              <span className="mono">job {inventory.job.jobId}</span>
              {inventory.job.exitCode === null ? null : (
                <span className="mono">exit {inventory.job.exitCode}</span>
              )}
              {inventoryActive ? (
                <span className="muted">
                  Inventory is still running; status refreshes automatically.
                </span>
              ) : null}
            </div>
          ) : null}
          {inventory.kind === 'tracking' && inventory.job.state === 'failed' ? (
            <Callout tone="danger" title="Inventory failed" role="alert">
              The inventory job ended with exit code{' '}
              <code>{inventory.job.exitCode ?? 'unknown'}</code>.
            </Callout>
          ) : null}
          {inventory.kind === 'tracking' && inventory.pollError !== null ? (
            <Callout tone="warning" title="Inventory status unavailable" role="alert">
              <code>{safeInventoryError(inventory.pollError)}</code> The accepted job remains active
              here; status will retry automatically.
            </Callout>
          ) : null}
          {inventory.kind === 'error' ? (
            <Callout tone="danger" title="Inventory could not be started" role="alert">
              <code>{safeInventoryError(inventory.error)}</code>
            </Callout>
          ) : null}
        </Card>
      ) : null}

      <AsyncState
        state={state}
        onRetry={reload}
        skeleton="table"
        errorTitle="Could not read the intake receipt"
      >
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
          value={data.chain.status}
          tone={data.chain.status === 'broken' ? 'danger' : 'default'}
          hint={
            data.chain.status === 'intact'
              ? `Every row hashes and signs to its recorded value; the signed head commits ${formatNumber(data.chain.rows)} rows (key ${data.chain.keyId ?? '—'})`
              : data.chain.status === 'empty'
                ? 'No document has been taken in; an empty receipt proves nothing and is not called intact'
                : `${data.chain.brokenAt === null ? 'Head' : `Row ${formatNumber(data.chain.brokenAt + 1)}`}: ${data.chain.reason ?? 'unknown'}`
          }
        />
        <Stat
          label="Bytes taken in"
          value={formatBytes(data.intake.reduce((sum, row) => sum + row.bytes, 0))}
        />
      </div>

      {data.chain.valid ? null : (
        <Callout tone="danger" title="The intake receipt does not verify" role="alert">
          {data.chain.brokenAt === null
            ? 'The signed head commitment'
            : `Row ${formatNumber(data.chain.brokenAt + 1)}`}{' '}
          failed with <code>{data.chain.reason ?? 'unknown'}</code>. The receipt was changed, cut
          short or re-written after it was committed, so it can no longer stand as a record of what
          arrived. Preserve the files and treat the custody claim for this case as unproven until it
          is explained.
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
